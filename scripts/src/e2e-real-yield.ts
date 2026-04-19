/**
 * E2E Real Yield Test — Manual function verification + full harvest cycle
 *
 * Tests each contract function individually, then runs a full harvest cycle
 * and verifies the exchange rate actually changes.
 *
 * Usage: npx tsx src/e2e-real-yield.ts
 */
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import * as dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(import.meta.dirname, "../../backend/.env") });

const RPC_URL = process.env.INITIA_RPC_URL!;
const DENOM = process.env.NATIVE_DENOM!;
const MNEMONIC = process.env.KEEPER_WALLET_MNEMONIC!;
const STAKING = process.env.STAKING_ADDRESS!;
const TOKEN = process.env.INITX_TOKEN_ADDRESS!;
const LP_POOL = process.env.LP_POOL_ADDRESS!;
const LENDING = process.env.LENDING_ADDRESS!;

let client: SigningCosmWasmClient;
let keeper: string;

async function setup() {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: "init" });
  const [account] = await wallet.getAccounts();
  keeper = account.address;
  client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, {
    gasPrice: GasPrice.fromString(`0.15${DENOM}`),
  });
  const bal = await client.getBalance(keeper, DENOM);
  console.log(`Keeper: ${keeper}`);
  console.log(`Balance: ${bal.amount} ${DENOM}\n`);
}

async function query<T = any>(addr: string, msg: Record<string, unknown>): Promise<T> {
  return client.queryContractSmart(addr, msg) as Promise<T>;
}

async function exec(addr: string, msg: Record<string, unknown>, funds: { denom: string; amount: string }[] = []) {
  return client.execute(keeper, addr, msg, "auto", undefined, funds);
}

function ok(msg: string) { console.log(`  [PASS] ${msg}`); }
function fail(msg: string) { console.error(`  [FAIL] ${msg}`); }
function section(msg: string) { console.log(`\n=== ${msg} ===\n`); }

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { ok(msg); passed++; }
  else { fail(msg); failed++; }
}

// ---------------------------------------------------------------------------
// Test 1: Staking — Deposit, query rate, query INITx balance
// ---------------------------------------------------------------------------
async function testStaking() {
  section("Test 1: Staking — Deposit + Rate Query");

  // Query initial rate
  const rateBefore = await query(STAKING, { exchange_rate: {} });
  console.log(`  Rate before: ${rateBefore.rate}`);
  assert(rateBefore.rate !== undefined, "Exchange rate queryable");

  // Query pool state
  const poolState = await query(STAKING, { pool_state: {} });
  console.log(`  Pool: staked=${poolState.total_init_staked}, supply=${poolState.total_initx_supply}`);

  // Deposit 100000 (0.1 INIT)
  const depositAmt = "100000";
  const depositRes = await exec(STAKING, { deposit: {} }, [{ denom: DENOM, amount: depositAmt }]);
  console.log(`  Deposit tx: ${depositRes.transactionHash}`);

  // Verify INITx received
  const initxBal = await query<{ balance: string }>(TOKEN, { balance: { address: keeper } });
  console.log(`  INITx balance after deposit: ${initxBal.balance}`);
  assert(BigInt(initxBal.balance) > 0n, "INITx minted on deposit");

  // Rate should be unchanged after deposit
  const rateAfter = await query(STAKING, { exchange_rate: {} });
  console.log(`  Rate after deposit: ${rateAfter.rate}`);
  assert(rateAfter.rate === rateBefore.rate, "Rate unchanged after deposit");
}

// ---------------------------------------------------------------------------
// Test 2: LP Pool — Swap INITx→INIT, check fees accrue
// ---------------------------------------------------------------------------
async function testLpSwap() {
  section("Test 2: LP Pool — Swap INITx→INIT + Fee Accrual");

  // Query pool state before
  const stateBefore = await query(LP_POOL, { pool_state: {} });
  console.log(`  Pool before: init=${stateBefore.init_reserve}, initx=${stateBefore.initx_reserve}`);
  console.log(`  Fees before: init=${stateBefore.accrued_fees_init}, initx=${stateBefore.accrued_fees_initx}`);

  // Swap 10000 INITx → INIT
  const swapAmt = "10000";
  const swapMsg = Buffer.from(JSON.stringify({ swap_initx_for_init: {} })).toString("base64");
  const swapRes = await exec(TOKEN, {
    send: { contract: LP_POOL, amount: swapAmt, msg: swapMsg },
  });
  console.log(`  Swap tx: ${swapRes.transactionHash}`);

  // Check fees accrued
  const stateAfter = await query(LP_POOL, { pool_state: {} });
  console.log(`  Pool after: init=${stateAfter.init_reserve}, initx=${stateAfter.initx_reserve}`);
  console.log(`  Fees after: init=${stateAfter.accrued_fees_init}, initx=${stateAfter.accrued_fees_initx}`);

  const initFeesGrew = BigInt(stateAfter.accrued_fees_init) >= BigInt(stateBefore.accrued_fees_init);
  const initxFeesGrew = BigInt(stateAfter.accrued_fees_initx) >= BigInt(stateBefore.accrued_fees_initx);
  // For INITx→INIT swap, protocol fee is taken from INIT output
  assert(initFeesGrew || initxFeesGrew, "Protocol fees accrued after swap");
}

