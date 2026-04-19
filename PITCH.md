# INITx Protocol — Hackathon Pitch

## INITIATE Hackathon Submission | DoraHacks

---

## One-Liner

**INITx is a full liquid staking protocol for Initia that lets users stake INIT, receive a yield-bearing INITx token, and use it across DeFi — swapping, providing liquidity, borrowing against it, and governing the protocol — all on a dedicated MiniWasm rollup.**

---

## The Problem

Staking on proof-of-stake chains locks capital. Users must choose between earning staking yield and participating in DeFi. This is a $50B+ problem across the industry — and Initia's modular L1/L2 architecture makes it an ideal platform for a liquid staking solution that spans the ecosystem.

**Specific pain points:**
- Staked INIT is illiquid — no composability with DeFi
- Unbonding periods (7+ days on testnet) create opportunity cost
- No unified protocol lets users stake, swap, lend, and govern with a single derivative token

---

## The Solution: INITx Protocol

INITx is a **5-contract DeFi protocol** deployed on a MiniWasm rollup that creates a liquid staking derivative (INITx) and builds an entire DeFi ecosystem around it.

### How It Works

1. **Stake INIT → Get INITx**: Deposit native INIT into the staking contract. Receive INITx (CW20) at the current exchange rate.
2. **Exchange rate grows over time**: A keeper adds staking rewards. 90% accrues to stakers (raising the INITx:INIT rate), 10% goes to the protocol treasury.
3. **Use INITx in DeFi**:
   - **Swap** INITx ↔ INIT on the built-in AMM (Uniswap v2 constant-product, 0.3% fee)
   - **Provide liquidity** to the INIT/INITx pool and earn swap fees
   - **Borrow** INIT against INITx collateral (70% collateral factor, 80% liquidation threshold)
   - **Govern** the protocol by depositing INITx to create proposals and vote with INITx-weighted power
4. **Unstake anytime**: Send INITx back to the staking contract. If there's sufficient liquidity buffer, get INIT back instantly. Otherwise, wait for the cooldown period.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   INITx Protocol                     │
│                  (MiniWasm Rollup)                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  INITx   │  │ Staking  │  │     LP Pool      │   │
│  │  Token   │◄─┤ Contract ├──┤  (INIT/INITx AMM)│   │
│  │  (CW20)  │  │          │  │                   │   │
│  └────┬─────┘  └──────────┘  └──────────────────┘   │
│       │                                              │
│  ┌────▼─────┐  ┌──────────────────┐                  │
│  │ Lending  │  │   Governance     │                  │
│  │ Protocol │  │ (INITx-weighted) │                  │
│  └──────────┘  └──────────────────┘                  │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Node.js/Fastify Backend (Keeper, API, Stats)│    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Next.js 14 Frontend + InterwovenKit Wallet  │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Smart Contracts (5 total, 58 unit tests)

| Contract | Purpose | Key Features |
|----------|---------|--------------|
| **INITx Token** | CW20 liquid staking derivative | Minter-restricted, library feature for cross-contract safety |
| **Staking** | Core yield engine | Deposit/withdraw, exchange rate, keeper rewards (90/10 split), pause/unpause, slashing |
| **LP Pool** | Uniswap v2 AMM | Constant-product INIT/INITx pair, 0.3% swap fee, slippage protection |
| **Lending** | Collateralized borrowing | INITx collateral → borrow INIT, 70% CF, 80% LT, 5% liquidation bonus |
| **Governance** | Protocol governance | Proposal creation via INITx deposit, INITx-weighted voting |

---

## Initia-Native Features

### MiniWasm Rollup
INITx runs on its own dedicated MiniWasm rollup (CosmWasm VM), demonstrating Initia's modular rollup architecture where each application can have its own optimized execution environment.

### InterwovenKit Integration
The frontend uses InterwovenKit for seamless wallet connection across the Initia ecosystem, providing a native user experience.

### Initia Usernames
The UI resolves and displays Initia Usernames, making the protocol more human-friendly and leveraging Initia's native identity layer.

---

## Technical Highlights

- **Built from scratch** in Rust/CosmWasm — not a fork, designed specifically for Initia's architecture
- **CW20 Send pattern** for composable contract interactions (deposit collateral, create proposals, request withdrawals — all via token sends with embedded messages)
- **Simulated yield model** adapted for MiniWasm rollups where native PoS delegation isn't available at L2
- **58 unit tests** covering all contract logic
- **Full E2E tested** on both local rollup and shared MiniWasm testnet (wasm-1)
- **Publicly verifiable** — contracts deployed on shared testnet with explorer links

---

## Deployed Contracts (Shared Testnet — wasm-1)

All contracts are live and publicly verifiable on [Initia Scan](https://scan.testnet.initia.xyz/wasm-1):

| Contract | Code ID | Address |
|----------|---------|---------|
| INITx Token | 102 | `init1w00wxdjvxh8mjydrdqz3lms82mzyylj9zqvh2pex76m590p0x3zq4lct6n` |
| Staking | 103 | `init1ymwhjj8nz5zq05umqegztusnx8hlpjfq2ke99wejt8srllhr79ssu3x8va` |
| LP Pool | 104 | `init10junhyk52wr3dez5ygrkhngcr9l7skvxwc9s8ul55nastlagwc0s7y0pn4` |
| Lending | 105 | `init1676c93uz9dcxy2cfr9nmfn4ductemgc4akasgv6cauvjqmmy3rcs7hup4p` |
| Governance | 106 | `init1xxzsac5hwmaq2fq5wja4s03qkc6frg77n4gexcu2me7c9y2pz8qsyk4xhq` |

---

## Stack

| Layer | Technology |
|-------|------------|
| Smart Contracts | Rust, CosmWasm 2.x, cw20 2.0 |
| Blockchain | Initia MiniWasm Rollup |
| Backend | Node.js, Fastify, CosmJS |
| Frontend | Next.js 14 (App Router), TypeScript, Tailwind CSS |
| Wallet | InterwovenKit (Initia native) |
| Testing | 58 unit tests + full E2E on testnet |

---

## What Makes INITx Different

1. **Complete DeFi stack, not just staking.** Most liquid staking protocols stop at the derivative token. INITx ships with a built-in AMM, lending market, and governance — a full ecosystem from day one.

2. **Purpose-built for Initia.** Designed around Initia's modular architecture — runs on a dedicated MiniWasm rollup, uses InterwovenKit, and integrates Initia Usernames.

3. **Fully functional MVP.** Not a whitepaper or mock-up. Five deployed contracts, a working backend, and a complete frontend — all E2E tested on public testnet.

---

## Roadmap (Post-Hackathon)

- **IBC integration**: Bridge INITx across Initia L1 and other rollups via OPinit
- **Real validator delegation**: Integrate with Initia L1 staking via IBC when cross-layer staking is supported
- **Auto-compounding**: Keeper bot automatically compounds staking rewards
- **Liquidation bot**: Automated liquidation for undercollateralized lending positions
- **Multi-collateral lending**: Accept LP tokens and other assets as collateral
- **Mainnet deployment**: Launch on Initia mainnet

---



## Links

- **Explorer (wasm-1):** https://scan.testnet.initia.xyz/wasm-1
- **GitHub:** *(to be added)*
- **Demo Video:** *(to be recorded)*
