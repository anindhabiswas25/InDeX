/**
 * Metrics Cron — Periodically collects and stores protocol-wide metrics.
 * Queries all contracts + CoinGecko price. Stores to MongoDB.
 */
import { config } from "../config";
import { queryContract } from "../chain";
import { metrics as metricsCollection, MetricsDoc } from "../mongo";
import { fetchInitPrice } from "./priceFeed";

function log(msg: string) { console.log(`[metrics] ${msg}`); }
function warn(msg: string) { console.warn(`[metrics] ${msg}`); }

let metricsTimer: NodeJS.Timeout | null = null;

interface LendingPoolState {
  total_supplied: string;
  total_borrowed: string;
  borrow_index: string;
  accrued_protocol_fees: string;
}

interface LpPoolState {
  init_reserve: string;
  initx_reserve: string;
  total_lp_shares: string;
}

export async function collectMetrics(): Promise<MetricsDoc | null> {
  try {
    const [stakingPool, lendingPool, lpPool, initPrice] = await Promise.allSettled([
      queryContract<any>(config.stakingAddress, { pool_state: {} }),
      queryContract<LendingPoolState>(config.lendingAddress, { pool_state: {} }),
      queryContract<LpPoolState>(config.lpPoolAddress, { pool_state: {} }),
      fetchInitPrice(),
    ]);

    const staked = stakingPool.status === "fulfilled" ? stakingPool.value.total_init_staked || "0" : "0";
    const borrowed = lendingPool.status === "fulfilled" ? lendingPool.value.total_borrowed || "0" : "0";
    const supplied = lendingPool.status === "fulfilled" ? lendingPool.value.total_supplied || "0" : "0";
    const lpInit = lpPool.status === "fulfilled" ? lpPool.value.init_reserve || "0" : "0";
    const lpInitx = lpPool.status === "fulfilled" ? lpPool.value.initx_reserve || "0" : "0";
    const price = initPrice.status === "fulfilled" ? initPrice.value : 0;

    const totalStakedNum = Number(staked) / 1e6; // assuming 6 decimals
    const tvlUsd = totalStakedNum * price;

    const totalBorrowed = Number(borrowed);
    const totalSupplied = Number(supplied);
    const utilizationRate = totalSupplied > 0 ? totalBorrowed / totalSupplied : 0;

    const totalLpLiquidity = (Number(lpInit) + Number(lpInitx)).toString();

    const doc: MetricsDoc = {
      timestamp: Date.now(),
      tvlUsd,
      initPriceUsd: price,
      totalStaked: staked,
      totalBorrowed: borrowed,
      totalLpLiquidity,
      utilizationRate,
      activeProposals: 0, // TODO: query governance
    };

    await metricsCollection().insertOne(doc);
    log(`TVL: $${tvlUsd.toFixed(2)} | INIT: $${price.toFixed(4)} | Util: ${(utilizationRate * 100).toFixed(1)}%`);

    return doc;
  } catch (err: any) {
    warn(`Metrics collection failed: ${err.message}`);
    return null;
  }
}

export function startMetricsCron(): void {
  log("Starting metrics collection every 5 min");
  setTimeout(() => collectMetrics().catch(e => warn(e.message)), 8000);
  metricsTimer = setInterval(() => {
    collectMetrics().catch(e => warn(e.message));
  }, 5 * 60 * 1000);
}

export function stopMetricsCron(): void {
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = null;
  log("Stopped");
}
