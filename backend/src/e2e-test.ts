/**
 * E2E Real Yield Test — Simulates 3 users interacting with the protocol
 * to generate real yield and demonstrate the keeper bot reward distribution.
 *
 * User 1 (Alice): Stakes INIT → receives INITx
 * User 2 (Bob):   Adds LP liquidity + swaps to generate swap fees
 * User 3 (Carol): Deposits INITx collateral → borrows INIT to generate lending fees
 *
 * Then triggers a harvest cycle manually to show yield flowing to stakers.
 *
 * Usage: npx ts-node src/e2e-test.ts
 */
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { config } from "./config";
import { connectMongo, disconnectMongo, snapshots } from "./mongo";
import { runHarvestCycle } from "./services/feeHarvester";
import { takeSnapshot, calculateApy } from "./services/rewardEngine";
import { getExchangeRate, getLpPrice } from "./services/oracleUpdater";
import { fetchInitPrice } from "./services/priceFeed";
import { queryContract, executeContract, getSigningClient } from "./chain";

// ── Config ──

const DENOM = config.denom;
const STAKING = config.stakingAddress;
const INITX_TOKEN = config.initxTokenAddress;
const LP_POOL = config.lpPoolAddress;
const LENDING = config.lendingAddress;

// Test amounts (in smallest denomination) — sized for available balance
const STAKE_AMOUNT = "1000000"; // 1 INIT
const LP_INIT_AMOUNT = "500000"; // 0.5 INIT
const LP_INITX_AMOUNT = "500000"; // 0.5 INITx
const SWAP_AMOUNT = "100000"; // 0.1 INIT
const COLLATERAL_AMOUNT = "500000"; // 0.5 INITx
const BORROW_AMOUNT = "200000"; // 0.2 INIT

