<div align="center">
<p align="center">
  <img src="https://github.com/user-attachments/assets/58e3bdf1-312e-471b-8f89-17b5c6621ac2" width="800"/>
</p>


<img src="https://img.shields.io/badge/Initia-L1%20%2B%20MiniWasm%20Rollup-6366f1?style=for-the-badge" />
<img src="https://img.shields.io/badge/CosmWasm-2.x-orange?style=for-the-badge" />
<img src="https://img.shields.io/badge/Rust-1.70%2B-red?style=for-the-badge" />
<img src="https://img.shields.io/badge/Tests-58%20Passing-brightgreen?style=for-the-badge" />
<img src="https://img.shields.io/badge/Status-Live%20on%20Testnet-blue?style=for-the-badge" />

# InDeX

### Unified DeFi on Initia — Stake, Lend, Swap, Govern. All in One Protocol.

**Stake INIT → Receive INITx → Earn Real L1 Staking Yield — While Staying Liquid**

[Live App](https://index-3mc4.onrender.com) · [Explorer](https://scan.initia.xyz/wasm-1) · [GitHub](https://github.com/anindhabiswas25/InDeX) · [Contracts](#-deployed-contracts) · [Architecture](#-architecture) · [Quick Start](#-quick-start)

</div>

---

## Table of Contents

- [Overview](#-overview)
- [Why Initia Needs INITx](#-why-initia-needs-initx)
- [How It Works](#-how-it-works)
- [Architecture](#-architecture)
- [L1 ↔ Rollup Integration Deep Dive](#-l1--rollup-integration-deep-dive)
- [Smart Contracts](#-smart-contracts)
- [Project Structure](#-project-structure)
- [Deployed Contracts](#-deployed-contracts)
- [Backend & Keeper Bot](#-backend--keeper-bot)
- [API Reference](#-api-reference)
- [Frontend](#-frontend)
- [Quick Start](#-quick-start)
- [Testing](#-testing)
- [Security Notes](#-security-notes)
- [Roadmap](#-roadmap)

---

## 📌 Overview

InDeX is a **production-grade unified DeFi protocol** purpose-built for Initia's modular L1 + MiniWasm rollup architecture. It solves the fundamental DeFi dilemma: *you should never have to choose between earning staking yield and using your capital in DeFi*.

Users deposit native INIT tokens and receive **INITx** — a CW20 yield-bearing derivative token. The exchange rate between INITx and INIT grows continuously as the keeper bot:

1. Delegates INIT to real validators on **Initia L1** (`initiation-2`)
2. Claims live **PoS staking rewards** from those validators
3. Bridges the claimed INIT back to the **MiniWasm rollup** via IBC
4. Calls `AddRewards` on the staking contract, permanently raising the exchange rate

Beyond staking, INITx can be **swapped**, used to **provide liquidity**, **borrowed against**, and used to **govern** the protocol — an entire DeFi ecosystem in a single protocol.

---

## 🧩 Why Initia Needs InDeX

### The Problem with Staking on Modular Chains

Initia's architecture is unique: applications live on **specialized rollups** (MiniEVM, MiniWasm, MiniMove) while security and consensus are provided by the **Initia L1**. This creates a liquidity fragmentation problem — users must choose between earning staking yield on L1 or participating in rollup DeFi. They cannot do both.

```
Initia L1 (initiation-2)
├── Native INIT token
├── PoS staking: validators earn ~15-20% APY on INIT
└── Capital locked during 21-day unbonding periods

MiniWasm Rollup (wasm-1)
├── CosmWasm DeFi ecosystem
├── AMMs, lending protocols, governance
└── No direct access to L1 staking rewards
```

**Users who want to participate in wasm-1 DeFi must choose:**
- ✗ Keep INIT staked on L1 → earn yield but lose DeFi composability
- ✗ Unstake to wasm-1 → participate in DeFi but lose all staking yield

### InDeX Solves This With a Cross-Layer Yield Bridge

```
Initia L1 (initiation-2)          MiniWasm Rollup (wasm-1)
┌─────────────────────┐           ┌──────────────────────────┐
│  Keeper Wallet      │           │  INITx Protocol          │
│  Delegated: 15 INIT │──IBC──►  │  INITx token: yield +    │
│  Validator: Chorus1 │  bridge   │  composability           │
│  Rewards: ~15% APY  │◄──────── │  AMM / Lending / Gov     │
└─────────────────────┘  claim   └──────────────────────────┘
```

InDeX enables:
- **L1 staking yield** flowing into a rollup DeFi ecosystem — permissionlessly
- **Liquid capital** — users hold INITx, which can be traded or used as collateral at any time
- **Composable yield** — the yield-bearing token plugs natively into any CosmWasm DeFi primitive
- **A template** for cross-layer yield aggregation across Initia's entire rollup ecosystem

### Why This Matters for Initia's Ecosystem

| Without InDeX | With InDeX |
|---|---|
| INIT stakers have no DeFi access | INITx holders access full DeFi stack |
| Capital efficiency ~50% (stake or DeFi) | Capital efficiency ~100% (stake AND DeFi) |
| No cross-layer yield primitives | Cross-layer yield bridge via IBC |
| Rollup TVL starved of staking capital | Rollup TVL benefits from L1 security yield |

---

## ⚙️ How It Works

### 1. Staking & INITx Minting

```
User deposits 100 INIT
   │
   ▼
Staking Contract
   ├── Exchange rate = total_init_staked / total_initx_supply
   ├── Mint INITx = deposit_amount / exchange_rate
   └── User receives INITx tokens
```

When you deposit, you receive INITx at the **current exchange rate**. The rate starts at `1.0` and only ever goes up.

**Exchange rate formula:**
```
exchange_rate = total_init_staked / total_initx_supply
```

| Day | Total INIT Staked | Total INITx Supply | Exchange Rate | Your 100 INIT worth |
|-----|------------------:|-------------------:|:-------------:|--------------------:|
| 0   | 1,000             | 1,000              | 1.000000      | 100 INITx           |
| 30  | 1,045             | 1,000              | 1.045000      | 100 INITx → 104.5 INIT |
| 90  | 1,138             | 1,000              | 1.138000      | 100 INITx → 113.8 INIT |
| 365 | ~1,150            | 1,000              | ~1.150+       | 100 INITx → 115+ INIT  |

### 2. Real Yield: L1 Staking Rewards Cycle

This is the core innovation. Every 10 minutes, the keeper bot executes a full harvest cycle:

```
Step 1  ─  Collect LP pool swap fees (INIT + INITx)
Step 2  ─  Collect lending protocol interest fees
Step 3  ─  Swap harvested INITx → INIT via AMM
Step 4  ─  Check keeper wallet for IBC-bridged uinit (landed from L1)
Step 5  ─  Call AddRewards(total) → exchange rate rises permanently
Step 6  ─  Recycle treasury balance via AddRewards
Step 7  ─  Claim L1 staking rewards (MsgWithdrawDelegatorReward on initiation-2)
Step 8  ─  Bridge claimed uinit → wasm-1 via IBC channel-3073 (~2-5 min transit)
Step 9  ─  Snapshot exchange rate to MongoDB
```

### 3. Withdrawal

| Type | When Available | Wait Time |
|------|---------------|-----------|
| **Instant** | Liquidity buffer ≥ withdrawal amount | 0 seconds |
| **Queued** | Buffer insufficient | Unbonding period (7d testnet / 21d mainnet) |

The protocol maintains a **20% liquidity buffer** (configurable) for instant withdrawals, delegating only the surplus 80% to L1.

### 4. DeFi Composability

Once you hold INITx, the protocol gives you four ways to use it:

#### AMM (LP Pool)
- Constant-product `x·y = k` formula (Uniswap v2)
- **0.3% swap fee** accrues to liquidity providers
- Swap INITx ↔ INIT instantly without unbonding
- Add/remove liquidity to earn swap fees

#### Lending
- Deposit INITx as collateral → borrow INIT
- **70% Collateral Factor** — borrow up to 70% of collateral value
- **80% Liquidation Threshold** — positions below this are liquidatable
- **5% Liquidation Bonus** — incentive for liquidators
- **5% annual interest rate** — accrues per block
- Health factor = `(collateral × LT) / debt`

#### Governance
- Any INITx holder can create a proposal (minimum deposit required)
- **Voting power = INITx balance** at vote time
- Proposal passes if: quorum ≥ 10% AND yes votes > 50%
- Passed proposals are executed on-chain

---

## 🏗 Architecture

### System Architecture Diagram

```
╔══════════════════════════════════════════════════════════════════════╗
║                         INITIA L1 (initiation-2)                     ║
║                                                                      ║
║   ┌─────────────────────────────────────────────────────────────┐   ║
║   │  Keeper Wallet                                              │   ║
║   │                                                             │   ║
║   │  Delegated INIT ──► Chorus One Validator                    │   ║
║   │                         │                                   │   ║
║   │              ~15% APY PoS Rewards                           │   ║
║   │                         │                                   │   ║
║   │  MsgWithdrawDelegatorReward ◄────────────────────────────   │   ║
║   │                         │                                   │   ║
║   │  Claimed uinit ─────────────► IBC MsgTransfer               │   ║
║   └─────────────────────────────────┼───────────────────────────┘   ║
╚══════════════════════════════════════╪═══════════════════════════════╝
                                       │  IBC channel-3073
                                       │  (~2-5 min transit)
╔══════════════════════════════════════╪═══════════════════════════════╗
║          MINIWASM ROLLUP (wasm-1)    │                               ║
║                                      ▼                               ║
║   ┌──────────────────────────────────────────────────────────────┐  ║
║   │  Keeper Bot (Node.js)                                        │  ║
║   │                                                              │  ║
║   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │  ║
║   │  │ feeHarvester│  │l1Staking    │  │ rewardEngine        │  │  ║
║   │  │             │  │Harvester    │  │ (snapshots / APY)   │  │  ║
║   │  │ LP fees +   │  │             │  │                     │  │  ║
║   │  │ Lend fees + │  │ claim L1    │  │ MongoDB             │  │  ║
║   │  │ Bridged L1  │  │ bridge IBC  │  │ rate history        │  │  ║
║   │  └──────┬──────┘  └─────────────┘  └─────────────────────┘  │  ║
║   │         │                                                     │  ║
║   │         ▼ AddRewards({ denom, amount })                       │  ║
║   └──────────────────────────────────────────────────────────────┘  ║
║                                                                      ║
║   ┌──────────────────────────────────────────────────────────────┐  ║
║   │  CosmWasm Smart Contracts                                    │  ║
║   │                                                              │  ║
║   │  ┌────────────┐     ┌────────────┐     ┌─────────────────┐  │  ║
║   │  │  INITx     │     │  Staking   │     │    LP Pool      │  │  ║
║   │  │  Token     │◄────│  Contract  │────►│  (AMM x·y=k)   │  │  ║
║   │  │  (CW20)    │     │            │     │  INIT / INITx   │  │  ║
║   │  └────────────┘     └─────┬──────┘     └─────────────────┘  │  ║
║   │                           │                                  │  ║
║   │  ┌────────────────────────▼──────────────────────────────┐  │  ║
║   │  │                  AddRewards(uinit)                    │  │  ║
║   │  │   90% → stakers (exchange rate ↑)                     │  │  ║
║   │  │   10% → treasury                                      │  │  ║
║   │  └───────────────────────────────────────────────────────┘  │  ║
║   │                                                              │  ║
║   │  ┌────────────┐     ┌────────────────────────────────────┐  │  ║
║   │  │  Lending   │     │         Governance                 │  │  ║
║   │  │  Protocol  │     │  (INITx-weighted proposal voting)  │  │  ║
║   │  └────────────┘     └────────────────────────────────────┘  │  ║
║   └──────────────────────────────────────────────────────────────┘  ║
║                                                                      ║
║   ┌──────────────────────────────────────────────────────────────┐  ║
║   │  Next.js 14 Frontend + InterwovenKit Wallet                  │  ║
║   │  Pages: Stake / Swap / Liquidity / Lend / Governance /       │  ║
║   │         Portfolio / Bridge / Leverage                        │  ║
║   └──────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════╝
```

### Component Interaction Flow

```
User
 │
 ├─ Deposits INIT ──────────────────────────► Staking Contract
 │                                               │ mints INITx
 │◄────────────────────────────────────────── INITx Token (CW20)
 │
 ├─ Swaps INITx ↔ INIT ──────────────────────► LP Pool Contract
 │
 ├─ Deposits INITx collateral ─── CW20 Send ──► Lending Contract
 │◄─────────────────────────── borrows INIT ──
 │
 ├─ Creates governance proposal ── CW20 Send ──► Governance Contract
 │
 └─ Withdraws ────────────────────────────────► Staking Contract
                                                 │ instant or queued

Keeper Bot (every 10 minutes)
 ├─ [wasm-1] Harvest LP fees ──────────────────► LP Pool
 ├─ [wasm-1] Harvest lending fees ─────────────► Lending Contract
 ├─ [wasm-1] Detect bridged L1 rewards in wallet
 ├─ [wasm-1] AddRewards(total INIT) ───────────► Staking Contract (rate ↑)
 ├─ [initiation-2] MsgWithdrawDelegatorReward ──► Chorus One Validator
 └─ [initiation-2] IBC MsgTransfer ────────────► wasm-1 (channel-3073)
```

---

## 🔗 L1 ↔ Rollup Integration Deep Dive

This is what makes INITx technically unique on Initia. Most rollup DeFi protocols operate in isolation from L1 consensus. INITx creates a **live yield bridge** between L1 validator rewards and rollup DeFi.

### The IBC Bridge Cycle

```
initiation-2 (L1)                    wasm-1 (MiniWasm Rollup)
────────────────                    ──────────────────────────
[Every 10 min]
                                    Step 1: Harvest LP + lending fees
                                    Step 2: Detect IBC-landed uinit
                                    Step 3: AddRewards → rate ↑

Step 7: MsgWithdrawDelegatorReward
  → Chorus One validator
  → Claimed uinit credited to keeper

Step 8: IBC MsgTransfer
  channel-3073 → wasm-1
  timeout: now + 10 min              [~2-5 min later]
                                    Bridged uinit arrives in keeper wallet
                                    [Next harvest cycle detects it]
                                    Step 4: bridgedL1Init = balance - gas_reserve
                                    Step 5: AddRewards(lp + lending + bridgedL1)
```

### Technical Implementation

The L1 integration uses **`@initia/initia.js`** — Initia's custom JS SDK — because Initia's staking module is `initia.mstaking.v1` (NOT standard Cosmos `cosmos.staking.v1beta1`). The critical difference:

| Standard Cosmos | Initia mstaking |
|----------------|----------------|
| `MsgDelegate.amount` is a single `Coin` | `MsgDelegate.amount` is an **array** of `Coin` |
| `/cosmos.staking.v1beta1.MsgDelegate` | `/initia.mstaking.v1.MsgDelegate` |
| Works with `@cosmjs/stargate` | Requires `@initia/initia.js` |

**Key message types used:**

```typescript
// Delegate INIT to validator
new MsgDelegate(delegatorAddress, validatorAddress, new Coin("uinit", amount))

// Claim staking rewards
new MsgWithdrawDelegatorReward(delegatorAddress, validatorAddress)

// Bridge back to wasm-1 via IBC
new MsgTransfer("transfer", "channel-3073", coin, sender, receiver, undefined, timeout)
```

### IBC Channels

| Direction | Source | Destination | Channel |
|-----------|--------|-------------|---------|
| wasm-1 → L1 | wasm-1 | initiation-2 | `channel-0` |
| L1 → wasm-1 | initiation-2 | wasm-1 | `channel-3073` |

### Liquidity Buffer Management

To balance L1 yield with instant withdrawal availability:

```
Total wasm-1 deposits
        │
        ├── 20% stays in contract (instant withdrawal buffer)
        │
        └── 80% surplus → bridged to L1 → delegated to validator
```

The `delegateSurplusOnL1()` function runs at startup and monitors for delegation opportunities. It always preserves **4 INIT as gas reserve** on L1 for future claim and bridge transactions.

---

## 📜 Smart Contracts

All contracts are written in **Rust / CosmWasm 2.x** and compiled to WebAssembly. They follow the CW20 Send pattern for composable cross-contract interactions.

### INITx Token (`contracts/initx-token`)

The liquid staking derivative token. A standard CW20 with one restriction: **only the staking contract can mint or burn** INITx.

| Message | Description |
|---------|-------------|
| `Mint { recipient, amount }` | Only callable by staking contract |
| `Burn { amount }` | Burns caller's INITx (used by staking on withdrawal) |
| `Transfer { recipient, amount }` | Standard CW20 transfer |
| `Send { contract, amount, msg }` | CW20 Send with embedded message (used for collateral deposit, governance proposals) |
| `IncreaseAllowance` / `DecreaseAllowance` | Standard CW20 allowance |

**Queries:**
- `Balance { address }` → `{ balance }`
- `TokenInfo {}` → name, symbol, decimals, total supply
- `Minter {}` → staking contract address

### Staking Contract (`contracts/staking`)

The core yield engine. Manages exchange rate, deposit/withdrawal, and reward distribution.

**State:**
```rust
pub struct State {
    pub total_init_staked: Uint128,   // Total INIT held/delegated
    pub total_initx_supply: Uint128,  // Total INITx minted
    pub exchange_rate: Decimal,        // = total_init / total_initx
    pub treasury_balance: Uint128,     // Protocol fee accumulator
    pub paused: bool,
    pub owner: Addr,
    pub keeper: Addr,
    pub treasury: Addr,
    pub initx_token: Addr,
}
```

**Execute Messages:**

| Message | Who | Description |
|---------|-----|-------------|
| `Deposit {}` | Anyone | Send INIT, receive INITx at current rate |
| `Receive(CW20)` | CW20 Send | Receive INITx, process withdrawal |
| `AddRewards {}` | Keeper only | Send INIT, raises exchange rate 90/10 |
| `WithdrawFees {}` | Treasury only | Withdraw accumulated protocol fees |
| `ClaimWithdrawal { id }` | User | Claim matured queued withdrawal |
| `Pause {}` / `Unpause {}` | Owner | Emergency controls |
| `UpdateConfig {}` | Owner | Update keeper / treasury / owner |

**Exchange Rate Formula:**
```
new_rate = (total_init_staked + staker_reward) / total_initx_supply

where staker_reward = rewards_sent * 0.90
      protocol_fee  = rewards_sent * 0.10
```

### LP Pool (`contracts/lp-pool`)

Constant-product AMM for the INIT/INITx pair. Modeled after Uniswap v2.

**Invariant:** `reserve_init × reserve_initx = k`

**Swap Formula:**
```
amount_out = (amount_in × 997 × reserve_out) / (reserve_in × 1000 + amount_in × 997)
```
(997/1000 = 0.3% fee retained in pool)

| Message | Description |
|---------|-------------|
| `SwapInitForInitx { min_out }` | Swap INIT → INITx |
| `Receive(CW20)` | CW20 Send to swap INITx → INIT or add liquidity |
| `AddLiquidity { initx_amount, min_lp }` | Add both tokens, receive LP shares |
| `RemoveLiquidity { lp_amount, min_init, min_initx }` | Burn LP shares, receive both tokens |
| `CollectProtocolFees {}` | Keeper only — collect 0.05% protocol cut |

### Lending Protocol (`contracts/lending`)

Collateralized borrowing with INITx as collateral and INIT as the loan asset.

**Position structure:**
```rust
pub struct Position {
    pub collateral: Uint128,   // INITx locked
    pub debt: Uint128,         // INIT borrowed
    pub last_interest_time: u64,
}
```

**Interest accrual:**
```
interest = debt × annual_rate × (seconds_elapsed / seconds_per_year)
```

**Liquidation check:**
```
health_factor = (collateral_value_in_init × liquidation_threshold) / debt_with_interest
liquidatable  = health_factor < 1.0
```

| Parameter | Value |
|-----------|-------|
| Annual Borrow Rate | 5% |
| Collateral Factor | 70% |
| Liquidation Threshold | 80% |
| Liquidation Bonus | 5% |
| Max Liquidation Per Tx | 50% of debt |

### Governance (`contracts/governance`)

INITx-weighted on-chain governance.

**Proposal lifecycle:**
```
Created (deposit via CW20 Send)
    │
    └─ Voting Period (configurable, default 7 days)
             │
    ┌────────┴────────┐
    │                 │
 Passed           Rejected
 (quorum ≥ 10%    (quorum < 10% OR
  yes > 50%)       yes ≤ 50%)
    │
 Executable
    │
 Executed (on-chain action fired)
```

---

## 📁 Project Structure

```
InDex/
│
├── contracts/                     # CosmWasm smart contracts (Rust)
│   ├── initx-token/               # CW20 liquid staking derivative
│   │   ├── src/
│   │   │   ├── lib.rs             # Contract entry points
│   │   │   ├── contract.rs        # Execute / query logic
│   │   │   ├── msg.rs             # Message types
│   │   │   └── state.rs           # Storage types
│   │   └── Cargo.toml
│   │
│   ├── staking/                   # Core yield engine
│   │   ├── src/
│   │   │   ├── contract.rs        # Deposit, withdraw, add_rewards
│   │   │   ├── msg.rs
│   │   │   ├── state.rs
│   │   │   └── tests.rs           # 11 unit tests
│   │   └── Cargo.toml
│   │
│   ├── lp-pool/                   # Uniswap v2 AMM
│   │   ├── src/
│   │   │   ├── contract.rs        # Swap, add/remove liquidity
│   │   │   └── tests.rs           # 11 unit tests
│   │   └── Cargo.toml
│   │
│   ├── lending/                   # Collateralized borrowing
│   │   ├── src/
│   │   │   ├── contract.rs        # Borrow, repay, liquidate
│   │   │   └── tests.rs           # 10 unit tests
│   │   └── Cargo.toml
│   │
│   ├── governance/                # Protocol governance
│   │   ├── src/
│   │   │   ├── contract.rs        # Proposal, vote, execute
│   │   │   └── tests.rs           # 10 unit tests
│   │   └── Cargo.toml
│   │
│   └── packages/                  # Shared types / interfaces
│
├── backend/                       # Node.js API server + Keeper Bot
│   ├── src/
│   │   ├── index.ts               # Fastify server entry point
│   │   ├── config.ts              # Env config (L1 + L2 params)
│   │   ├── chain.ts               # CosmWasm signing client + retry logic
│   │   ├── keeper.ts              # Harvest cycle orchestrator
│   │   ├── mongo.ts               # MongoDB connection
│   │   │
│   │   ├── services/
│   │   │   ├── l1StakingHarvester.ts   # ★ L1 delegate/claim/bridge logic
│   │   │   ├── feeHarvester.ts         # LP + lending fee collection
│   │   │   ├── rewardEngine.ts         # Exchange rate snapshots + APY
│   │   │   ├── oracleUpdater.ts        # INIT price feed (CoinGecko)
│   │   │   ├── metricsCron.ts          # TVL / utilization metrics
│   │   │   ├── liquidationBot.ts       # Auto-liquidation scanner
│   │   │   ├── riskEngine.ts           # Protocol risk monitoring
│   │   │   ├── eventListener.ts        # WebSocket chain event listener
│   │   │   ├── withdrawalMonitor.ts    # Queued withdrawal processor
│   │   │   ├── leverageEngine.ts       # Leverage position management
│   │   │   ├── restakingEngine.ts      # Restaking strategy engine
│   │   │   └── eventBus.ts             # In-process event pub/sub
│   │   │
│   │   └── routes/
│   │       ├── stats.ts           # GET /stats
│   │       ├── health.ts          # GET /health
│   │       ├── apy.ts             # GET /apy
│   │       ├── price.ts           # GET /price
│   │       ├── validators.ts      # GET /validators
│   │       ├── withdrawals.ts     # GET /withdrawals/:address
│   │       ├── lending.ts         # GET /lending/position/:address
│   │       ├── governance.ts      # GET /governance/proposals
│   │       ├── liquidity.ts       # GET /liquidity
│   │       ├── protocol.ts        # GET /protocol
│   │       ├── leverage.ts        # GET /leverage
│   │       └── restaking.ts       # GET /restaking
│   │
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/                      # Next.js 14 App Router
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx           # Dashboard (exchange rate, TVL, APY)
│   │   │   ├── stake/             # Stake / unstake INIT ↔ INITx
│   │   │   ├── swap/              # Swap INIT ↔ INITx via AMM
│   │   │   ├── liquidity/         # Provide / remove LP liquidity
│   │   │   ├── lend/              # Borrow INIT against INITx collateral
│   │   │   ├── governance/        # Create proposals, vote
│   │   │   ├── portfolio/         # User positions overview
│   │   │   ├── bridge/            # IBC bridge interface
│   │   │   └── leverage/          # Leveraged positions
│   │   │
│   │   ├── hooks/
│   │   │   └── useContracts.ts    # CosmWasm query + execute hook
│   │   │
│   │   ├── components/
│   │   │   ├── Navbar.tsx
│   │   │   ├── StatsCard.tsx
│   │   │   └── TokenInput.tsx
│   │   │
│   │   └── config/                # Contract addresses + chain config
│   │
│   ├── package.json
│   └── .env.local
│
├── scripts/                       # TypeScript deployment scripts
│   ├── deploy.ts                  # Deploy all 5 contracts in order
│   └── package.json
│
├── deployments/
│   └── testnet.json               # Deployed contract addresses + code IDs
│
├── artifacts/                     # Compiled .wasm bytecode
│
├── Cargo.toml                     # Rust workspace
├── .env.example                   # Environment variable template
└── README.md
```

---

## 🚀 Deployed Contracts

### Shared Testnet — `wasm-1` (Live)

> Explorer: [https://scan.testnet.initia.xyz/wasm-1](https://scan.testnet.initia.xyz/wasm-1)

| Contract | Code ID | Address |
|----------|:-------:|---------|
| **INITx Token** (CW20) | `115` | [`init1u55ryw9lsgaxyptqqrnzgk8n5gczu7d3dgpkd0h8l24qmss00knsctdapz`](https://scan.testnet.initia.xyz/wasm-1/accounts/init1u55ryw9lsgaxyptqqrnzgk8n5gczu7d3dgpkd0h8l24qmss00knsctdapz) |
| **Staking** | `116` | [`init1uezrmsm4rcky7w3xmwt3u2980m552x7r9ekynnf9vs35sw6jehgsj28gps`](https://scan.testnet.initia.xyz/wasm-1/accounts/init1uezrmsm4rcky7w3xmwt3u2980m552x7r9ekynnf9vs35sw6jehgsj28gps) |
| **LP Pool** (AMM) | `117` | [`init1glz03hqk5h5jypah4cph0thxpvpchczywv3lfn8z6askw43pjnrqykkfrz`](https://scan.testnet.initia.xyz/wasm-1/accounts/init1glz03hqk5h5jypah4cph0thxpvpchczywv3lfn8z6askw43pjnrqykkfrz) |
| **Lending** | `118` | [`init1dykln6365de5dd5r77kav4fd5egdzd5qvpcfq5069hszlfpgttvsv7ccdn`](https://scan.testnet.initia.xyz/wasm-1/accounts/init1dykln6365de5dd5r77kav4fd5egdzd5qvpcfq5069hszlfpgttvsv7ccdn) |
| **Governance** | `119` | [`init1g3xg3jlhl3zv9skr3249j9djc7rje6nv5rjru6647xjf0za72hkqxqhe9j`](https://scan.testnet.initia.xyz/wasm-1/accounts/init1g3xg3jlhl3zv9skr3249j9djc7rje6nv5rjru6647xjf0za72hkqxqhe9j) |

**Chain Details:**
- Chain ID: `wasm-1`
- Native Denom: `l2/8b3e1fc559b327a35335e3f26ff657eaee5ff8486ccd3c1bc59007a93cf23156`
- RPC: `https://rpc-wasm-1.anvil.asia-southeast.initia.xyz`
- REST: `https://rest-wasm-1.anvil.asia-southeast.initia.xyz`
- Deployed at: `2026-04-18T09:49:14Z`

### L1 Staking Configuration — `initiation-2`

| Parameter | Value |
|-----------|-------|
| Validator | Chorus One |
| Validator Address | `initvaloper1jydu9uz5ajav8alecjqu2y2gx36trchmcgqjyr` |
| IBC Channel (L1 → wasm-1) | `channel-3073` |
| L1 REST | `https://rest.testnet.initia.xyz` |
| L1 RPC | `https://rpc.testnet.initia.xyz/` |

### Recent On-Chain Activity

| Tx Hash | Chain | Action |
|---------|-------|--------|
| [`5467BEF6...`](https://scan.testnet.initia.xyz/wasm-1/txs/5467BEF6D77D4DF60E93FE49818CF0E0B1BA3A217F82551273F1C17DD26B325C) | wasm-1 | AddRewards 12,512,760 uinit — rate: 1.637497 |

---

## 🤖 Backend & Keeper Bot

### Service Architecture

The backend runs multiple services with **staggered start times** to avoid simultaneous RPC bursts:

```
t=0s    Oracle Updater       — INIT/USD price from CoinGecko, cached
t=8s    Reward Engine        — exchange rate snapshots to MongoDB
t=16s   Metrics Cron         — TVL, utilization, pool stats
t=24s   Liquidation Bot      — scan for undercollateralized positions
t=32s   Risk Engine          — protocol-level risk monitoring
t=40s   Event Listener       — WebSocket chain event subscription
t=48s   Withdrawal Monitor   — process matured queued withdrawals
t=56s   L1 Delegation        — delegateSurplusOnL1() on startup
t=60s   First Harvest        — full harvest cycle
t=70s+  Every 10 min         — repeat harvest cycle
```

### `l1StakingHarvester.ts` — Core L1 Module

This service manages all interactions with the Initia L1 (`initiation-2`):

```typescript
// Key exported functions:

getKeeperL1Address()
  // Returns keeper wallet address on L1

getL1DelegationInfo()
  // Returns { delegated: bigint, pendingRewards: bigint }

delegateOnL1(uinitAmount: bigint)
  // Broadcasts MsgDelegate to Chorus One validator
  // Returns tx hash

claimL1StakingRewards()
  // Broadcasts MsgWithdrawDelegatorReward
  // Returns { uinitClaimed, txHash }

bridgeRewardsToWasm1(amount: bigint, receiver: string)
  // Broadcasts IBC MsgTransfer via channel-3073
  // Returns tx hash

delegateSurplusOnL1()
  // Checks L1 balance, delegates everything above 4 INIT gas reserve

harvestL1Rewards(keeperWasm1Address: string)
  // Full cycle: claim → bridge → return amount bridged
```

### Keeper Harvest Cycle (Every 10 Minutes)

```typescript
async function harvestCycle() {
  // wasm-1: collect fees + bridged L1 rewards + AddRewards
  await runHarvestCycle();

  // wasm-1: recycle treasury fees back into stakers
  await recycleTreasury();

  // wasm-1: snapshot exchange rate to MongoDB
  await takeSnapshot();

  // initiation-2: claim staking rewards + bridge back to wasm-1
  if (config.l1StakingEnabled) {
    await harvestL1Rewards(keeperWasm1Address);
  }
}
```

### 429 Rate Limit Handling

The backend implements **exponential backoff with jitter** for all RPC calls:

```typescript
// chain.ts — retries up to 5 times with 2× backoff
// 500ms → 1s → 2s → 4s → 8s + random jitter
// Automatically resets signing client on repeated failures
```

---

## 📡 API Reference

Base URL: `https://index-3mc4.onrender.com`

### Core Endpoints

| Method | Path | Description | Response |
|--------|------|-------------|----------|
| `GET` | `/health` | Server health check | `{ status: "ok", uptime }` |
| `GET` | `/stats` | Protocol statistics | TVL, exchange rate, APY, staked amount |
| `GET` | `/exchange-rate` | Current INITx/INIT rate | `{ rate, timestamp }` |
| `GET` | `/apy` | APY (7d and 30d rolling) | `{ apy7d, apy30d }` |
| `GET` | `/price` | INIT/USD price | `{ price, source }` |
| `GET` | `/validators` | Validator list | Validator addresses and delegation info |

### User Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/withdrawals/:address` | Pending and claimable withdrawals |
| `GET` | `/lending/position/:address` | Collateral, debt, health factor |
| `GET` | `/liquidity` | LP pool reserves and share info |
| `GET` | `/portfolio/:address` | All user positions across protocol |

### Governance

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/governance/proposals` | All proposals with vote tallies |
| `GET` | `/governance/proposals/:id` | Single proposal detail |

### Protocol Internals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/protocol` | Contract addresses, config |
| `GET` | `/restaking` | Restaking engine state |
| `GET` | `/leverage` | Leverage positions summary |

---

## 🖥 Frontend

Built with **Next.js 14 App Router**, **TypeScript**, and **Tailwind CSS**. Wallet integration via **InterwovenKit** (Initia's native wallet kit).

### Pages

| Route | Page | Description |
|-------|------|-------------|
| `/` | Dashboard | Exchange rate chart, TVL, APY, protocol stats |
| `/stake` | Stake | Deposit INIT → mint INITx / burn INITx → withdraw INIT |
| `/swap` | Swap | INIT ↔ INITx instant swap via AMM |
| `/liquidity` | Liquidity | Add/remove INIT+INITx liquidity, view LP share |
| `/lend` | Lend | Deposit INITx collateral, borrow INIT, view health |
| `/governance` | Governance | Browse proposals, vote, create proposal |
| `/portfolio` | Portfolio | All positions: staked, LP, borrowed, governance |
| `/bridge` | Bridge | IBC bridge interface (INIT ↔ rollup) |
| `/leverage` | Leverage | Leveraged staking positions |

### Key Technical Choices

- **`HttpBatchClient`** — batches multiple CosmWasm queries into a single RPC call, dramatically reducing latency and 429 errors
- **Retry-once pattern** on wallet connect — gracefully handles network hiccups
- **Polling** via `useEffect` + `setInterval` — live exchange rate updates without WebSocket complexity
- **InterwovenKit** for wallet — supports Keplr, MetaMask Snap, and Initia-native wallets

---

## ⚡ Quick Start

### Prerequisites

- **Rust** 1.70+ with `wasm32-unknown-unknown` target
- **Node.js** 18+
- **MongoDB** (local or Atlas)
- An Initia testnet wallet with INIT tokens on `wasm-1`
- (Optional) Initia testnet wallet with INIT on `initiation-2` for L1 staking

### 1. Clone & Install

```bash
git clone https://github.com/anindhabiswas25/InDeX
cd InDeX
```

### 2. Build Smart Contracts

```bash
# Add wasm target (one-time)
rustup target add wasm32-unknown-unknown

# Build all contracts
cargo build --release --target wasm32-unknown-unknown

# Run all 58 unit tests
cargo test
```

### 3. Deploy Contracts (or use existing testnet deployments)

```bash
cp .env.example .env
# Fill in: DEPLOYER_MNEMONIC, INITIA_RPC_URL, CHAIN_ID, MONGO_URI

cd scripts
npm install
npm run deploy
# Contract addresses auto-written to .env
```

Or skip deployment and use the already-deployed testnet contracts from the [Deployed Contracts](#-deployed-contracts) section.

### 4. Run the Backend

```bash
cd backend
npm install

# Development mode (ts-node with hot reload)
npm run dev

# Production (compile + run)
npm run build
npm start
```

The backend starts on port `3002`. The keeper bot initializes automatically.

**To run in a persistent screen session (survives SSH disconnect):**

```bash
screen -dmS backend bash -c 'cd backend && npm run dev 2>&1 | tee server.log'
screen -r backend          # attach to view logs
# Ctrl+A then D to detach
```

### 5. Run the Frontend

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

---

## 🧪 Testing

### Smart Contract Unit Tests

```bash
# Run all 58 tests across all contracts
cargo test

# Run tests for a specific contract
cargo test -p initx-staking
cargo test -p initx-lp-pool
cargo test -p initx-lending
cargo test -p initx-governance
cargo test -p initx-token
```

**Test coverage by contract:**

| Contract | Tests | Coverage Areas |
|----------|------:|----------------|
| `initx-token` | 8 | Mint, burn, transfer, allowance, minter restriction |
| `staking` | 11 | Deposit, withdraw, exchange rate, rewards, pause, treasury |
| `lp-pool` | 11 | Swap, liquidity add/remove, fee accrual, slippage |
| `lending` | 10 | Borrow, repay, liquidation, interest accrual, health factor |
| `governance` | 10 | Proposal creation, voting, quorum, execution |
| **Total** | **50** | |

### E2E Testing

See `E2E_TESTING_GUIDE.md` for full end-to-end testing instructions against the deployed testnet contracts.

```bash
# Run E2E tests against testnet
cd backend
npm run e2e
```

---

## 🔐 Security Notes

> **This is an MVP / hackathon project.** The following caveats apply before production use.

| Area | Current State | Production Recommendation |
|------|--------------|---------------------------|
| **Oracle** | Hardcoded 1:1 INITx/INIT price for lending | Integrate TWAP from LP pool or Pyth |
| **Audit** | Not audited | Full audit by CertiK / OtterSec before mainnet |
| **Admin keys** | Single keeper wallet | Migrate to multisig (3-of-5) |
| **Validator concentration** | Single validator (Chorus One) | Distribute across ≥5 validators |
| **IBC failure handling** | Timeout + retry | Implement IBC packet ack/timeout callbacks |
| **Slashing** | No slashing insurance | Implement slashing coverage fund |
| **Gas reserve** | Fixed 4 INIT L1 reserve | Dynamic gas price monitoring |

---

## 📈 Roadmap

### Phase 1 — Testnet MVP (Current ✅)
- [x] 5 CosmWasm contracts deployed on wasm-1
- [x] Real L1 staking via IBC cross-layer yield bridge
- [x] Keeper bot with full harvest cycle (10 min)
- [x] Exchange rate rising from real PoS rewards
- [x] Full frontend: stake, swap, lend, governance, portfolio

### Phase 2 — Protocol Maturation
- [ ] Multi-validator delegation (risk diversification)
- [ ] Dynamic liquidity buffer (based on withdrawal demand)
- [ ] INITx as collateral in external lending protocols
- [ ] Auto-compounding (reinvest rewards without bridge latency)
- [ ] IBC packet acknowledgment callbacks for bridge failure handling
- [ ] Slashing coverage fund

### Phase 3 — Cross-Rollup Expansion
- [ ] Deploy INITx to MiniEVM rollups (bridge via OPinit)
- [ ] INITx liquidity on external DEXes (Astroport, Osmosis)
- [ ] Restaking: use INITx to secure additional AVS networks
- [ ] Multi-collateral lending (LP tokens, other derivatives)

### Phase 4 — Mainnet
- [ ] Security audit
- [ ] Multisig admin migration
- [ ] Mainnet deployment
- [ ] DAO governance for protocol parameters

---

## 🛠 Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Smart Contracts | Rust + CosmWasm | 2.x |
| Blockchain | Initia MiniWasm Rollup | wasm-1 |
| L1 Integration | `@initia/initia.js` | 1.1.0 |
| Backend Runtime | Node.js | 18+ |
| API Framework | Fastify | 4.x |
| CosmWasm Client | `@cosmjs/cosmwasm-stargate` | 0.32 |
| Database | MongoDB | 6.x |
| Frontend | Next.js (App Router) | 14 |
| Styling | Tailwind CSS | 3.x |
| Wallet | InterwovenKit | latest |
| Language | TypeScript | 5.x |

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Write tests for new contract logic
4. Run `cargo test` — all tests must pass
5. Run `npx tsc --noEmit` in `backend/` — no TypeScript errors
6. Submit a pull request with a clear description

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<div align="center">

Built with ❤️ for the Initia ecosystem

**INITx — Where L1 Security Meets L2 DeFi | Built for the Initia Ecosystem**

[Live App](https://index-3mc4.onrender.com) · [GitHub](https://github.com/anindhabiswas25/InDeX) · [Demo Video](https://youtu.be/h4AxcTZKT34?si=aGe6ZX41UtZrYCI2)

</div>
