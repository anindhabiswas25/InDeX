/**
 * INITx Protocol — Full redeploy to shared testnet (Real Yield v3)
 *
 * Deploys all 5 contracts from the keeper wallet so it has admin on everything.
 * Sets keeper wallet as fee_collector on LP pool and lending, and as keeper/treasury on staking.
 */
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { GasPrice } from "@cosmjs/stargate";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(import.meta.dirname, "../../backend/.env") });

const ROOT = resolve(import.meta.dirname, "../..");
const ARTIFACTS = resolve(ROOT, "artifacts");

const RPC_URL = process.env.INITIA_RPC_URL || "https://rpc-wasm-1.anvil.asia-southeast.initia.xyz";
const REST_URL = process.env.INITIA_REST_URL || "https://rest-wasm-1.anvil.asia-southeast.initia.xyz";
const CHAIN_ID = process.env.CHAIN_ID || "wasm-1";
const MNEMONIC = process.env.KEEPER_WALLET_MNEMONIC;
const DENOM = process.env.NATIVE_DENOM || "l2/8b3e1fc559b327a35335e3f26ff657eaee5ff8486ccd3c1bc59007a93cf23156";
const GAS_PRICE_STR = `0.15${DENOM}`;
const PREFIX = "init";

if (!MNEMONIC) {
  console.error("ERROR: KEEPER_WALLET_MNEMONIC not set in backend/.env");
  process.exit(1);
}

async function getClient() {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC!, { prefix: PREFIX });
  const [account] = await wallet.getAccounts();
  const client = await SigningCosmWasmClient.connectWithSigner(RPC_URL, wallet, {
    gasPrice: GasPrice.fromString(GAS_PRICE_STR),
  });
  return { client, address: account.address };
}

async function upload(client: SigningCosmWasmClient, sender: string, name: string): Promise<number> {
  const wasmPath = resolve(ARTIFACTS, `${name.replace(/-/g, "_")}.wasm`);
  if (!existsSync(wasmPath)) throw new Error(`WASM not found: ${wasmPath}`);
  const wasm = readFileSync(wasmPath);
  console.log(`  Uploading ${name} (${(wasm.length / 1024).toFixed(1)} KB)...`);
  const result = await client.upload(sender, wasm, "auto");
  console.log(`    ✓ Code ID: ${result.codeId}`);
  return result.codeId;
}

async function inst(
  client: SigningCosmWasmClient, sender: string,
  codeId: number, label: string, msg: Record<string, unknown>,
  funds: { denom: string; amount: string }[] = []
): Promise<string> {
  console.log(`  Instantiating ${label}...`);
  const result = await client.instantiate(sender, codeId, msg, label, "auto", { funds });
  console.log(`    ✓ ${result.contractAddress}`);
  return result.contractAddress;
}

