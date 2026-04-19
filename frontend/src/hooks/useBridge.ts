"use client";

import { useCallback } from "react";
import { CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { useInterwovenKit } from "@initia/interwovenkit-react";
import { chainConfig, l1Config } from "@/config/contracts";

let l1ClientCache: CosmWasmClient | null = null;
let l2ClientCache: CosmWasmClient | null = null;

async function getL1Client(): Promise<CosmWasmClient> {
  if (!l1ClientCache) {
    l1ClientCache = await CosmWasmClient.connect(l1Config.rpcUrl);
  }
  return l1ClientCache;
}

async function getL2Client(): Promise<CosmWasmClient> {
  if (!l2ClientCache) {
    l2ClientCache = await CosmWasmClient.connect(chainConfig.rpcUrl);
  }
  return l2ClientCache;
}

export function useBridge() {
  const { address, requestTxBlock } = useInterwovenKit();

  const getL1Balance = useCallback(async (addr: string): Promise<string> => {
    const client = await getL1Client();
    const bal = await client.getBalance(addr, l1Config.denom);
    return bal.amount;
  }, []);

  const getL2Balance = useCallback(async (addr: string): Promise<string> => {
    const client = await getL2Client();
    const bal = await client.getBalance(addr, chainConfig.nativeDenom);
    return bal.amount;
  }, []);

  const bridgeToL2 = useCallback(
    async (amount: string) => {
      if (!address) throw new Error("Wallet not connected");

      const msg = {
        typeUrl: "/opinit.ophost.v1.MsgInitiateTokenDeposit",
        value: {
          sender: address,
          bridgeId: BigInt(l1Config.bridgeId),
          to: address,
          amount: { denom: l1Config.denom, amount },
          data: new Uint8Array([]),
        },
      };

      const result = await requestTxBlock({
        messages: [msg],
        chainId: l1Config.chainId,
      });
      return result;
    },
    [address, requestTxBlock]
  );

  return {
    address,
    getL1Balance,
    getL2Balance,
    bridgeToL2,
  };
}
