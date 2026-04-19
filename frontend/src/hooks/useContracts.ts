"use client";

import { useCallback, useMemo } from "react";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { HttpBatchClient, Tendermint37Client } from "@cosmjs/tendermint-rpc";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import { contracts, chainConfig } from "@/config/contracts";

let clientCache: CosmWasmClient | null = null;
let clientPromise: Promise<CosmWasmClient> | null = null;

async function buildClient(): Promise<CosmWasmClient> {
  // Use HTTP batch transport — no persistent WebSocket, never goes stale
  const httpClient = new HttpBatchClient(chainConfig.rpcUrl, {
    dispatchInterval: 100,
    batchSizeLimit: 20,
  });
  const tmClient = await Tendermint37Client.create(httpClient);
  return CosmWasmClient.create(tmClient);
}

async function getQueryClient(): Promise<CosmWasmClient> {
  if (clientCache) return clientCache;
  // Deduplicate concurrent calls during initial connect
  if (!clientPromise) {
    clientPromise = buildClient().then((c) => {
      clientCache = c;
      clientPromise = null;
      return c;
    }).catch((e) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

// Call this to force a fresh connection (e.g. after a network error)
function resetQueryClient() {
  clientCache = null;
  clientPromise = null;
}

// Helper to encode JSON to Uint8Array (browser-safe, no Buffer dependency)
function toJsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function useContracts() {
  const { address, requestTxBlock } = useInterwovenKit();

  // Query any contract — retries once with a fresh client on failure
  const query = useCallback(
    async (contract: keyof typeof contracts, msg: Record<string, unknown>) => {
      try {
        const client = await getQueryClient();
        return await client.queryContractSmart(contracts[contract], msg);
      } catch (e) {
        // Reset and retry once with a brand-new client
        resetQueryClient();
        const client = await getQueryClient();
        return await client.queryContractSmart(contracts[contract], msg);
      }
    },
    []
  );

  // Execute via InterwovenKit — always targets wasm-1 (L2)
  const execute = useCallback(
    async (
      contract: keyof typeof contracts,
      msg: Record<string, unknown>,
      funds?: { denom: string; amount: string }[]
    ) => {
      if (!address) throw new Error("Wallet not connected");

      const executeMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: {
          sender: address,
          contract: contracts[contract],
          msg: toJsonBytes(msg),
          funds: funds || [],
        },
      };

      const result = await requestTxBlock({
        messages: [executeMsg],
        chainId: chainConfig.chainId,
      });
      return result;
    },
    [address, requestTxBlock]
  );

  // Get native INIT balance
  const getInitBalance = useCallback(async (addr: string): Promise<string> => {
    try {
      const client = await getQueryClient();
      const bal = await client.getBalance(addr, chainConfig.nativeDenom);
      return bal.amount;
    } catch {
      resetQueryClient();
      const client = await getQueryClient();
      const bal = await client.getBalance(addr, chainConfig.nativeDenom);
      return bal.amount;
    }
  }, []);

  // Get INITx (CW20) balance
  const getInitxBalance = useCallback(async (addr: string): Promise<string> => {
    try {
      const client = await getQueryClient();
      const res = await client.queryContractSmart(contracts.initxToken, { balance: { address: addr } });
      return res.balance;
    } catch {
      resetQueryClient();
      const client = await getQueryClient();
      const res = await client.queryContractSmart(contracts.initxToken, { balance: { address: addr } });
      return res.balance;
    }
  }, []);

  // Staking helpers
  const staking = useMemo(
    () => ({
      deposit: (amount: string) =>
        execute("staking", { deposit: {} }, [{ denom: chainConfig.nativeDenom, amount }]),
      requestWithdrawal: (initxAmount: string) =>
        execute("initxToken", {
          send: {
            contract: contracts.staking,
            amount: initxAmount,
            msg: btoa(JSON.stringify({ request_withdrawal: {} })),
          },
        }),
      claimWithdrawal: (id: number) =>
        execute("staking", { claim_withdrawal: { withdrawal_id: id } }),
      getConfig: () => query("staking", { config: {} }),
      getPoolState: () => query("staking", { pool_state: {} }),
      getExchangeRate: () => query("staking", { exchange_rate: {} }),
      getWithdrawals: (addr: string) =>
        query("staking", { withdrawals: { user: addr } }),
      estimateDeposit: (amount: string) =>
        query("staking", { estimate_deposit: { amount } }),
      estimateWithdrawal: (initxAmount: string) =>
        query("staking", {
          estimate_withdrawal: { initx_amount: initxAmount },
        }),
    }),
    [query, execute]
  );

  // Swap / LP Pool helpers
  const swap = useMemo(
    () => ({
      swapInitForInitx: (amount: string, minOut?: string) =>
        execute(
          "swap",
          { swap_init_for_initx: { min_out: minOut || null } },
          [{ denom: chainConfig.nativeDenom, amount }]
        ),
      // swapInitxForInit requires CW20 Send to LP pool contract
      // The user sends INITx via CW20 Send with a hook message
      swapInitxForInit: (amount: string, minOut?: string) =>
        execute("initxToken", {
          send: {
            contract: contracts.swap,
            amount,
            msg: btoa(
              JSON.stringify({
                swap_initx_for_init: { min_out: minOut || null },
              })
            ),
          },
        }),
      getPool: () => query("swap", { pool_state: {} }),
      estimateSwap: (
        offerAsset: "native_init" | "cw20_initx",
        offerAmount: string
      ) =>
        query("swap", {
          estimate_swap: {
            offer_asset: offerAsset === "native_init" ? "native_init" : "cw20_initx",
            offer_amount: offerAmount,
          },
        }),
    }),
    [query, execute]
  );

  // Liquidity helpers (same contract as swap — lp-pool)
  const liquidity = useMemo(
    () => ({
      // Add liquidity: send INITx via CW20 Send with INIT as native funds
      // The AddLiquidity flow: user sends INIT to contract first, then CW20 Send INITx
      // Add liquidity: send INIT via bank transfer first, then CW20 Send INITx
      addLiquidity: async (initAmount: string, initxAmount: string) => {
        if (!address) throw new Error("Wallet not connected");

        // Message 1: Send native INIT to LP pool contract
        const bankSendMsg = {
          typeUrl: "/cosmos.bank.v1beta1.MsgSend",
          value: {
            fromAddress: address,
            toAddress: contracts.liquidity,
            amount: [{ denom: chainConfig.nativeDenom, amount: initAmount }],
          },
        };

        // Message 2: CW20 Send INITx to LP pool with AddLiquidity hook
        const cw20SendMsg = {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: {
            sender: address,
            contract: contracts.initxToken,
            msg: toJsonBytes({
              send: {
                contract: contracts.liquidity,
                amount: initxAmount,
                msg: btoa(
                  JSON.stringify({
                    add_liquidity: { min_lp_shares: null },
                  })
                ),
              },
            }),
            funds: [],
          },
        };

        return requestTxBlock({
          messages: [bankSendMsg, cw20SendMsg],
          chainId: chainConfig.chainId,
        });
      },
      removeLiquidity: (lpShares: string) =>
        execute("liquidity", { remove_liquidity: { lp_shares: lpShares } }),
      getPool: () => query("liquidity", { pool_state: {} }),
      getLpBalance: (addr: string) =>
        query("liquidity", { lp_balance: { address: addr } }),
    }),
    [query, execute]
  );

  // Lending helpers
  const lending = useMemo(
    () => ({
      // Deposit collateral: send INITx via CW20 Send
      depositCollateral: (amount: string) =>
        execute("initxToken", {
          send: {
            contract: contracts.lending,
            amount,
            msg: btoa(JSON.stringify({ deposit_collateral: {} })),
          },
        }),
      supply: (amount: string) =>
        execute("lending", { supply: {} }, [{ denom: chainConfig.nativeDenom, amount }]),
      borrow: (amount: string) =>
        execute("lending", { borrow: { amount } }),
      repay: (amount: string) =>
        execute("lending", { repay: {} }, [{ denom: chainConfig.nativeDenom, amount }]),
      withdrawCollateral: (amount: string) =>
        execute("lending", { withdraw_collateral: { amount } }),
      withdrawSupply: (amount: string) =>
        execute("lending", { withdraw_supply: { amount } }),
      getPosition: (addr: string) =>
        query("lending", { position: { address: addr } }),
      getPoolState: () => query("lending", { pool_state: {} }),
      getConfig: () => query("lending", { config: {} }),
      getHealthFactor: (addr: string) =>
        query("lending", { health_factor: { address: addr } }),
    }),
    [query, execute]
  );

  // Governance helpers
  const governance = useMemo(
    () => ({
      // Create proposal: send INITx via CW20 Send
      createProposal: (
        deposit: string,
        title: string,
        description: string
      ) =>
        execute("initxToken", {
          send: {
            contract: contracts.governance,
            amount: deposit,
            msg: btoa(
              JSON.stringify({
                create_proposal: { title, description, messages: null },
              })
            ),
          },
        }),
      vote: (proposalId: number, vote: "yes" | "no" | "abstain") =>
        execute("governance", {
          vote: { proposal_id: proposalId, vote },
        }),
      executeProposal: (proposalId: number) =>
        execute("governance", { execute: { proposal_id: proposalId } }),
      getProposals: () =>
        query("governance", {
          proposals: { start_after: null, limit: null },
        }),
      getProposal: (id: number) =>
        query("governance", { proposal: { id } }),
      getProposalStatus: (id: number) =>
        query("governance", { proposal_status: { id } }),
      getConfig: () => query("governance", { config: {} }),
    }),
    [query, execute]
  );

  return {
    address,
    query,
    execute,
    getInitBalance,
    getInitxBalance,
    staking,
    swap,
    liquidity,
    lending,
    governance,
  };
}
