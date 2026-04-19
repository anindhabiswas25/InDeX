/**
 * Keeper Bot — Real Yield Model (Production)
 *
 * Runs periodic harvest cycles every 10 minutes to collect protocol fees
 * and feed them into staking as real yield.
 * Also manages: oracle updates, treasury recycling, metrics, liquidation scanning.
 */
import { config } from "./config";
import { executeContract } from "./chain";
import { runHarvestCycle, recycleTreasury } from "./services/feeHarvester";
import { startOracle, stopOracle } from "./services/oracleUpdater";
import { startRewardEngine, stopRewardEngine, takeSnapshot } from "./services/rewardEngine";
import { startMetricsCron, stopMetricsCron } from "./services/metricsCron";
import { startLiquidationBot, stopLiquidationBot } from "./services/liquidationBot";
import { startRiskEngine, stopRiskEngine } from "./services/riskEngine";
import { startEventListener, stopEventListener } from "./services/eventListener";
import { startWithdrawalMonitor, stopWithdrawalMonitor } from "./services/withdrawalMonitor";
import { eventBus, EventType } from "./services/eventBus";
import {
  delegateSurplusOnL1,
  harvestL1Rewards,
  getKeeperL1Address,
} from "./services/l1StakingHarvester";
import { getSigningClient } from "./chain";

let harvestTimer: NodeJS.Timeout | null = null;
let recycleTimer: NodeJS.Timeout | null = null;

// ── Event Bus Logger ──

function setupEventLogging() {
  eventBus.subscribeAll((payload) => {
    console.log(`[event-bus] ${payload.type} — ${JSON.stringify(payload.data).substring(0, 200)}`);
  });
}

// ── Harvest Cycle ──

async function harvestCycle() {
  try {
    await runHarvestCycle();
    // Also recycle treasury on every harvest — feeds protocol fees back as yield
    await recycleTreasury();
    // Take a snapshot after each harvest to track rate changes
    await takeSnapshot();
  } catch (err: any) {
    console.error("[keeper] Harvest cycle error:", err.message);
  }

  // L1 staking harvest: claim rewards on initiation-2 and bridge back to wasm-1
  if (config.l1StakingEnabled) {
    try {
      // We need the keeper's wasm-1 address to bridge rewards back
      const { address: keeperWasm1Address } = await getSigningClient();
      await harvestL1Rewards(keeperWasm1Address);
    } catch (err: any) {
      console.error("[keeper] L1 harvest error:", err.message);
    }
  }
}

async function recycleCycle() {
  try {
    await recycleTreasury();
  } catch (err: any) {
    console.error("[keeper] Treasury recycle error:", err.message);
  }

  // Recalibrate rate
  try {
    if (config.stakingAddress) {
      const res = await executeContract(config.stakingAddress, { recalibrate_rate: {} });
      console.log(`[keeper] recalibrate_rate tx: ${res.transactionHash}`);
    }
  } catch (err: any) {
    console.warn("[keeper] recalibrate_rate failed:", err.message);
  }
}

// ── Public API ──

export function startKeeper() {
  if (!config.keeperMnemonic) {
    console.warn("[keeper] No mnemonic configured, keeper disabled");
    return;
  }
  if (!config.harvestEnabled) {
    console.warn("[keeper] Harvest disabled via config");
    return;
  }

  console.log(`[keeper] Starting — harvest every ${config.keeperIntervalMs / 60000} min`);

  // Setup event logging
  setupEventLogging();

  // Stagger service starts to avoid simultaneous RPC bursts (429 rate limiting)
  // Each service starts 8s apart so they don't all query at the same time
  setTimeout(() => startOracle(),           0);
  setTimeout(() => startRewardEngine(),     8_000);
  setTimeout(() => startMetricsCron(),     16_000);
  setTimeout(() => startLiquidationBot(),  24_000);
  setTimeout(() => startRiskEngine(),      32_000);
  setTimeout(() => startEventListener(),   40_000);
  setTimeout(() => startWithdrawalMonitor(), 48_000);

  // L1: delegate surplus uinit to validator on startup (56s offset)
  if (config.l1StakingEnabled) {
    setTimeout(async () => {
      try {
        console.log("[keeper] Running initial L1 surplus delegation...");
        await delegateSurplusOnL1();
      } catch (e: any) {
        console.error("[keeper] Initial L1 delegation error:", e.message);
      }
    }, 56_000);
  }

  // Run first harvest after 60s (let all services establish staggered connections)
  setTimeout(harvestCycle, 60_000);
  harvestTimer = setInterval(harvestCycle, config.keeperIntervalMs);
}

export function stopKeeper() {
  if (harvestTimer) clearInterval(harvestTimer);
  if (recycleTimer) clearInterval(recycleTimer);
  harvestTimer = null;
  recycleTimer = null;

  stopOracle();
  stopRewardEngine();
  stopMetricsCron();
  stopLiquidationBot();
  stopRiskEngine();
  stopEventListener();
  stopWithdrawalMonitor();

  console.log("[keeper] Stopped all services");
}
