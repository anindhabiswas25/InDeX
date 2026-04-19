/**
 * INITx Protocol — Migrate to Real Yield model
 *
 * This script:
 * 1. Derives the keeper wallet address from the keeper mnemonic
 * 2. Uploads updated lending WASM with protocol fee support
 * 3. Instantiates new lending contract with fee_collector = keeper
 * 4. Updates LP pool fee_collector to keeper address
 * 5. Updates staking contract keeper + treasury to keeper address
 * 6. Writes updated addresses to backend/.env and deployments/testnet.json
 */
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import * as dotenv from "dotenv";

// Read from backend/.env which has actual testnet config + keeper mnemonic
dotenv.config({ path: resolve(import.meta.dirname, "../../backend/.env") });

const ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS = resolve(ROOT, "artifacts");

// ------- Config -------
const RPC_URL = process.env.INITIA_RPC_URL || "https://rpc-wasm-1.anvil.asia-southeast.initia.xyz";
const CHAIN_ID = process.env.CHAIN_ID || "wasm-1";
// Deployer and keeper are the same wallet
const DEPLOYER_MNEMONIC = process.env.KEEPER_WALLET_MNEMONIC;
const DENOM = process.env.NATIVE_DENOM || "l2/8b3e1fc559b327a35335e3f26ff657eaee5ff8486ccd3c1bc59007a93cf23156";
const GAS_PRICE_STR = `0.15${DENOM}`;
const PREFIX = "init";

// Existing contract addresses from current deployment
const EXISTING = {
  initxToken: process.env.INITX_TOKEN_ADDRESS || "",
  staking: process.env.STAKING_ADDRESS || "",
  lpPool: process.env.LP_POOL_ADDRESS || "",
  lending: process.env.LENDING_ADDRESS || "",
  governance: process.env.GOVERNANCE_ADDRESS || "",
};

if (!DEPLOYER_MNEMONIC) {
  console.error("ERROR: KEEPER_WALLET_MNEMONIC not set in backend/.env");
  process.exit(1);
}

async function getClient(mnemonic: string) {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE_STR),
  });
  return { client, address: account.address };
}

