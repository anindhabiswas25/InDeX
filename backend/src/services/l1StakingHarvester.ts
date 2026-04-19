/**
 * l1StakingHarvester.ts
 *
 * Manages real Initia L1 staking on initiation-2:
 *   1. Delegate INIT to Chorus One validator
 *   2. Claim staking rewards (MsgWithdrawDelegatorReward)
 *   3. Bridge claimed uinit back to wasm-1 via IBC (channel-3073)
 *
 * Uses @initia/initia.js for mstaking message types (custom Initia module).
 */

import {
  RESTClient,
  MnemonicKey,
  Wallet,
  MsgDelegate,
  MsgWithdrawDelegatorReward,
  MsgTransfer,
  Coin,
} from "@initia/initia.js";
import { config } from "../config";

// ─── Module-level singleton client ───────────────────────────────────────────

let _client: RESTClient | null = null;
let _wallet: Wallet | null = null;

function getL1Client(): { client: RESTClient; wallet: Wallet } {
  if (_client && _wallet) return { client: _client, wallet: _wallet };

  const key = new MnemonicKey({ mnemonic: config.keeperMnemonic });
  _client = new RESTClient(config.l1RestUrl, {
    chainId: config.l1ChainId,
    gasPrices: "0.015uinit",
  });
  _wallet = _client.wallet(key);
  return { client: _client, wallet: _wallet };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function getKeeperL1Address(): Promise<string> {
  const { wallet } = getL1Client();
  return wallet.key.accAddress;
}

/**
 * Returns { delegated: bigint (uinit), pendingRewards: bigint (uinit) }
 */
export async function getL1DelegationInfo(): Promise<{
  delegated: bigint;
  pendingRewards: bigint;
}> {
  const { client } = getL1Client();
  const address = await getKeeperL1Address();

  try {
    // Delegations — returns [Delegation[], Pagination]
    const [delegationList] = await client.mstaking.delegations(address);
    let delegated = 0n;
    for (const d of delegationList) {
      // Each Delegation has a .shares property (array of DecCoin in mstaking)
      const shares = (d as any).shares;
      if (shares) {
        for (const s of (Array.isArray(shares) ? shares : [shares])) {
          if ((s.denom ?? s.denom) === config.l1Denom) {
            delegated += BigInt(Math.floor(parseFloat(s.amount)));
          }
        }
      }
    }

    // Pending rewards — total is array of {denom, amount} or []
    const rewardsRes = await client.distribution.rewards(address);
    let pendingRewards = 0n;
    const totalArr: Array<{ denom: string; amount: string }> =
      Array.isArray((rewardsRes as any).total)
        ? (rewardsRes as any).total
        : [];
    for (const coin of totalArr) {
      if (coin.denom === config.l1Denom) {
        pendingRewards = BigInt(Math.floor(parseFloat(coin.amount)));
        break;
      }
    }

    return { delegated, pendingRewards };
  } catch (e: any) {
    console.error(`[l1-staking] getL1DelegationInfo error: ${e.message}`);
    return { delegated: 0n, pendingRewards: 0n };
  }
}

// ─── Core actions ─────────────────────────────────────────────────────────────

/**
 * Delegate `uinitAmount` uinit to the configured validator.
 * Returns tx hash or null on failure.
 */
export async function delegateOnL1(uinitAmount: bigint): Promise<string | null> {
  if (!config.l1StakingEnabled) return null;
  if (uinitAmount <= 0n) return null;

  const { wallet } = getL1Client();
  const delegatorAddress = await getKeeperL1Address();

  console.log(
    `[l1-staking] Delegating ${uinitAmount} uinit to ${config.l1ValidatorAddress}`
  );

  try {
    const msg = new MsgDelegate(
      delegatorAddress,
      config.l1ValidatorAddress,
      // mstaking expects array of Coin
      new Coin(config.l1Denom, uinitAmount.toString()) as any
    );

    const tx = await wallet.createAndSignTx({ msgs: [msg] });
    const result = await getL1Client().client.tx.broadcast(tx);

    if ((result as any).code && (result as any).code !== 0) {
      console.error(`[l1-staking] Delegate failed: ${JSON.stringify(result)}`);
      return null;
    }

    const txHash = (result as any).txhash ?? (result as any).tx_hash ?? "";
    console.log(`[l1-staking] Delegated ${uinitAmount} uinit, tx: ${txHash}`);
    return txHash;
  } catch (e: any) {
    console.error(`[l1-staking] delegateOnL1 error: ${e.message}`);
    return null;
  }
}

/**
 * Claim all staking rewards from the configured validator.
 * Returns claimed uinit amount (bigint) and tx hash.
 */
export async function claimL1StakingRewards(): Promise<{
  uinitClaimed: bigint;
  txHash: string | null;
}> {
  if (!config.l1StakingEnabled) return { uinitClaimed: 0n, txHash: null };

  const { wallet } = getL1Client();
  const delegatorAddress = await getKeeperL1Address();

  // Query pending rewards first
  const { pendingRewards } = await getL1DelegationInfo();
  if (pendingRewards < 1000n) {
    // skip if < 0.001 INIT — not worth the gas
    console.log(
      `[l1-staking] Pending rewards ${pendingRewards} uinit — too small, skipping claim`
    );
    return { uinitClaimed: 0n, txHash: null };
  }

  console.log(
    `[l1-staking] Claiming ~${pendingRewards} uinit rewards from validator`
  );

  try {
    const msg = new MsgWithdrawDelegatorReward(
      delegatorAddress,
      config.l1ValidatorAddress
    );

    const tx = await wallet.createAndSignTx({ msgs: [msg] });
    const result = await getL1Client().client.tx.broadcast(tx);

    if ((result as any).code && (result as any).code !== 0) {
      console.error(`[l1-staking] Claim rewards failed: ${JSON.stringify(result)}`);
      return { uinitClaimed: 0n, txHash: null };
    }

    const txHash = (result as any).txhash ?? (result as any).tx_hash ?? "";
    console.log(
      `[l1-staking] Claimed ~${pendingRewards} uinit rewards, tx: ${txHash}`
    );
    return { uinitClaimed: pendingRewards, txHash };
  } catch (e: any) {
    console.error(`[l1-staking] claimL1StakingRewards error: ${e.message}`);
    return { uinitClaimed: 0n, txHash: null };
  }
}

/**
 * Bridge `uinitAmount` uinit from L1 back to wasm-1 keeper address via IBC.
 * Returns tx hash or null on failure.
 */
export async function bridgeRewardsToWasm1(
  uinitAmount: bigint,
  receiverAddress: string
): Promise<string | null> {
  if (!config.l1StakingEnabled) return null;
  if (uinitAmount <= 0n) return null;

  const { wallet } = getL1Client();
  const senderAddress = await getKeeperL1Address();

  // IBC timeout: current time + 10 minutes (in nanoseconds)
  const timeoutTimestamp = (BigInt(Date.now()) + 600_000n) * 1_000_000n;

  console.log(
    `[l1-staking] Bridging ${uinitAmount} uinit → wasm-1 via ${config.l1ToWasm1Channel}`
  );

  try {
    const msg = new MsgTransfer(
      "transfer",
      config.l1ToWasm1Channel,
      new Coin(config.l1Denom, uinitAmount.toString()),
      senderAddress,
      receiverAddress,
      undefined, // no height timeout
      timeoutTimestamp.toString()
    );

    const tx = await wallet.createAndSignTx({ msgs: [msg] });
    const result = await getL1Client().client.tx.broadcast(tx);

    if ((result as any).code && (result as any).code !== 0) {
      console.error(`[l1-staking] Bridge failed: ${JSON.stringify(result)}`);
      return null;
    }

    const txHash = (result as any).txhash ?? (result as any).tx_hash ?? "";
    console.log(
      `[l1-staking] Bridged ${uinitAmount} uinit → wasm-1, tx: ${txHash}`
    );
    return txHash;
  } catch (e: any) {
    console.error(`[l1-staking] bridgeRewardsToWasm1 error: ${e.message}`);
    return null;
  }
}

/**
 * Check L1 balance and delegate any surplus above gas reserve.
 * Gas reserve: 4,000,000 uinit (4 INIT).
 * Called at startup and optionally after each harvest.
 */
export async function delegateSurplusOnL1(): Promise<void> {
  if (!config.l1StakingEnabled) return;

  const { client } = getL1Client();
  const address = await getKeeperL1Address();
  const GAS_RESERVE = 4_000_000n; // 4 INIT

  try {
    const balanceRes = await client.bank.balance(address);
    // bank.balance returns [Coins, Pagination] where Coins.toString() = "amountdenom,..."
    // Parse the balance for uinit
    const [coinsRaw] = balanceRes as any;
    const coinsStr = String(coinsRaw); // e.g. "18995331uinit" or "100uinit,200uatom"
    let balance = 0n;
    for (const part of coinsStr.split(",")) {
      const match = part.match(/^(\d+)(.+)$/);
      if (match && match[2] === config.l1Denom) {
        balance = BigInt(match[1]);
        break;
      }
    }

    const surplus = balance - GAS_RESERVE;
    if (surplus < 1_000_000n) {
      // < 1 INIT surplus — nothing to delegate
      console.log(
        `[l1-staking] L1 balance ${balance} uinit — surplus ${surplus} uinit below threshold, skipping`
      );
      return;
    }

    await delegateOnL1(surplus);
  } catch (e: any) {
    console.error(`[l1-staking] delegateSurplusOnL1 error: ${e.message}`);
  }
}

/**
 * Full L1 harvest step:
 *   1. Claim staking rewards
 *   2. Bridge claimed uinit back to wasm-1
 * Returns how many uinit were claimed & bridged.
 */
export async function harvestL1Rewards(keeperWasm1Address: string): Promise<bigint> {
  if (!config.l1StakingEnabled) return 0n;

  const { uinitClaimed, txHash: claimTx } = await claimL1StakingRewards();
  if (uinitClaimed <= 0n || !claimTx) return 0n;

  // Leave a small amount on L1 for gas (100_000 uinit = 0.1 INIT)
  const GAS_BUFFER = 100_000n;
  const toBridge = uinitClaimed > GAS_BUFFER ? uinitClaimed - GAS_BUFFER : 0n;
  if (toBridge <= 0n) return 0n;

  const bridgeTx = await bridgeRewardsToWasm1(toBridge, keeperWasm1Address);
  if (!bridgeTx) return 0n;

  console.log(
    `[l1-staking] Harvest complete: claimed=${uinitClaimed} uinit, bridged=${toBridge} uinit`
  );
  return toBridge;
}
