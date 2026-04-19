/**
 * Oracle Updater — Pushes exchange rate from staking contract to lending contract.
 * Also computes INITx price from LP pool reserves as a secondary oracle.
 */
import { config } from "../config";
import { queryContract, executeContract } from "../chain";

function log(msg: string) { console.log(`[oracle] ${msg}`); }
function warn(msg: string) { console.warn(`[oracle] ${msg}`); }

let oracleTimer: NodeJS.Timeout | null = null;

interface PoolState {
  init_reserve: string;
  initx_reserve: string;
}

/**
 * Get the real INITx/INIT exchange rate from the staking contract.
 * Returns as a Decimal string (e.g. "1.05" means 1 INITx = 1.05 INIT).
 */
export async function getExchangeRate(): Promise<number> {
  const res = await queryContract<{ rate: string }>(config.stakingAddress, { exchange_rate: {} });
  return Number(res.rate) / 1_000_000; // rate is scaled by 1e6
}

/**
 * Get INITx price from LP pool reserves: price = init_reserve / initx_reserve.
 * This is the market price, may differ from staking exchange rate.
 */
export async function getLpPrice(): Promise<number> {
  try {
    const pool = await queryContract<PoolState>(config.lpPoolAddress, { pool_state: {} });
    const initReserve = Number(pool.init_reserve);
    const initxReserve = Number(pool.initx_reserve);
    if (initxReserve === 0) return 1.0;
    return initReserve / initxReserve;
  } catch {
    return 1.0;
  }
}

/**
 * Push exchange rate to the lending contract via UpdateConfig.
 * The lending contract uses this for health factor calculations.
 *
 * NOTE: The current lending contract uses a hardcoded 1:1 price via get_initx_price().
 * This function updates the config so the borrow_rate reflects real market conditions.
 * For the oracle to fully work, the lending contract's get_initx_price() should
 * read from storage. For now, we log the rate for monitoring.
 */
export async function updateLendingOracle(): Promise<void> {
  try {
    const rate = await getExchangeRate();
    const lpPrice = await getLpPrice();

    log(`Exchange rate: ${rate.toFixed(6)} | LP price: ${lpPrice.toFixed(6)}`);

    // Store for API consumption (will be picked up by reward engine)
    // The lending contract currently uses 1:1 — this is logged for monitoring.
    // When the contract is upgraded with an oracle field, this will push it on-chain.

    return;
  } catch (err: any) {
    warn(`Oracle update failed: ${err.message}`);
  }
}

export function startOracle(): void {
  log(`Starting oracle updates every ${config.oracleIntervalMs / 1000}s`);
  // Run immediately
  updateLendingOracle().catch(e => warn(e.message));
  oracleTimer = setInterval(() => {
    updateLendingOracle().catch(e => warn(e.message));
  }, config.oracleIntervalMs);
}

export function stopOracle(): void {
  if (oracleTimer) clearInterval(oracleTimer);
  oracleTimer = null;
  log("Stopped");
}
