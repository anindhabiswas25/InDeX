/**
 * Withdrawal Monitor — Tracks pending withdrawals and detects claimable ones.
 * Uses event bus for real-time tracking + periodic on-chain verification.
 */
import { config } from "../config";
import { queryContract } from "../chain";
import { eventBus, EventType } from "./eventBus";

function log(msg: string) { console.log(`[withdrawal-monitor] ${msg}`); }

// In-memory tracking of users with pending withdrawals
const pendingUsers = new Set<string>();
let monitorTimer: NodeJS.Timeout | null = null;

export interface ClaimableWithdrawal {
  id: number;
  initAmount: string;
  readyAt: number;
  isReady: boolean;
}

/**
 * Track a user who initiated a withdrawal.
 */
export function trackUser(address: string): void {
  pendingUsers.add(address);
}

/**
 * Get claimable withdrawals for an address.
 */
export async function getClaimableWithdrawals(address: string): Promise<ClaimableWithdrawal[]> {
  try {
    const res = await queryContract<{ withdrawals: any[] }>(config.stakingAddress, {
      withdrawals: { user: address },
    });

    const now = Math.floor(Date.now() / 1000);
    return (res.withdrawals || []).map((w: any) => ({
      id: w.id,
      initAmount: w.init_amount,
      readyAt: w.ready_at,
      isReady: w.ready_at <= now,
    }));
  } catch {
    return [];
  }
}

/**
 * Scan all tracked users for ready withdrawals.
 */
async function scanWithdrawals(): Promise<void> {
  for (const addr of pendingUsers) {
    const claims = await getClaimableWithdrawals(addr);
    const ready = claims.filter(c => c.isReady);

    if (ready.length > 0) {
      eventBus.publish(EventType.WITHDRAWAL_READY, {
        address: addr,
        count: ready.length,
        withdrawals: ready,
      });
      log(`${addr}: ${ready.length} withdrawal(s) ready to claim`);
    }

    // Remove if no more pending
    if (claims.length === 0) {
      pendingUsers.delete(addr);
    }
  }
}

export function startWithdrawalMonitor(): void {
  log("Starting withdrawal monitor");

  eventBus.subscribe(EventType.UNSTAKE_EXECUTED, (payload) => {
    const addr = payload.data.sender || payload.data.user;
    if (addr) trackUser(addr);
  });

  monitorTimer = setInterval(() => {
    scanWithdrawals().catch(() => {});
  }, 60_000); // every 60s
}

export function stopWithdrawalMonitor(): void {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  log("Stopped");
}
