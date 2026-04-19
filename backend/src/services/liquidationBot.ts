/**
 * Liquidation Bot — Scans borrowers and liquidates undercollateralized positions.
 * Tracks borrowers via event bus + MongoDB.
 */
import { config } from "../config";
import { queryContract, executeContract, getSigningClient } from "../chain";
import { borrowers as borrowersCollection, liquidations as liquidationsCollection, BorrowerDoc } from "../mongo";
import { eventBus, EventType } from "./eventBus";

function log(msg: string) { console.log(`[liquidation-bot] ${msg}`); }
function warn(msg: string) { console.warn(`[liquidation-bot] ${msg}`); }

let scanTimer: NodeJS.Timeout | null = null;

interface PositionResponse {
  collateral: string;
  debt: string;
  max_borrow: string;
  health_factor: string;
}

/**
 * Register a borrower address for monitoring.
 */
export async function trackBorrower(address: string): Promise<void> {
  try {
    await borrowersCollection().updateOne(
      { address },
      { $set: { address, lastUpdated: Date.now() } },
      { upsert: true },
    );
  } catch (_) {}
}

/**
 * Update health factor for all known borrowers.
 */
async function refreshBorrowers(): Promise<BorrowerDoc[]> {
  const allBorrowers = await borrowersCollection().find({}).toArray();
  const updated: BorrowerDoc[] = [];

  for (const b of allBorrowers) {
    try {
      const pos = await queryContract<PositionResponse>(config.lendingAddress, {
        position: { address: b.address },
      });

      const healthFactor = Number(pos.health_factor) / 1e18; // Decimal type
      const doc: BorrowerDoc = {
        address: b.address,
        collateral: pos.collateral,
        debt: pos.debt,
        healthFactor,
        lastUpdated: Date.now(),
      };

      await borrowersCollection().updateOne(
        { address: b.address },
        { $set: doc },
        { upsert: true },
      );
      updated.push(doc);
    } catch (err: any) {
      // Position might be empty (fully repaid) — remove from tracking
      if (err.message?.includes("not found") || err.message?.includes("no position")) {
        await borrowersCollection().deleteOne({ address: b.address });
      }
    }
  }

  return updated;
}

/**
 * Attempt to liquidate a borrower.
 */
async function liquidate(borrowerAddr: string, debt: string): Promise<boolean> {
  try {
    const { address: keeperAddr } = await getSigningClient();

    // Repay up to 50% of debt to liquidate
    const repayAmount = (BigInt(debt) / 2n).toString();
    if (BigInt(repayAmount) === 0n) return false;

    log(`Liquidating ${borrowerAddr}: repaying ${repayAmount}...`);
    const res = await executeContract(
      config.lendingAddress,
      { liquidate: { borrower: borrowerAddr } },
      [{ denom: config.denom, amount: repayAmount }],
    );

    log(`Liquidated ${borrowerAddr}, tx: ${res.transactionHash}`);

    // Record in MongoDB
    await liquidationsCollection().insertOne({
      txHash: res.transactionHash,
      timestamp: Date.now(),
      borrower: borrowerAddr,
      liquidator: keeperAddr,
      debtRepaid: repayAmount,
      collateralSeized: "0", // parse from events if needed
      healthFactorBefore: 0,
    });

    eventBus.publish(EventType.LIQUIDATION_DETECTED, {
      borrower: borrowerAddr,
      debtRepaid: repayAmount,
      txHash: res.transactionHash,
    });

    return true;
  } catch (err: any) {
    warn(`Liquidation of ${borrowerAddr} failed: ${err.message}`);
    return false;
  }
}

/**
 * Scan all tracked borrowers and liquidate any with health_factor < 1.0.
 */
export async function scanAndLiquidate(): Promise<{ scanned: number; liquidated: number }> {
  const borrowerDocs = await refreshBorrowers();
  let liquidatedCount = 0;

  for (const b of borrowerDocs) {
    if (b.healthFactor > 0 && b.healthFactor < 1.0 && BigInt(b.debt) > 0n) {
      log(`${b.address} is undercollateralized (HF=${b.healthFactor.toFixed(4)})`);
      const success = await liquidate(b.address, b.debt);
      if (success) liquidatedCount++;
    }
  }

  if (borrowerDocs.length > 0) {
    log(`Scanned ${borrowerDocs.length} borrowers, liquidated ${liquidatedCount}`);
  }

  return { scanned: borrowerDocs.length, liquidated: liquidatedCount };
}

export function startLiquidationBot(): void {
  log(`Starting liquidation scanner every ${config.liquidationIntervalMs / 1000}s`);

  // Listen for new borrows to track
  eventBus.subscribe(EventType.BORROW_EXECUTED, (payload) => {
    const addr = payload.data.sender || payload.data.borrower;
    if (addr) trackBorrower(addr);
  });

  scanTimer = setInterval(() => {
    scanAndLiquidate().catch(e => warn(e.message));
  }, config.liquidationIntervalMs);
}

export function stopLiquidationBot(): void {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
  log("Stopped");
}
