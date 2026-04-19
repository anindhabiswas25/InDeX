/**
 * INITx Protocol — Deploy all 5 contracts to Initia testnet
 *
 * Deployment order:
 * 1. Upload all WASM codes
 * 2. Instantiate initx-token (needs staking address — use predicted address or 2-pass)
 * 3. Instantiate staking (wire initx-token address)
 * 4. Set minter on initx-token to staking contract
 * 5. Instantiate lp-pool (wire initx-token)
 * 6. Instantiate lending (wire initx-token)
 * 7. Instantiate governance (wire initx-token)
 * 8. Write deployed addresses to .env
 */
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(import.meta.dirname, "../../.env") });

const ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS = resolve(ROOT, "artifacts");

// ------- Config -------
const RPC_URL = process.env.INITIA_RPC_URL || "https://rpc.testnet.initia.xyz";
const CHAIN_ID = process.env.CHAIN_ID || "initiation-2";
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
const DENOM = "uinit"; // native denom on Initia
const GAS_PRICE = "0.15uinit";
const PREFIX = "init"; // bech32 prefix

if (!MNEMONIC) {
  console.error("ERROR: DEPLOYER_MNEMONIC not set in .env");
  process.exit(1);
}

interface DeployedAddresses {
  initxToken: string;
  staking: string;
  lpPool: string;
  lending: string;
  governance: string;
}

async function getClient() {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC!, {
    prefix: PREFIX,
  });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE),
  });
  console.log(`Deployer: ${account.address}`);
  const balance = await client.getBalance(account.address, DENOM);
  console.log(`Balance: ${balance.amount} ${DENOM}\n`);
  return { client, address: account.address };
}

async function uploadContract(
  client: SigningCosmWasmClient,
  sender: string,
  name: string
): Promise<number> {
  const wasmPath = resolve(ARTIFACTS, `${name.replace(/-/g, "_")}.wasm`);
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM not found: ${wasmPath}. Run build first.`);
  }
  const wasm = readFileSync(wasmPath);
  console.log(`Uploading ${name} (${(wasm.length / 1024).toFixed(1)} KB)...`);
  const result = await client.upload(sender, wasm, "auto");
  console.log(`  ✓ Code ID: ${result.codeId}`);
  return result.codeId;
}

async function instantiate(
  client: SigningCosmWasmClient,
  sender: string,
  codeId: number,
  label: string,
  msg: Record<string, unknown>,
  funds: { denom: string; amount: string }[] = []
): Promise<string> {
  console.log(`Instantiating ${label}...`);
  const result = await client.instantiate(sender, codeId, msg, label, "auto", {
    funds,
  });
  console.log(`  ✓ Address: ${result.contractAddress}\n`);
  return result.contractAddress;
}

async function deploy() {
  const { client, address: admin } = await getClient();

  // Step 1: Upload all WASMs
  console.log("=== Step 1: Upload WASM codes ===\n");
  const codeIds = {
    initxToken: await uploadContract(client, admin, "initx-token"),
    staking: await uploadContract(client, admin, "staking"),
    lpPool: await uploadContract(client, admin, "lp-pool"),
    lending: await uploadContract(client, admin, "lending"),
    governance: await uploadContract(client, admin, "governance"),
  };
  console.log("\nAll codes uploaded:", codeIds, "\n");

  // Step 2: Instantiate initx-token first (admin as temp minter, will update later)
  console.log("=== Step 2: Instantiate contracts ===\n");

  const initxToken = await instantiate(client, admin, codeIds.initxToken, "INITx Token", {
    name: "INITx",
    symbol: "INITx",
    decimals: 6,
    initial_balances: [],
    mint: { minter: admin, cap: null },
  });

  // Step 3: Instantiate staking (wire initx-token)
  const staking = await instantiate(client, admin, codeIds.staking, "INITx Staking", {
    initx_token: initxToken,
    validator: "initvaloper1...", // TODO: will be set from env
    unbonding_period: 1814400, // 21 days in seconds
    protocol_fee_bps: 1000, // 10%
  });

  // Step 4: Set minter on initx-token to staking contract
  console.log("Setting minter on INITx token to staking contract...");
  await client.execute(admin, initxToken, { set_minter: { new_minter: staking } }, "auto");
  console.log("  ✓ Minter set\n");

  // Step 5: Instantiate lp-pool
  const lpPool = await instantiate(client, admin, codeIds.lpPool, "INITx LP Pool", {
    initx_token: initxToken,
    native_denom: DENOM,
    fee_bps: 30, // 0.3%
  });

  // Step 6: Instantiate lending
  const lending = await instantiate(client, admin, codeIds.lending, "INITx Lending", {
    initx_token: initxToken,
    native_denom: DENOM,
    collateral_factor_bps: 7000,
    liquidation_threshold_bps: 8000,
    borrow_rate_bps: 500,
    liquidation_bonus_bps: 500,
  });

  // Step 7: Instantiate governance
  const governance = await instantiate(client, admin, codeIds.governance, "INITx Governance", {
    initx_token: initxToken,
    voting_period: 259200, // 3 days in seconds
    quorum_bps: 1000, // 10%
    threshold_bps: 5000, // 50%
  });

  const deployed: DeployedAddresses = {
    initxToken,
    staking,
    lpPool,
    lending,
    governance,
  };

  console.log("=== Deployment Complete ===\n");
  console.log(JSON.stringify(deployed, null, 2));

  // Write to .env
  const envContent = `# Initia Testnet (auto-generated by deploy script)
INITIA_RPC_URL=${RPC_URL}
INITIA_REST_URL=${process.env.INITIA_REST_URL || "https://lcd.testnet.initia.xyz"}
CHAIN_ID=${CHAIN_ID}
DEPLOYER_MNEMONIC=${MNEMONIC}

# Contract Addresses
INITX_TOKEN_ADDRESS=${initxToken}
STAKING_ADDRESS=${staking}
LP_POOL_ADDRESS=${lpPool}
LENDING_ADDRESS=${lending}
GOVERNANCE_ADDRESS=${governance}

# Backend
DATABASE_URL=${process.env.DATABASE_URL || "postgresql://user:password@localhost:5432/initx"}
REDIS_URL=${process.env.REDIS_URL || "redis://localhost:6379"}
PORT=${process.env.PORT || "3001"}
KEEPER_WALLET_MNEMONIC=${process.env.KEEPER_WALLET_MNEMONIC || MNEMONIC}

# Frontend
NEXT_PUBLIC_API_URL=${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"}
NEXT_PUBLIC_RPC_URL=${RPC_URL}
NEXT_PUBLIC_CHAIN_ID=${CHAIN_ID}
NEXT_PUBLIC_INITX_TOKEN=${initxToken}
NEXT_PUBLIC_STAKING=${staking}
NEXT_PUBLIC_LP_POOL=${lpPool}
NEXT_PUBLIC_LENDING=${lending}
NEXT_PUBLIC_GOVERNANCE=${governance}
`;

  writeFileSync(resolve(ROOT, ".env"), envContent);
  console.log("\n.env file written with all contract addresses.");

  // Also write a JSON deployments file
  writeFileSync(
    resolve(ROOT, "deployments/testnet.json"),
    JSON.stringify(
      {
        network: CHAIN_ID,
        rpc: RPC_URL,
        deployer: admin,
        codeIds,
        contracts: deployed,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("deployments/testnet.json written.");
}

deploy().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