async function deploy() {
  const { client, address: admin } = await getClient();

  console.log(`Deployer/Keeper: ${admin}`);
  console.log(`Chain: ${CHAIN_ID}  RPC: ${RPC_URL}`);
  const bal = await client.getBalance(admin, DENOM);
  console.log(`Balance: ${bal.amount} ${DENOM}\n`);

  // Step 1: Upload WASMs (reuse already-uploaded code IDs to save gas)
  console.log("=== Step 1: Upload contracts ===\n");

  const codeIds = {
    initxToken: await upload(client, admin, "initx-token"),
    staking: await upload(client, admin, "staking"),
    lpPool: await upload(client, admin, "lp-pool"),
    lending: await upload(client, admin, "lending"),
    governance: await upload(client, admin, "governance"),
  };
  console.log("\nCode IDs:", codeIds, "\n");

  // Step 2: Instantiate initx-token (admin as temp minter)
  console.log("=== Step 2: Instantiate contracts ===\n");

  const initxToken = await inst(client, admin, codeIds.initxToken, "INITx Token v3", {
    name: "INITx",
    symbol: "INITx",
    decimals: 6,
    minter: null, // will be set to staking via set_minter
  });

  // Step 3: Instantiate staking (keeper + treasury = admin)
  const staking = await inst(client, admin, codeIds.staking, "INITx Staking v3", {
    initx_token: initxToken,
    treasury: admin,
    keeper: admin,
    init_denom: DENOM,
    protocol_fee_bps: 1000,
    cooldown_period: 60, // 60s for testing (normally 21 days)
    validator: "initvaloper1placeholder", // placeholder, liquid staking not used on this testnet
    buffer_percentage_bps: 1000,
  });

  // Step 4: Set minter to staking contract
  console.log("  Setting minter on INITx token to staking...");
  await client.execute(admin, initxToken, { set_minter: { minter: staking } }, "auto");
  console.log("    ✓ Minter set\n");

  // Step 5: Instantiate LP pool (fee_collector = admin/keeper)
  const lpPool = await inst(client, admin, codeIds.lpPool, "INITx LP Pool v3", {
    init_denom: DENOM,
    initx_token: initxToken,
    swap_fee_bps: 30,
    protocol_fee_bps: 1667,
    fee_collector: admin,
  });

  // Step 6: Instantiate lending (fee_collector = admin/keeper)
  const lending = await inst(client, admin, codeIds.lending, "INITx Lending v3", {
    init_denom: DENOM,
    initx_token: initxToken,
    lp_pool: lpPool,
    collateral_factor: "0.7",
    liquidation_threshold: "0.8",
    liquidation_bonus: "0.05",
    borrow_rate: "0.05",
    protocol_fee_bps: 1000,
    fee_collector: admin,
  });

  // Step 7: Instantiate governance
  const governance = await inst(client, admin, codeIds.governance, "INITx Governance v3", {
    initx_token: initxToken,
    voting_period: 259200,
    quorum: "0.1",
    threshold: "0.5",
    proposal_deposit: "1000000000",
  });

  console.log("\n=== Step 3: Seed LP pool with initial liquidity ===\n");

  // Mint some INITx via staking (deposit INIT → get INITx)
  const depositAmount = "200000"; // 0.2 INIT
  console.log(`  Depositing ${depositAmount} ${DENOM} to staking for INITx...`);
  const depositRes = await client.execute(admin, staking, { deposit: {} }, "auto", undefined, [
    { denom: DENOM, amount: depositAmount },
  ]);
  console.log(`    ✓ Deposited, tx: ${depositRes.transactionHash}`);

  // Check INITx balance
  const initxBal = await client.queryContractSmart(initxToken, { balance: { address: admin } });
  console.log(`    INITx balance: ${initxBal.balance}`);

  // Add liquidity to LP pool (two-step: CW20 Send does NOT forward native funds)
  if (BigInt(initxBal.balance) > 0n) {
    const lpInitAmount = "100000"; // 0.1 INIT
    const lpInitxAmount = String(Math.min(Number(initxBal.balance), 100000));

    // Step A: Bank-send INIT directly to LP pool contract
    console.log(`  Sending ${lpInitAmount} INIT to LP pool contract...`);
    const sendRes = await client.sendTokens(admin, lpPool, [{ denom: DENOM, amount: lpInitAmount }], "auto");
    console.log(`    ✓ INIT sent, tx: ${sendRes.transactionHash}`);

    // Step B: CW20 Send INITx with AddLiquidity hook (LP pool detects INIT via balance diff)
    console.log(`  Sending ${lpInitxAmount} INITx via CW20 Send with AddLiquidity hook...`);
    const addLiqMsg = Buffer.from(JSON.stringify({ add_liquidity: {} })).toString("base64");
    const addLiqRes = await client.execute(
      admin,
      initxToken,
      {
        send: {
          contract: lpPool,
          amount: lpInitxAmount,
          msg: addLiqMsg,
        },
      },
      "auto",
    );
    console.log(`    ✓ Liquidity added, tx: ${addLiqRes.transactionHash}`);
  }

  // Write config files
  console.log("\n=== Step 4: Write config ===\n");

  const backendEnv = `PORT=3001
INITIA_RPC_URL=${RPC_URL}
INITIA_REST_URL=${REST_URL}
CHAIN_ID=${CHAIN_ID}
NATIVE_DENOM=${DENOM}
STAKING_ADDRESS=${staking}
INITX_TOKEN_ADDRESS=${initxToken}
LP_POOL_ADDRESS=${lpPool}
LENDING_ADDRESS=${lending}
GOVERNANCE_ADDRESS=${governance}
KEEPER_WALLET_MNEMONIC=${MNEMONIC}
KEEPER_INTERVAL_MS=3600000
HARVEST_ENABLED=true
MIN_HARVEST_THRESHOLD=1000
`;
  writeFileSync(resolve(ROOT, "backend/.env"), backendEnv);
  console.log("  ✓ backend/.env updated");

  const frontendEnv = `NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_STAKING_CONTRACT=${staking}
NEXT_PUBLIC_SWAP_CONTRACT=${lpPool}
NEXT_PUBLIC_LIQUIDITY_CONTRACT=${lpPool}
NEXT_PUBLIC_LENDING_CONTRACT=${lending}
NEXT_PUBLIC_GOVERNANCE_CONTRACT=${governance}
NEXT_PUBLIC_INITX_TOKEN=${initxToken}
NEXT_PUBLIC_CHAIN_ID=${CHAIN_ID}
NEXT_PUBLIC_RPC_URL=${RPC_URL}
NEXT_PUBLIC_NATIVE_DENOM=${DENOM}
`;
  writeFileSync(resolve(ROOT, "frontend/.env.local"), frontendEnv);
  console.log("  ✓ frontend/.env.local updated");

  const deploymentsPath = resolve(ROOT, "deployments/testnet.json");
  let deployments: any = {};
  try { deployments = JSON.parse(readFileSync(deploymentsPath, "utf-8")); } catch {}

  deployments.shared_testnet = {
    chain_id: CHAIN_ID,
    rpc: RPC_URL,
    lcd: REST_URL,
    denom: DENOM,
    explorer: "https://scan.testnet.initia.xyz/wasm-1",
    deployer: admin,
    keeper: admin,
    contracts: {
      initx_token: { code_id: codeIds.initxToken, address: initxToken },
      staking: { code_id: codeIds.staking, address: staking },
      lp_pool: { code_id: codeIds.lpPool, address: lpPool },
      lending: { code_id: codeIds.lending, address: lending },
      governance: { code_id: codeIds.governance, address: governance },
    },
    deployed_at: new Date().toISOString(),
    note: "v3 deployment - Real yield model, all contracts admin = keeper wallet",
  };
  writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("  ✓ deployments/testnet.json updated");

  console.log("\n=== Deployment Complete ===\n");
  console.log("Contracts:");
  console.log(`  INITx Token:  ${initxToken}`);
  console.log(`  Staking:      ${staking}`);
  console.log(`  LP Pool:      ${lpPool}`);
  console.log(`  Lending:      ${lending}`);
  console.log(`  Governance:   ${governance}`);
  console.log(`\nAdmin/Keeper:   ${admin}`);
}

deploy().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