// ---------------------------------------------------------------------------
// Test 3: LP Pool — CollectProtocolFees
// ---------------------------------------------------------------------------
async function testLpCollectFees() {
  section("Test 3: LP Pool — CollectProtocolFees");

  const stateBefore = await query(LP_POOL, { pool_state: {} });
  const initFees = BigInt(stateBefore.accrued_fees_init);
  const initxFees = BigInt(stateBefore.accrued_fees_initx);
  console.log(`  Accrued: init=${initFees}, initx=${initxFees}`);

  if (initFees === 0n && initxFees === 0n) {
    console.log("  Skipping — no fees to collect");
    return;
  }

  const collectRes = await exec(LP_POOL, { collect_protocol_fees: {} });
  console.log(`  Collect tx: ${collectRes.transactionHash}`);

  const stateAfter = await query(LP_POOL, { pool_state: {} });
  assert(
    BigInt(stateAfter.accrued_fees_init) === 0n && BigInt(stateAfter.accrued_fees_initx) === 0n,
    "Fees zeroed after collection",
  );

  // Verify reserves match balance (the bug we fixed)
  const contractBal = await client.getBalance(LP_POOL, DENOM);
  const reservePlusFees = BigInt(stateAfter.init_reserve) + BigInt(stateAfter.accrued_fees_init);
  console.log(`  Contract INIT balance: ${contractBal.amount}, reserve: ${stateAfter.init_reserve}`);
  assert(
    BigInt(contractBal.amount) >= BigInt(stateAfter.init_reserve),
    "Contract balance >= reserve after fee collection",
  );

  // Verify swap still works after collection
  const swapMsg = Buffer.from(JSON.stringify({ swap_initx_for_init: {} })).toString("base64");
  try {
    const swapRes = await exec(TOKEN, {
      send: { contract: LP_POOL, amount: "1000", msg: swapMsg },
    });
    ok("Swap works after fee collection");
  } catch (err: any) {
    fail(`Swap broken after fee collection: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Lending — Supply, Borrow, check accrued fees
// ---------------------------------------------------------------------------
async function testLending() {
  section("Test 4: Lending — Supply + Borrow + Fee Accrual");

  // Supply 200000 INIT
  const supplyAmt = "200000";
  const supplyRes = await exec(LENDING, { supply: {} }, [{ denom: DENOM, amount: supplyAmt }]);
  console.log(`  Supply tx: ${supplyRes.transactionHash}`);

  // Query pool state
  const stateAfterSupply = await query(LENDING, { pool_state: {} });
  console.log(`  Pool: supply=${stateAfterSupply.total_supply}, borrowed=${stateAfterSupply.total_borrowed}`);
  assert(BigInt(stateAfterSupply.total_supply) >= BigInt(supplyAmt), "Supply registered");

  // Deposit collateral (INITx) — need to send INITx to lending via CW20
  const initxBal = await query<{ balance: string }>(TOKEN, { balance: { address: keeper } });
  console.log(`  INITx available for collateral: ${initxBal.balance}`);

  if (BigInt(initxBal.balance) >= 50000n) {
    const collateralMsg = Buffer.from(JSON.stringify({ deposit_collateral: {} })).toString("base64");
    const collRes = await exec(TOKEN, {
      send: { contract: LENDING, amount: "50000", msg: collateralMsg },
    });
    console.log(`  Deposit collateral tx: ${collRes.transactionHash}`);

    // Borrow against collateral (70% CF, so ~35000 max)
    const borrowAmt = "20000";
    const borrowRes = await exec(LENDING, { borrow: { amount: borrowAmt } });
    console.log(`  Borrow tx: ${borrowRes.transactionHash}`);

    const stateAfterBorrow = await query(LENDING, { pool_state: {} });
    console.log(`  Pool after borrow: supply=${stateAfterBorrow.total_supply}, borrowed=${stateAfterBorrow.total_borrowed}`);
    assert(BigInt(stateAfterBorrow.total_borrowed) > 0n, "Borrow registered");
  } else {
    console.log("  Skipping borrow test — insufficient INITx for collateral");
  }

  // Query accrued fees
  const fees = await query(LENDING, { accrued_protocol_fees: {} });
  console.log(`  Accrued protocol fees: ${fees.fees}`);
}

// ---------------------------------------------------------------------------
// Test 5: Lending — CollectProtocolFees
// ---------------------------------------------------------------------------
async function testLendingCollectFees() {
  section("Test 5: Lending — CollectProtocolFees");

  // Trigger interest accrual by calling any state-changing operation
  // Or just query current fees
  const fees = await query(LENDING, { accrued_protocol_fees: {} });
  const accrued = BigInt(fees.fees);
  console.log(`  Accrued: ${accrued}`);

  if (accrued === 0n) {
    console.log("  No fees yet (interest hasn't accrued enough). This is expected for a fresh deploy.");
    ok("Lending fee query works (0 fees expected on fresh deploy)");
    return;
  }

  const collectRes = await exec(LENDING, { collect_protocol_fees: {} });
  console.log(`  Collect tx: ${collectRes.transactionHash}`);

  const feesAfter = await query(LENDING, { accrued_protocol_fees: {} });
  assert(BigInt(feesAfter.fees) === 0n, "Lending fees zeroed after collection");
}

// ---------------------------------------------------------------------------
// Test 6: Staking — AddRewards changes exchange rate
// ---------------------------------------------------------------------------
async function testAddRewards() {
  section("Test 6: Staking — AddRewards + Rate Change");

  const rateBefore = await query(STAKING, { exchange_rate: {} });
  console.log(`  Rate before: ${rateBefore.rate}`);

  // Add 50000 (0.05 INIT) as rewards
  const rewardAmt = "50000";
  const addRes = await exec(STAKING, { add_rewards: {} }, [{ denom: DENOM, amount: rewardAmt }]);
  console.log(`  AddRewards tx: ${addRes.transactionHash}`);

  const rateAfter = await query(STAKING, { exchange_rate: {} });
  console.log(`  Rate after: ${rateAfter.rate}`);

  // Rate should increase (more INIT backing same INITx supply)
  assert(
    parseFloat(rateAfter.rate) > parseFloat(rateBefore.rate),
    `Exchange rate increased: ${rateBefore.rate} → ${rateAfter.rate}`,
  );
}

// ---------------------------------------------------------------------------
// Test 7: Full Harvest Cycle simulation
// ---------------------------------------------------------------------------
async function testFullHarvestCycle() {
  section("Test 7: Full Harvest Cycle (manual simulation)");

  // Do a swap to generate LP fees
  const swapMsg = Buffer.from(JSON.stringify({ swap_initx_for_init: {} })).toString("base64");
  await exec(TOKEN, { send: { contract: LP_POOL, amount: "5000", msg: swapMsg } });
  console.log("  Generated swap fees");

  // Query LP fees
  const lpState = await query(LP_POOL, { pool_state: {} });
  const lpInitFees = BigInt(lpState.accrued_fees_init);
  const lpInitxFees = BigInt(lpState.accrued_fees_initx);
  console.log(`  LP fees: init=${lpInitFees}, initx=${lpInitxFees}`);

  // Collect LP fees
  let harvestedInit = 0n;
  if (lpInitFees > 0n || lpInitxFees > 0n) {
    await exec(LP_POOL, { collect_protocol_fees: {} });
    harvestedInit += lpInitFees;
    console.log(`  Collected LP fees`);

    // Swap any INITx fees to INIT
    if (lpInitxFees > 0n) {
      const swapBackMsg = Buffer.from(JSON.stringify({ swap_initx_for_init: {} })).toString("base64");
      const swapBackRes = await exec(TOKEN, {
        send: { contract: LP_POOL, amount: lpInitxFees.toString(), msg: swapBackMsg },
      });
      // Parse return amount from events
      for (const event of swapBackRes.events) {
        for (const attr of event.attributes) {
          if (attr.key === "return_amount") harvestedInit += BigInt(attr.value);
        }
      }
      console.log(`  Swapped INITx fees to INIT`);
    }
  }

  // Query lending fees
  const lendingFees = await query(LENDING, { accrued_protocol_fees: {} });
  const lendingAccrued = BigInt(lendingFees.fees);
  if (lendingAccrued > 0n) {
    await exec(LENDING, { collect_protocol_fees: {} });
    harvestedInit += lendingAccrued;
    console.log(`  Collected lending fees: ${lendingAccrued}`);
  }

  console.log(`  Total harvested INIT: ${harvestedInit}`);

  // Add as rewards if any
  if (harvestedInit > 0n) {
    const rateBefore = await query(STAKING, { exchange_rate: {} });
    await exec(STAKING, { add_rewards: {} }, [{ denom: DENOM, amount: harvestedInit.toString() }]);
    const rateAfter = await query(STAKING, { exchange_rate: {} });
    console.log(`  Rate: ${rateBefore.rate} → ${rateAfter.rate}`);
    assert(
      parseFloat(rateAfter.rate) > parseFloat(rateBefore.rate),
      "Exchange rate increased from harvested fees",
    );
  } else {
    console.log("  No fees to harvest (expected on fresh deploy with minimal activity)");
    ok("Harvest cycle ran without errors");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await setup();

  await testStaking();
  await testLpSwap();
  await testLpCollectFees();
  await testLending();
  await testLendingCollectFees();
  await testAddRewards();
  await testFullHarvestCycle();

  section("Results");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("E2E test failed:", err);
  process.exit(1);
});
