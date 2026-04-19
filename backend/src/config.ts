import "dotenv/config";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${key}`);
  return v;
}

export const config = {
  port: parseInt(env("PORT", "3001"), 10),
  rpcUrl: env("INITIA_RPC_URL", "http://localhost:26657"),
  restUrl: env("INITIA_REST_URL", "http://localhost:1317"),
  wsUrl: env("INITIA_WS_URL", env("INITIA_RPC_URL", "http://localhost:26657").replace("http", "ws") + "/websocket"),
  chainId: env("CHAIN_ID", "initx-1"),
  denom: env("NATIVE_DENOM", "umin"),

  // Contract addresses
  stakingAddress: env("STAKING_ADDRESS", ""),
  initxTokenAddress: env("INITX_TOKEN_ADDRESS", ""),
  lpPoolAddress: env("LP_POOL_ADDRESS", ""),
  lendingAddress: env("LENDING_ADDRESS", ""),
  governanceAddress: env("GOVERNANCE_ADDRESS", ""),

  // Keeper
  keeperMnemonic: env("KEEPER_WALLET_MNEMONIC", ""),
  keeperIntervalMs: parseInt(env("KEEPER_INTERVAL_MS", String(10 * 60 * 1000)), 10), // default 10 min
  harvestEnabled: env("HARVEST_ENABLED", "true") === "true",
  minHarvestThreshold: env("MIN_HARVEST_THRESHOLD", "1"),

  // MongoDB
  mongoUri: env("MONGO_URI", ""),

  // CoinGecko
  coingeckoApiUrl: env("COINGECKO_API_URL", "https://api.coingecko.com/api/v3"),
  initCoinId: env("INIT_COIN_ID", "initia"),

  // Oracle update interval (ms)
  oracleIntervalMs: parseInt(env("ORACLE_INTERVAL_MS", String(5 * 60 * 1000)), 10), // 5 min

  // Snapshot interval (ms)
  snapshotIntervalMs: parseInt(env("SNAPSHOT_INTERVAL_MS", String(5 * 60 * 1000)), 10), // 5 min

  // Liquidation scan interval (ms) — increased to 120s to reduce RPC pressure
  liquidationIntervalMs: parseInt(env("LIQUIDATION_INTERVAL_MS", String(120 * 1000)), 10), // 120s

  // Risk engine interval (ms) — increased to 180s to reduce RPC pressure
  riskIntervalMs: parseInt(env("RISK_INTERVAL_MS", String(180 * 1000)), 10), // 180s

  // Slack/Discord webhook for alerts (optional)
  alertWebhookUrl: env("ALERT_WEBHOOK_URL", ""),

  // L1 staking (initiation-2)
  l1RpcUrl: env("L1_RPC_URL", "https://rpc.testnet.initia.xyz/"),
  l1RestUrl: env("L1_REST_URL", "https://rest.testnet.initia.xyz"),
  l1ChainId: env("L1_CHAIN_ID", "initiation-2"),
  l1Denom: env("L1_DENOM", "uinit"),
  l1ValidatorAddress: env("L1_VALIDATOR_ADDRESS", ""),
  l1StakingEnabled: env("L1_STAKING_ENABLED", "false") === "true",
  liquidityBufferBps: parseInt(env("LIQUIDITY_BUFFER_BPS", "2000"), 10),
  l1InitialDelegateAmount: parseInt(env("L1_INITIAL_DELEGATE_AMOUNT", "15000000"), 10),
  // IBC channel from L1 → wasm-1
  l1ToWasm1Channel: env("L1_TO_WASM1_CHANNEL", "channel-3073"),
};
