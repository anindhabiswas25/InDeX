import { SigningCosmWasmClient, CosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { config } from "./config";

let queryClient: CosmWasmClient | null = null;
let signingClient: SigningCosmWasmClient | null = null;
let keeperAddress: string | null = null;

// Reset query client (e.g. after connection errors)
export function resetQueryClient() {
  queryClient = null;
}

export async function getQueryClient(): Promise<CosmWasmClient> {
  if (!queryClient) {
    queryClient = await CosmWasmClient.connect(config.rpcUrl);
  }
  return queryClient;
}

export async function getSigningClient(): Promise<{ client: SigningCosmWasmClient; address: string }> {
  if (!signingClient || !keeperAddress) {
    if (!config.keeperMnemonic) throw new Error("KEEPER_WALLET_MNEMONIC not set");
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(config.keeperMnemonic, {
      prefix: "init",
    });
    const [account] = await wallet.getAccounts();
    keeperAddress = account.address;
    signingClient = await SigningCosmWasmClient.connectWithSigner(config.rpcUrl, wallet, {
      gasPrice: GasPrice.fromString(`0.15${config.denom}`),
    });
  }
  return { client: signingClient, address: keeperAddress };
}

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2000;

function is429(err: any): boolean {
  const msg: string = err?.message ?? "";
  return (
    msg.includes("429") ||
    msg.includes("Too Many Requests") ||
    msg.includes("Bad status on response: 429")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function queryContract<T = any>(address: string, msg: Record<string, unknown>): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await getQueryClient();
      return (await client.queryContractSmart(address, msg)) as T;
    } catch (err: any) {
      lastErr = err;
      if (is429(err)) {
        // Reset client so we get a fresh connection on next attempt
        resetQueryClient();
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`[chain] 429 rate limit — retry ${attempt + 1}/${MAX_RETRIES} after ${Math.round(delay)}ms`);
        await sleep(delay);
      } else {
        // Non-429 error: reset client in case it's stale, but don't retry
        resetQueryClient();
        throw err;
      }
    }
  }
  throw lastErr;
}

export async function executeContract(
  contractAddress: string,
  msg: Record<string, unknown>,
  funds: { denom: string; amount: string }[] = [],
) {
  const { client, address } = await getSigningClient();
  return client.execute(address, contractAddress, msg, "auto", undefined, funds);
}
