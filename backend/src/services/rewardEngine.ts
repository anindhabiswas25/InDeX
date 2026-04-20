/**
 * Reward Engine — Takes periodic snapshots of protocol state and calculates APY.
 * Stores snapshots in MongoDB. No database dependency for core function.
 */
import { config } from "../config";
import { queryContract } from "../chain";
import { snapshots, SnapshotDoc } from "../mongo";
import { eventBus, EventType } from "./eventBus";
import { getExchangeRate } from "./oracleUpdater";

function log(msg: string) { console.log(`[reward-engine] ${msg}`); }
function warn(msg: string) { console.warn(`[reward-engine] ${msg}`); }

let snapshotTimer: NodeJS.Timeout | null = null;

interface StakingPoolState {
  total_init_staked: string;
  total_initx_supply: string;
  liquidity_buffer: string;
  treasury_balance: string;
}

/**
 * Take a snapshot of the current protocol state.
 */
export async function takeSnapshot(): Promise<SnapshotDoc | null> {
  try {
    const [poolState, exchangeRate] = await Promise.all([
      queryContract<StakingPoolState>(config.stakingAddress, { pool_state: {} }),
      getExchangeRate(),
    ]);

    const now = Date.now();

    // Calculate APY from historical snapshots
    const apy7d = await calculateApy(7);
    const apy30d = await calculateApy(30);

    const doc: SnapshotDoc = {
      timestamp: now,
      totalStaked: poolState.total_init_staked,
      totalSupply: poolState.total_initx_supply,
      exchangeRate,
      bufferBalance: poolState.liquidity_buffer || "0",
      treasuryBalance: poolState.treasury_balance || "0",
      apy7d,
      apy30d,
    };

    await snapshots().insertOne(doc);

    log(`Snapshot: rate=${exchangeRate.toFixed(6)} staked=${poolState.total_init_staked} apy7d=${apy7d.toFixed(2)}% apy30d=${apy30d.toFixed(2)}%`);

    eventBus.publish(EventType.REWARD_UPDATED, {
      exchangeRate,
      apy7d,
      apy30d,
      totalStaked: poolState.total_init_staked,
    });

    return doc;
  } catch (err: any) {
    warn(`Snapshot failed: ${err.message}`);
    return null;
  }
}

/**
 * Calculate APY from exchange rate change over N days.
 * APY = ((rate_now / rate_Nd_ago) ^ (365/N) - 1) * 100
 */
export async function calculateApy(days: number): Promise<number> {
  try {
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;

    const oldSnapshot = await snapshots().findOne(
      { timestamp: { $lte: cutoff } },
      { sort: { timestamp: -1 } },
    );

    if (!oldSnapshot) {
      // Not enough history — estimate from rate change since first snapshot
      const firstSnapshot = await snapshots().findOne({}, { sort: { timestamp: 1 } });
      if (!firstSnapshot) return 0;

      const currentRate = await getExchangeRate();
      const elapsed = (now - firstSnapshot.timestamp) / (24 * 60 * 60 * 1000);
      if (elapsed < 0.01) return 0;

      const rateChange = currentRate / firstSnapshot.exchangeRate;
      // Need at least 1 hour of history to produce a meaningful APY
      if (elapsed < 1 / 24) return 0;
      const annualized = Math.pow(rateChange, 365 / elapsed) - 1;
      return Math.min(annualized * 100, 9999);
    }

    const currentRate = await getExchangeRate();
    const rateChange = currentRate / oldSnapshot.exchangeRate;
    const annualized = Math.pow(rateChange, 365 / days) - 1;
    return Math.min(annualized * 100, 9999);
  } catch {
    return 0;
  }
}

/**
 * Get the latest snapshot.
 */
export async function getLatestSnapshot(): Promise<SnapshotDoc | null> {
  return snapshots().findOne({}, { sort: { timestamp: -1 } });
}

/**
 * Get snapshots for a time range.
 */
export async function getSnapshots(fromMs: number, toMs: number): Promise<SnapshotDoc[]> {
  return snapshots()
    .find({ timestamp: { $gte: fromMs, $lte: toMs } })
    .sort({ timestamp: 1 })
    .toArray();
}

export function startRewardEngine(): void {
  log(`Starting snapshots every ${config.snapshotIntervalMs / 1000}s`);
  // Take first snapshot after 5s
  setTimeout(() => takeSnapshot().catch(e => warn(e.message)), 5000);
  snapshotTimer = setInterval(() => {
    takeSnapshot().catch(e => warn(e.message));
  }, config.snapshotIntervalMs);
}

export function stopRewardEngine(): void {
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = null;
  log("Stopped");
}