async function migrate() {
  const { client: deployerClient, address: deployer } = await getClient(DEPLOYER_MNEMONIC!);

  // Deployer and keeper are the same wallet
  const keeperAddress = deployer;

  console.log(`Deployer:  ${deployer}`);
  console.log(`Keeper:    ${keeperAddress}`);
  console.log(`Chain:     ${CHAIN_ID}`);
  console.log(`RPC:       ${RPC_URL}`);
  console.log(`Denom:     ${DENOM}`);
  console.log();

  const balance = await deployerClient.getBalance(deployer, DENOM);
  console.log(`Deployer balance: ${balance.amount} ${DENOM}\n`);

  // Step 1: Upload updated lending WASM
  console.log("=== Step 1: Upload updated lending contract ===\n");
  const lendingWasm = readFileSync(resolve(ARTIFACTS, "lending.wasm"));
  console.log(`Uploading lending.wasm (${(lendingWasm.length / 1024).toFixed(1)} KB)...`);
  const uploadRes = await deployerClient.upload(deployer, lendingWasm, "auto");
  console.log(`  ✓ New code ID: ${uploadRes.codeId}\n`);

  // Step 2: Instantiate new lending contract with protocol fee support
  console.log("=== Step 2: Instantiate new lending contract ===\n");
  const lendingInitMsg = {
    init_denom: DENOM,
    initx_token: EXISTING.initxToken,
    lp_pool: EXISTING.lpPool,
    collateral_factor: "0.7",
    liquidation_threshold: "0.8",
    liquidation_bonus: "0.05",
    borrow_rate: "0.05",
    protocol_fee_bps: 1000,  // 10% of interest goes to protocol
    fee_collector: keeperAddress,
  };
  console.log("Instantiating with:", JSON.stringify(lendingInitMsg, null, 2));
  const lendingRes = await deployerClient.instantiate(
    deployer,
    uploadRes.codeId,
    lendingInitMsg,
    "INITx Lending v2 (Real Yield)",
    "auto",
  );
  const newLendingAddress = lendingRes.contractAddress;
  console.log(`  ✓ New lending address: ${newLendingAddress}\n`);

  // Step 3: Update LP pool fee_collector to keeper address
  console.log("=== Step 3: Update LP pool fee_collector ===\n");
  try {
    const lpUpdateRes = await deployerClient.execute(
      deployer,
      EXISTING.lpPool,
      { update_config: { fee_collector: keeperAddress } },
      "auto",
    );
    console.log(`  ✓ LP pool fee_collector updated to ${keeperAddress}`);
    console.log(`    tx: ${lpUpdateRes.transactionHash}\n`);
  } catch (err: any) {
    console.warn(`  ⚠ LP pool update failed: ${err.message}`);
    console.warn("    (You may need to do this manually if deployer is not admin)\n");
  }

  // Step 4: Update staking contract keeper + treasury
  console.log("=== Step 4: Update staking contract keeper & treasury ===\n");
  try {
    const stakingUpdateRes = await deployerClient.execute(
      deployer,
      EXISTING.staking,
      { update_config: { keeper: keeperAddress, treasury: keeperAddress } },
      "auto",
    );
    console.log(`  ✓ Staking keeper & treasury updated to ${keeperAddress}`);
    console.log(`    tx: ${stakingUpdateRes.transactionHash}\n`);
  } catch (err: any) {
    console.warn(`  ⚠ Staking update failed: ${err.message}`);
    console.warn("    (You may need to do this manually if deployer is not admin)\n");
  }

  // Step 5: Write updated config files
  console.log("=== Step 5: Write updated config ===\n");

  // Update backend .env
  const backendEnv = `PORT=3001
INITIA_RPC_URL=${RPC_URL}
INITIA_REST_URL=${process.env.INITIA_REST_URL || "https://rest-wasm-1.anvil.asia-southeast.initia.xyz"}
CHAIN_ID=${CHAIN_ID}
NATIVE_DENOM=${DENOM}
STAKING_ADDRESS=${EXISTING.staking}
INITX_TOKEN_ADDRESS=${EXISTING.initxToken}
LP_POOL_ADDRESS=${EXISTING.lpPool}
LENDING_ADDRESS=${newLendingAddress}
GOVERNANCE_ADDRESS=${EXISTING.governance}
KEEPER_WALLET_MNEMONIC=${DEPLOYER_MNEMONIC}
KEEPER_INTERVAL_MS=3600000
HARVEST_ENABLED=true
MIN_HARVEST_THRESHOLD=1000
`;
  writeFileSync(resolve(ROOT, "backend/.env"), backendEnv);
  console.log("  ✓ backend/.env updated\n");

  // Update deployments/testnet.json
  const deploymentsPath = resolve(ROOT, "deployments/testnet.json");
  let deployments: any = {};
  try {
    deployments = JSON.parse(readFileSync(deploymentsPath, "utf-8"));
  } catch {}

  deployments.shared_testnet = {
    ...deployments.shared_testnet,
    chain_id: CHAIN_ID,
    rpc: RPC_URL,
    denom: DENOM,
    deployer,
    keeper: keeperAddress,
    contracts: {
      initx_token: { code_id: deployments.shared_testnet?.contracts?.initx_token?.code_id, address: EXISTING.initxToken },
      staking: { code_id: deployments.shared_testnet?.contracts?.staking?.code_id, address: EXISTING.staking },
      lp_pool: { code_id: deployments.shared_testnet?.contracts?.lp_pool?.code_id, address: EXISTING.lpPool },
      lending: { code_id: uploadRes.codeId, address: newLendingAddress },
      governance: { code_id: deployments.shared_testnet?.contracts?.governance?.code_id, address: EXISTING.governance },
    },
    deployed_at: new Date().toISOString(),
    note: "v3 deployment - Real yield model with protocol fee harvesting",
  };
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("  ✓ deployments/testnet.json updated\n");

  console.log("=== Migration Complete ===\n");
  console.log("New lending contract:", newLendingAddress);
  console.log("Keeper/fee_collector:", keeperAddress);
  console.log("\nNext steps:");
  console.log("1. Start backend with: cd backend && npm run dev");
  console.log("2. Keeper will harvest real fees every 1 hour");
  console.log("3. Generate activity (borrows, swaps) to accrue fees");
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
