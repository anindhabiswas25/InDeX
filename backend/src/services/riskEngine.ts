/**
 * Risk Engine — Monitors protocol health and auto-pauses if thresholds are breached.
 * No validator monitoring (L2 rollup). Focuses on protocol-level risk metrics.
 */
import { config } from "../config";
import { queryContract, executeContract } from "../chain";
import { eventBus, EventType } from "./eventBus";

function log(msg: string) { console.log(`[risk-engine] ${msg}`); }
function warn(msg: string) { console.warn(`[risk-engine] ${msg}`); }

let riskTimer: NodeJS.Timeout | null = null;
let isPaused = false;

// Thresholds
const MAX_UTILIZATION = 0.95; // 95% utilization → warning
const CRITICAL_UTILIZATION = 0.99; // 99% → pause
const MIN_BUFFER_RATIO = 0.05; // buffer should be >5% of total staked
const MAX_LP_IMBALANCE = 5.0; // LP reserves ratio shouldn't exceed 5:1

export interface RiskMetrics {
  timestamp: number;
  isPaused: boolean;
  lendingUtilization: number;
  bufferRatio: number;
  lpImbalanceRatio: number;
  totalCollateral: string;
  totalDebt: string;
  alerts: string[];
}

export async function assessRisk(): Promise<RiskMetrics> {
  const alerts: string[] = [];
  let lendingUtil = 0;
  let bufferRatio = 1;
  let lpImbalance = 1;
  let totalCollateral = "0";
  let totalDebt = "0";

  try {
    // 1. Check lending utilization
    const lendingPool = await queryContract<any>(config.lendingAddress, { pool_state: {} });
    const supplied = Number(lendingPool.total_supplied || 0);
    const borrowed = Number(lendingPool.total_borrowed || 0);
    totalCollateral = lendingPool.total_supplied || "0";
    totalDebt = lendingPool.total_borrowed || "0";
    lendingUtil = supplied > 0 ? borrowed / supplied : 0;

    if (lendingUtil > CRITICAL_UTILIZATION) {
      alerts.push(`CRITICAL: Lending utilization at ${(lendingUtil * 100).toFixed(1)}%`);
    } else if (lendingUtil > MAX_UTILIZATION) {
      alerts.push(`WARNING: Lending utilization at ${(lendingUtil * 100).toFixed(1)}%`);
    }
  } catch (err: any) {
    alerts.push(`Lending pool query failed: ${err.message}`);
  }

  try {
    // 2. Check staking buffer health
    const stakingPool = await queryContract<any>(config.stakingAddress, { pool_state: {} });
    const totalStaked = Number(stakingPool.total_init_staked || 0);
    const buffer = Number(stakingPool.liquidity_buffer || 0);
    bufferRatio = totalStaked > 0 ? buffer / totalStaked : 1;

    if (bufferRatio < MIN_BUFFER_RATIO && totalStaked > 0) {
      alerts.push(`WARNING: Buffer ratio low at ${(bufferRatio * 100).toFixed(2)}%`);
    }
  } catch (err: any) {
    alerts.push(`Staking pool query failed: ${err.message}`);
  }

  try {
    // 3. Check LP pool balance
    const lpPool = await queryContract<any>(config.lpPoolAddress, { pool_state: {} });
    const initReserve = Number(lpPool.init_reserve || 0);
    const initxReserve = Number(lpPool.initx_reserve || 0);
    lpImbalance = initxReserve > 0 ? initReserve / initxReserve : 1;

    if (lpImbalance > MAX_LP_IMBALANCE || (lpImbalance > 0 && 1 / lpImbalance > MAX_LP_IMBALANCE)) {
      alerts.push(`WARNING: LP pool severely imbalanced (ratio=${lpImbalance.toFixed(2)})`);
    }
  } catch (err: any) {
    alerts.push(`LP pool query failed: ${err.message}`);
  }

  // Auto-pause on critical conditions
  const shouldPause = lendingUtil > CRITICAL_UTILIZATION;

  if (shouldPause && !isPaused) {
    try {
      await executeContract(config.stakingAddress, { pause: {} });
      isPaused = true;
      alerts.push("PROTOCOL PAUSED due to critical risk");
      eventBus.publish(EventType.PROTOCOL_PAUSED, { reason: alerts.join("; ") });
      log("PROTOCOL PAUSED");
      await sendAlert(alerts);
    } catch (err: any) {
      warn(`Failed to pause: ${err.message}`);
    }
  } else if (!shouldPause && isPaused) {
    try {
      await executeContract(config.stakingAddress, { unpause: {} });
      isPaused = false;
      alerts.push("Protocol UNPAUSED — risk resolved");
      eventBus.publish(EventType.PROTOCOL_UNPAUSED, {});
      log("Protocol UNPAUSED");
    } catch (err: any) {
      warn(`Failed to unpause: ${err.message}`);
    }
  }

  if (alerts.length > 0) {
    log(`Alerts: ${alerts.join(" | ")}`);
    eventBus.publish(EventType.RISK_ALERT, { alerts });
  }

  return {
    timestamp: Date.now(),
    isPaused,
    lendingUtilization: lendingUtil,
    bufferRatio,
    lpImbalanceRatio: lpImbalance,
    totalCollateral,
    totalDebt,
    alerts,
  };
}

async function sendAlert(alerts: string[]): Promise<void> {
  if (!config.alertWebhookUrl) return;
  try {
    await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🚨 INITx Risk Alert\n${alerts.join("\n")}`,
      }),
    });
  } catch (_) {}
}

export function startRiskEngine(): void {
  log(`Starting risk monitoring every ${config.riskIntervalMs / 1000}s`);
  riskTimer = setInterval(() => {
    assessRisk().catch(e => warn(e.message));
  }, config.riskIntervalMs);
}

export function stopRiskEngine(): void {
  if (riskTimer) clearInterval(riskTimer);
  riskTimer = null;
  log("Stopped");
}
