export const contracts = {
  staking: process.env.NEXT_PUBLIC_STAKING_CONTRACT || "",
  swap: process.env.NEXT_PUBLIC_SWAP_CONTRACT || "",
  liquidity: process.env.NEXT_PUBLIC_LIQUIDITY_CONTRACT || "",
  lending: process.env.NEXT_PUBLIC_LENDING_CONTRACT || "",
  governance: process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT || "",
  initxToken: process.env.NEXT_PUBLIC_INITX_TOKEN || "",
} as const;

export const chainConfig = {
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID || "initia-testnet-1",
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.testnet.initia.xyz",
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001",
  nativeDenom: process.env.NEXT_PUBLIC_NATIVE_DENOM || "umin",
} as const;

export const l1Config = {
  chainId: "initiation-2",
  rpcUrl: "https://rpc.testnet.initia.xyz",
  denom: "uinit",
  bridgeId: 1457,
} as const;
