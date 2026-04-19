/**
 * Fee Harvester Service — Real Yield Model
 *
 * Collects protocol fees from lending and LP pool contracts,
 * converts all harvested tokens to INIT, and feeds them into
 * staking via AddRewards to increase the exchange rate.
 *
 * Also sweeps any bridged L1 staking rewards that have arrived
 * in the keeper wallet via IBC into the same AddRewards call.
 *
 * Based on sXLM KeeperBot.runHarvestCycle() architecture.
 */
import { config } from "../config";
import { queryContract, executeContract, getSigningClient } from "../chain";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LendingPoolState {
  total_supply: string;
  total_borrowed: string;
  borrow_rate: string;
  supply_rate: string;
  last_update_time: number;
  accrued_protocol_fees: string;
}

interface LpPoolState {
  init_reserve: string;
  initx_reserve: string;
  total_lp_shares: string;
  accrued_fees_init: string;
  accrued_fees_initx: string;
}

interface SimulateSwapResponse {
  return_amount: string;
  spread_amount: string;
  commission_amount: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[harvester] ${msg}`);
}

function warn(msg: string) {
  console.warn(`[harvester] ${msg}`);
}

function error(msg: string) {
  console.error(`[harvester] ${msg}`);
}

// ---------------------------------------------------------------------------
// Harvest Sources
// ---------------------------------------------------------------------------

/**
 * Collect accrued protocol fees from the lending contract.
 * The lending contract sends fees to the caller (keeper wallet).
 * Returns the amount of INIT harvested.
 */
async function harvestLendingFees(): Promise<bigint> {
  try {
    const state = await queryContract<{ fees: string }>(config.lendingAddress, { accrued_protocol_fees: {} });
    const accruedFees = BigInt(state.fees);

    if (accruedFees === 0n) {
      log("Lending: no accrued fees");
      return 0n;
    }

    log(`Lending: ${accruedFees} accrued protocol fees, collecting...`);
    const res = await executeContract(config.lendingAddress, { collect_protocol_fees: {} });
    log(`Lending: collected, tx: ${res.transactionHash}`);
    return accruedFees;
  } catch (err: any) {
    warn(`Lending harvest failed: ${err.message}`);
    return 0n;
  }
}

/**
 * Collect accrued protocol fees from the LP pool contract.
 * Returns { init, initx } amounts harvested.
 */
async function harvestLpFees(): Promise<{ init: bigint; initx: bigint }> {
  try {
    const state = await queryContract<LpPoolState>(config.lpPoolAddress, { pool_state: {} });
    const initFees = BigInt(state.accrued_fees_init);
    const initxFees = BigInt(state.accrued_fees_initx);

    if (initFees === 0n && initxFees === 0n) {
      log("LP Pool: no accrued fees");
      return { init: 0n, initx: 0n };
    }

    log(`LP Pool: ${initFees} INIT + ${initxFees} INITx accrued fees, collecting...`);
    const res = await executeContract(config.lpPoolAddress, { collect_protocol_fees: {} });
    log(`LP Pool: collected, tx: ${res.transactionHash}`);
    return { init: initFees, initx: initxFees };
  } catch (err: any) {
    warn(`LP Pool harvest failed: ${err.message}`);
    return { init: 0n, initx: 0n };
  }
}

/**
 * Swap INITx → INIT via the LP pool.
 * Returns the amount of INIT received.
 */
async function swapInitxToInit(initxAmount: bigint): Promise<bigint> {
  if (initxAmount === 0n) return 0n;

  try {
    // First simulate the swap to check if it's worth doing
    const sim = await queryContract<{ return_amount: string }>(
      config.lpPoolAddress,
      { estimate_swap: { offer_asset: "cw20_initx", offer_amount: initxAmount.toString() } }
    ).catch(() => null);

    if (sim && BigInt(sim.return_amount) < 10n) {
      warn(`INITx swap would return only ${sim?.return_amount} INIT (pool too imbalanced), skipping`);
      return 0n;
    }

    // Check keeper INIT balance before swap using the shared query client
    const { address: keeperAddr } = await getSigningClient();
    const { client: signingClient } = await getSigningClient();

    const balBefore = await signingClient.getBalance(keeperAddr, config.denom);
    const initBefore = BigInt(balBefore.amount);

    // CW20 Send with swap hook
    const swapMsg = Buffer.from(JSON.stringify({ swap_initx_for_init: {} })).toString("base64");
    log(`Swapping ${initxAmount} INITx → INIT (estimated: ${sim?.return_amount ?? "?"} INIT)...`);
    const res = await executeContract(config.initxTokenAddress, {
      send: {
        contract: config.lpPoolAddress,
        amount: initxAmount.toString(),
        msg: swapMsg,
      },
    });

    // First try parsing events
    let returnAmount = 0n;
    for (const event of res.events) {
      for (const attr of event.attributes) {
        if (attr.key === "return_amount" || attr.key === "amount_out") {
          returnAmount = BigInt(attr.value);
          break;
        }
      }
      if (returnAmount > 0n) break;
    }

    // Fallback: measure balance delta (most reliable)
    if (returnAmount === 0n) {
      const balAfter = await signingClient.getBalance(keeperAddr, config.denom);
      const delta = BigInt(balAfter.amount) - initBefore;
      if (delta > 0n) returnAmount = delta;
    }

    log(`Swapped ${initxAmount} INITx → ${returnAmount} INIT, tx: ${res.transactionHash}`);
    return returnAmount;
  } catch (err: any) {
    warn(`INITx→INIT swap failed: ${err.message}`);
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Main Harvest Cycle
// ---------------------------------------------------------------------------

/**
 * Run a full harvest cycle:
 * 1. Collect lending protocol fees (INIT)
 * 2. Collect LP pool protocol fees (INIT + INITx)
 * 3. Swap any INITx → INIT
 * 4. Check keeper wallet for bridged L1 staking rewards (landed via IBC)
 * 5. Call AddRewards on staking with total harvested INIT
 */
export async function runHarvestCycle(): Promise<void> {
  log("=== Starting harvest cycle ===");

  // 1. Harvest from lending
  const lendingInit = await harvestLendingFees();

  // 2. Harvest from LP pool
  const lpFees = await harvestLpFees();

  // 3. Swap any harvested INITx to INIT
  const swappedInit = await swapInitxToInit(lpFees.initx);

  // 4. Check for bridged L1 staking rewards sitting in keeper wallet
  // IBC transfer lands as config.denom (native uinit on wasm-1).
  // Keep a small operating reserve (500_000 uinit = 0.5 INIT) for gas.
  let bridgedL1Init = 0n;
  try {
    const { address: keeperAddr, client: signingClient } = await getSigningClient();
    const GAS_RESERVE = 500_000n;
    const bal = await signingClient.getBalance(keeperAddr, config.denom);
    const keeperBalance = BigInt(bal.amount);
    if (keeperBalance > GAS_RESERVE) {
      bridgedL1Init = keeperBalance - GAS_RESERVE;
      log(`Bridged L1 rewards detected: ${bridgedL1Init} uinit in keeper wallet (after gas reserve)`);
    }
  } catch (err: any) {
    warn(`Keeper balance check failed: ${err.message}`);
  }

  // 5. Total INIT harvested
  const totalInit = lendingInit + lpFees.init + swappedInit + bridgedL1Init;
  log(`Total harvested: ${totalInit} INIT (lending: ${lendingInit}, lp_init: ${lpFees.init}, swapped: ${swappedInit}, l1_bridged: ${bridgedL1Init})`);

  if (totalInit < BigInt(config.minHarvestThreshold)) {
    log(`Below threshold (${config.minHarvestThreshold}), skipping AddRewards`);
    return;
  }

  // 6. Add rewards to staking
  try {
    const res = await executeContract(
      config.stakingAddress,
      { add_rewards: {} },
      [{ denom: config.denom, amount: totalInit.toString() }],
    );
    log(`AddRewards: ${totalInit} INIT, tx: ${res.transactionHash}`);
  } catch (err: any) {
    error(`MANUAL ACTION REQUIRED: AddRewards failed with ${totalInit} INIT: ${err.message}`);
  }

  log("=== Harvest cycle complete ===");
}

/**
 * Recycle treasury fees: withdraw staking treasury fees and feed back via AddRewards.
 * Only the treasury address (= keeper) can call WithdrawFees.
 */
export async function recycleTreasury(): Promise<void> {
  log("=== Recycling treasury ===");
  try {
    // Query staking treasury balance (separate query endpoint)
    const state = await queryContract<{ treasury_balance: string }>(config.stakingAddress, { treasury_balance: {} });
    const treasuryBalance = BigInt(state.treasury_balance);

    if (treasuryBalance < BigInt(config.minHarvestThreshold)) {
      log(`Treasury balance ${treasuryBalance} below threshold, skipping`);
      return;
    }

    // Withdraw treasury fees (keeper is treasury)
    log(`Withdrawing ${treasuryBalance} from treasury...`);
    const withdrawRes = await executeContract(config.stakingAddress, { withdraw_fees: {} });
    log(`Treasury withdrawn, tx: ${withdrawRes.transactionHash}`);

    // Feed back via AddRewards
    const res = await executeContract(
      config.stakingAddress,
      { add_rewards: {} },
      [{ denom: config.denom, amount: treasuryBalance.toString() }],
    );
    log(`Treasury recycled: ${treasuryBalance} INIT → AddRewards, tx: ${res.transactionHash}`);
  } catch (err: any) {
    warn(`Treasury recycle failed: ${err.message}`);
  }
}