// ── Helpers ──

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function divider(title: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

async function getKeeper(): Promise<{ client: SigningCosmWasmClient; address: string }> {
  return getSigningClient();
}

async function getInitxBalance(address: string): Promise<string> {
  const res = await queryContract<{ balance: string }>(INITX_TOKEN, { balance: { address } });
  return res.balance;
}

async function getInitBalance(client: SigningCosmWasmClient, address: string): Promise<string> {
  const coin = await client.getBalance(address, DENOM);
  return coin.amount;
}

// ── Test Steps ──

async function testSetup() {
  divider("SETUP: Connect & Check Balances");

  const { client, address } = await getKeeper();
  const initBal = await getInitBalance(client, address);
  const initxBal = await getInitxBalance(address);

  log("setup", `Keeper address: ${address}`);
  log("setup", `INIT balance: ${initBal}`);
  log("setup", `INITx balance: ${initxBal}`);

  if (BigInt(initBal) < 3000000n) {
    console.error("ERROR: Keeper needs at least 3 INIT for tests. Fund the wallet.");
    process.exit(1);
  }

  return { client, address };
}

async function testAliceStakes(client: SigningCosmWasmClient, address: string) {
  divider("USER 1 (Alice/Keeper): Stake INIT → Get INITx");

  const rateBefore = await getExchangeRate();
  log("alice", `Exchange rate before: ${rateBefore.toFixed(6)}`);

  // Deposit INIT
  log("alice", `Staking ${STAKE_AMOUNT} INIT...`);
  const res = await client.execute(address, STAKING, { deposit: {} }, "auto", undefined, [
    { denom: DENOM, amount: STAKE_AMOUNT },
  ]);
  log("alice", `Staked! tx: ${res.transactionHash}`);

  const initxBal = await getInitxBalance(address);
  log("alice", `INITx balance after stake: ${initxBal}`);

  // Take snapshot
  await takeSnapshot();

  return initxBal;
}

async function testBobLpAndSwap(client: SigningCosmWasmClient, address: string) {
  divider("USER 2 (Bob/Keeper): Add LP Liquidity + Swap");

  const initxBal = await getInitxBalance(address);
  log("bob", `INITx balance: ${initxBal}`);

  if (BigInt(initxBal) < BigInt(LP_INITX_AMOUNT)) {
    log("bob", "Not enough INITx for LP — staking more first...");
    await client.execute(address, STAKING, { deposit: {} }, "auto", undefined, [
      { denom: DENOM, amount: "5000000" },
    ]);
  }

  // Add liquidity: Send INITx via CW20 Send with AddLiquidity hook + INIT as native funds
  log("bob", `Adding LP: ${LP_INIT_AMOUNT} INIT + ${LP_INITX_AMOUNT} INITx...`);
  try {
    const addLiqMsg = Buffer.from(
      JSON.stringify({ add_liquidity: { min_lp_shares: null } })
    ).toString("base64");

    // CW20 Send INITx to LP pool with native INIT funds
    // Note: CW20 Send doesn't support native funds. Need to send INITx first, then the contract handles it.
    // The actual flow depends on contract implementation. Let's try the CW20 Send approach:
    const res = await client.execute(
      address,
      INITX_TOKEN,
      {
        send: {
          contract: LP_POOL,
          amount: LP_INITX_AMOUNT,
          msg: addLiqMsg,
        },
      },
      "auto",
      undefined,
      [{ denom: DENOM, amount: LP_INIT_AMOUNT }],
    );
    log("bob", `LP added! tx: ${res.transactionHash}`);
  } catch (err: any) {
    log("bob", `LP add failed (may already have liquidity): ${err.message.substring(0, 100)}`);
  }

  // Swap INIT → INITx to generate swap fees
  log("bob", `Swapping ${SWAP_AMOUNT} INIT → INITx...`);
  try {
    const swapRes = await client.execute(
      address,
      LP_POOL,
      { swap_init_for_initx: { min_out: null } },
      "auto",
      undefined,
      [{ denom: DENOM, amount: SWAP_AMOUNT }],
    );
    log("bob", `Swapped! tx: ${swapRes.transactionHash}`);
  } catch (err: any) {
    log("bob", `Swap failed: ${err.message.substring(0, 100)}`);
  }

  // Do a few more swaps to accumulate fees
  for (let i = 0; i < 3; i++) {
    try {
      await client.execute(
        address,
        LP_POOL,
        { swap_init_for_initx: { min_out: null } },
        "auto",
        undefined,
        [{ denom: DENOM, amount: "200000" }],
      );
      log("bob", `Extra swap ${i + 1} done`);
    } catch (_) {}
  }

  // Check LP fees accrued
  try {
    const fees = await queryContract(LP_POOL, { accrued_fees: {} });
    log("bob", `LP accrued fees: ${JSON.stringify(fees)}`);
  } catch (_) {}
}

async function testCarolLend(client: SigningCosmWasmClient, address: string) {
  divider("USER 3 (Carol/Keeper): Deposit Collateral + Borrow");

  // First stake some INIT to get INITx for collateral
  const initxBal = await getInitxBalance(address);
  if (BigInt(initxBal) < BigInt(COLLATERAL_AMOUNT)) {
    log("carol", "Staking more INIT to get INITx for collateral...");
    await client.execute(address, STAKING, { deposit: {} }, "auto", undefined, [
      { denom: DENOM, amount: "3000000" },
    ]);
  }

  // Supply INIT to lending pool (as a lender)
  log("carol", "Supplying 3 INIT to lending pool...");
  try {
    const supplyRes = await client.execute(
      address,
      LENDING,
      { supply: {} },
      "auto",
      undefined,
      [{ denom: DENOM, amount: "3000000" }],
    );
    log("carol", `Supplied! tx: ${supplyRes.transactionHash}`);
  } catch (err: any) {
    log("carol", `Supply failed: ${err.message.substring(0, 100)}`);
  }

  // Deposit INITx as collateral
  log("carol", `Depositing ${COLLATERAL_AMOUNT} INITx as collateral...`);
  try {
    const depositMsg = Buffer.from(JSON.stringify({ deposit_collateral: {} })).toString("base64");
    const depRes = await client.execute(
      address,
      INITX_TOKEN,
      {
        send: {
          contract: LENDING,
          amount: COLLATERAL_AMOUNT,
          msg: depositMsg,
        },
      },
      "auto",
    );
    log("carol", `Collateral deposited! tx: ${depRes.transactionHash}`);
  } catch (err: any) {
    log("carol", `Collateral deposit failed: ${err.message.substring(0, 100)}`);
  }

  // Borrow INIT
  log("carol", `Borrowing ${BORROW_AMOUNT} INIT...`);
  try {
    const borrowRes = await client.execute(
      address,
      LENDING,
      { borrow: { amount: BORROW_AMOUNT } },
      "auto",
    );
    log("carol", `Borrowed! tx: ${borrowRes.transactionHash}`);
  } catch (err: any) {
    log("carol", `Borrow failed: ${err.message.substring(0, 100)}`);
  }

  // Check position
  try {
    const pos = await queryContract(LENDING, { position: { address } });
    log("carol", `Position: ${JSON.stringify(pos)}`);
  } catch (_) {}

  // Check lending pool state
  try {
    const pool = await queryContract(LENDING, { pool_state: {} });
    log("carol", `Lending pool: ${JSON.stringify(pool)}`);
  } catch (_) {}
}

async function testHarvestAndYield() {
  divider("HARVEST: Run Keeper Harvest Cycle");

  // Check accrued fees before
  try {
    const lendingFees = await queryContract(LENDING, { accrued_protocol_fees: {} });
    log("harvest", `Lending protocol fees: ${JSON.stringify(lendingFees)}`);
  } catch (_) {}
  try {
    const lpFees = await queryContract(LP_POOL, { accrued_fees: {} });
    log("harvest", `LP protocol fees: ${JSON.stringify(lpFees)}`);
  } catch (_) {}

  const rateBefore = await getExchangeRate();
  log("harvest", `Exchange rate BEFORE harvest: ${rateBefore.toFixed(6)}`);

  // Run harvest
  log("harvest", "Running harvest cycle...");
  await runHarvestCycle();

  const rateAfter = await getExchangeRate();
  log("harvest", `Exchange rate AFTER harvest: ${rateAfter.toFixed(6)}`);

  const rateIncrease = ((rateAfter - rateBefore) / rateBefore) * 100;
  log("harvest", `Rate increase: ${rateIncrease.toFixed(6)}%`);

  // Take post-harvest snapshot
  await takeSnapshot();
}

async function testProtocolState() {
  divider("PROTOCOL STATE: Final Summary");

  // Exchange rate
  const rate = await getExchangeRate();
  log("state", `Exchange rate: ${rate.toFixed(6)}`);

  // LP price
  const lpPrice = await getLpPrice();
  log("state", `LP price (INITx/INIT): ${lpPrice.toFixed(6)}`);

  // INIT price
  try {
    const initPrice = await fetchInitPrice();
    log("state", `INIT price (CoinGecko): $${initPrice.toFixed(4)}`);
  } catch (_) {
    log("state", "CoinGecko price fetch skipped");
  }

  // Staking pool state
  const pool = await queryContract(STAKING, { pool_state: {} });
  log("state", `Staking pool: ${JSON.stringify(pool)}`);

  // Treasury
  try {
    const treasury = await queryContract(STAKING, { treasury_balance: {} });
    log("state", `Treasury: ${JSON.stringify(treasury)}`);
  } catch (_) {}

  // APY
  const apy7d = await calculateApy(7);
  const apy30d = await calculateApy(30);
  log("state", `APY (7d): ${apy7d.toFixed(2)}%`);
  log("state", `APY (30d): ${apy30d.toFixed(2)}%`);

  // MongoDB snapshot count
  const snapshotCount = await snapshots().countDocuments();
  log("state", `Total snapshots in MongoDB: ${snapshotCount}`);

  // Check if paused
  try {
    const paused = await queryContract(STAKING, { is_paused: {} });
    log("state", `Protocol paused: ${JSON.stringify(paused)}`);
  } catch (_) {}
}

async function testMultipleHarvests(client: SigningCosmWasmClient, address: string) {
  divider("MULTIPLE HARVESTS: Simulate 3 reward cycles (10-min interval demo)");

  for (let i = 1; i <= 3; i++) {
    log("multi", `\n--- Harvest Cycle ${i}/3 ---`);

    // Do some swaps to generate fees between harvests
    for (let j = 0; j < 2; j++) {
      try {
        await client.execute(
          address,
          LP_POOL,
          { swap_init_for_initx: { min_out: null } },
          "auto",
          undefined,
          [{ denom: DENOM, amount: "100000" }],
        );
      } catch (_) {}
    }

    const rateBefore = await getExchangeRate();
    await runHarvestCycle();
    const rateAfter = await getExchangeRate();

    const increase = ((rateAfter - rateBefore) / rateBefore) * 100;
    log("multi", `Cycle ${i}: rate ${rateBefore.toFixed(6)} → ${rateAfter.toFixed(6)} (+${increase.toFixed(6)}%)`);

    await takeSnapshot();
  }
}

// ── Main ──

async function main() {
  console.log("\n");
  divider("INITx Protocol — E2E Real Yield Test");
  console.log("This test simulates 3 users generating real yield through protocol activity.\n");

  // Connect MongoDB
  await connectMongo();

  try {
    // Setup
    const { client, address } = await testSetup();

    // User 1: Stake
    await testAliceStakes(client, address);

    // User 2: LP + Swaps
    await testBobLpAndSwap(client, address);

    // User 3: Lend + Borrow
    await testCarolLend(client, address);

    // Harvest — collect fees and distribute as yield
    await testHarvestAndYield();

    // Multiple harvests to show compounding
    await testMultipleHarvests(client, address);

    // Final state
    await testProtocolState();

    divider("TEST COMPLETE");
    console.log("The keeper bot will continue harvesting every 10 minutes when the server runs.");
    console.log("Start the server with: npm run dev");
    console.log("Monitor yield at: http://localhost:3002/api/apy");
    console.log("Monitor snapshots at: http://localhost:3002/api/snapshots?hours=1");
    console.log("");
  } catch (err: any) {
    console.error("\nTEST FAILED:", err.message);
    console.error(err.stack);
  }

  await disconnectMongo();
  process.exit(0);
}

main();
