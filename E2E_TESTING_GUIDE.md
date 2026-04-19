# INITx Protocol — E2E Manual Testing Guide

This guide walks through manually testing every protocol flow on the **shared MiniWasm testnet (wasm-1)**. All commands use `initiad` (or `minitiad`) CLI.

## Prerequisites

### 1. Set up CLI

```bash
export MINITIAD=$HOME/.weave/data/miniwasm@v1.2.11/minitiad
# OR use initiad if you have it:
# alias minitiad=initiad
```

### 2. Recover the deployer key (or use your own funded account)

```bash
# Interactive — will prompt for mnemonic
$MINITIAD keys add deployer --recover --keyring-backend test
```

### 3. Contract addresses

| Contract | Address |
|----------|---------|
| INITx Token | `init1w00wxdjvxh8mjydrdqz3lms82mzyylj9zqvh2pex76m590p0x3zq4lct6n` |
| Staking | `init1ymwhjj8nz5zq05umqegztusnx8hlpjfq2ke99wejt8srllhr79ssu3x8va` |
| LP Pool | `init10junhyk52wr3dez5ygrkhngcr9l7skvxwc9s8ul55nastlagwc0s7y0pn4` |
| Lending | `init1676c93uz9dcxy2cfr9nmfn4ductemgc4akasgv6cauvjqmmy3rcs7hup4p` |
| Governance | `init1xxzsac5hwmaq2fq5wja4s03qkc6frg77n4gexcu2me7c9y2pz8qsyk4xhq` |

### 4. Environment variables (paste these into your shell)

```bash
NODE="https://rpc-wasm-1.anvil.asia-southeast.initia.xyz"
CHAIN="wasm-1"
DENOM="l2/8b3e1fc559b327a35335e3f26ff657eaee5ff8486ccd3c1bc59007a93cf23156"
GAS="--gas auto --gas-adjustment 1.5 --gas-prices 0.015${DENOM}"
FROM="--from deployer --keyring-backend test --node $NODE --chain-id $CHAIN $GAS -y"

TOKEN="init1w00wxdjvxh8mjydrdqz3lms82mzyylj9zqvh2pex76m590p0x3zq4lct6n"
STAKING="init1ymwhjj8nz5zq05umqegztusnx8hlpjfq2ke99wejt8srllhr79ssu3x8va"
LP_POOL="init10junhyk52wr3dez5ygrkhngcr9l7skvxwc9s8ul55nastlagwc0s7y0pn4"
LENDING="init1676c93uz9dcxy2cfr9nmfn4ductemgc4akasgv6cauvjqmmy3rcs7hup4p"
GOVERNANCE="init1xxzsac5hwmaq2fq5wja4s03qkc6frg77n4gexcu2me7c9y2pz8qsyk4xhq"
DEPLOYER="init1wrn8tzfmjpl49y6m6806esdcnry0s89kwh9vea"
```

### 5. Useful query shorthand

```bash
Q="$MINITIAD query wasm contract-state smart --node $NODE -o json"
```

### 6. Explorer

All transactions are visible at: `https://scan.testnet.initia.xyz/wasm-1`

---

## Test 1: Staking — Deposit INIT, Receive INITx

**What it tests:** User deposits native INIT into the staking contract and receives INITx (CW20) at the current exchange rate.

### 1a. Check exchange rate before deposit

```bash
$Q $STAKING '{"exchange_rate":{}}'
```

Expected: `{"rate":"1.0"}` (or higher if rewards were added).

### 1b. Deposit 10 INIT

```bash
$MINITIAD tx wasm execute $STAKING '{"deposit":{}}' \
  --amount 10000000${DENOM} $FROM
```

### 1c. Check INITx balance

```bash
$Q $TOKEN "{\"balance\":{\"address\":\"$DEPLOYER\"}}"
```

Expected: Balance increased by `10000000 / rate` (10M uINITx if rate = 1.0).

### 1d. Check pool state

```bash
$Q $STAKING '{"pool_state":{}}'
```

Expected: `total_deposited` and `total_initx_minted` reflect the deposit.

---

## Test 2: Staking — Add Rewards (Keeper)

**What it tests:** Keeper adds staking rewards, increasing the exchange rate. 10% goes to protocol treasury, 90% to stakers.

### 2a. Add 5 INIT rewards

```bash
$MINITIAD tx wasm execute $STAKING '{"add_rewards":{}}' \
  --amount 5000000${DENOM} $FROM
```

### 2b. Check new exchange rate

```bash
$Q $STAKING '{"exchange_rate":{}}'
```

Expected: Rate > 1.0 (e.g., if 10 INIT deposited + 4.5 INIT net rewards = rate ~1.45).

### 2c. Check treasury balance

```bash
$Q $STAKING '{"treasury_balance":{}}'
```

Expected: ~500000 (10% of 5M = 0.5 INIT).

---

## Test 3: Staking — Withdraw INITx (CW20 Send Pattern)

**What it tests:** User sends INITx back to the staking contract via CW20 `Send` to request a withdrawal. If the contract has enough liquidity buffer, the withdrawal is instant.

### 3a. Request withdrawal of 5 INITx via CW20 Send

The `msg` field is base64-encoded `{"request_withdrawal":{}}`.

```bash
MSG=$(echo -n '{"request_withdrawal":{}}' | base64)
$MINITIAD tx wasm execute $TOKEN \
  "{\"send\":{\"contract\":\"$STAKING\",\"amount\":\"5000000\",\"msg\":\"$MSG\"}}" \
  $FROM
```

### 3b. Check if instant or pending

If the contract had enough INIT in its buffer, the INIT is sent back immediately. Check your native balance:

```bash
$MINITIAD query bank balances $DEPLOYER --node $NODE -o json
```

If it's a pending withdrawal (insufficient buffer), check pending withdrawals:

```bash
$Q $STAKING "{\"withdrawals\":{\"user\":\"$DEPLOYER\"}}"
```

### 3c. Claim pending withdrawal (if applicable)

After the cooldown period:

```bash
$MINITIAD tx wasm execute $STAKING '{"claim_withdrawal":{"idx":0}}' $FROM
```

---

## Test 4: LP Pool — Add Liquidity

**What it tests:** User provides both INIT and INITx to the LP pool, receiving LP shares.

### 4a. First, increase INITx allowance for LP Pool

```bash
$MINITIAD tx wasm execute $TOKEN \
  "{\"increase_allowance\":{\"spender\":\"$LP_POOL\",\"amount\":\"5000000\"}}" \
  $FROM
```

### 4b. Add liquidity — send INIT as bank transfer + INITx via CW20 Send

This requires two messages in one tx. The simplest CLI approach is to send INIT first, then add liquidity:

**Step 1:** Send INIT to LP pool contract:
```bash
$MINITIAD tx bank send deployer $LP_POOL 5000000${DENOM} \
  --keyring-backend test --node $NODE --chain-id $CHAIN $GAS -y
```

**Step 2:** Send INITx via CW20 Send with AddLiquidity hook:
```bash
MSG=$(echo -n '{"add_liquidity":{"min_lp_amount":"1"}}' | base64)
$MINITIAD tx wasm execute $TOKEN \
  "{\"send\":{\"contract\":\"$LP_POOL\",\"amount\":\"5000000\",\"msg\":\"$MSG\"}}" \
  $FROM
```

### 4c. Check LP balance

```bash
$Q $LP_POOL "{\"lp_balance\":{\"address\":\"$DEPLOYER\"}}"
```

### 4d. Check pool state

```bash
$Q $LP_POOL '{"pool_state":{}}'
```

Expected: Reserves reflect your liquidity deposit.

---

## Test 5: LP Pool — Swap INIT for INITx

**What it tests:** User swaps native INIT for INITx through the constant-product AMM (0.3% fee).

### 5a. Estimate swap

```bash
$Q $LP_POOL '{"estimate_swap":{"offer_asset":"native","offer_amount":"1000000"}}'
```

### 5b. Execute swap

```bash
$MINITIAD tx wasm execute $LP_POOL \
  '{"swap":{"offer_asset":"native","min_return":"1"}}' \
  --amount 1000000${DENOM} $FROM
```

### 5c. Verify INITx balance increased

```bash
$Q $TOKEN "{\"balance\":{\"address\":\"$DEPLOYER\"}}"
```

---

## Test 6: LP Pool — Swap INITx for INIT

**What it tests:** Reverse swap — INITx to INIT via CW20 Send.

### 6a. Swap 1 INITx for INIT

```bash
MSG=$(echo -n '{"swap":{"min_return":"1"}}' | base64)
$MINITIAD tx wasm execute $TOKEN \
  "{\"send\":{\"contract\":\"$LP_POOL\",\"amount\":\"1000000\",\"msg\":\"$MSG\"}}" \
  $FROM
```

---

## Test 7: Lending — Supply INIT (Lender)

**What it tests:** Lender supplies native INIT to the lending pool, earning interest from borrowers.

### 7a. Supply 20 INIT

```bash
$MINITIAD tx wasm execute $LENDING '{"supply":{}}' \
  --amount 20000000${DENOM} $FROM
```

### 7b. Check pool state

```bash
$Q $LENDING '{"pool_state":{}}'
```

Expected: `total_supplied` = 20000000.

---

## Test 8: Lending — Deposit Collateral + Borrow

**What it tests:** User deposits INITx as collateral (via CW20 Send), then borrows INIT against it.

### 8a. Deposit 10 INITx collateral

```bash
MSG=$(echo -n '{"deposit_collateral":{}}' | base64)
$MINITIAD tx wasm execute $TOKEN \
  "{\"send\":{\"contract\":\"$LENDING\",\"amount\":\"10000000\",\"msg\":\"$MSG\"}}" \
  $FROM
```

### 8b. Borrow 5 INIT

```bash
$MINITIAD tx wasm execute $LENDING '{"borrow":{"amount":"5000000"}}' $FROM
```

### 8c. Check health factor

```bash
$Q $LENDING "{\"health_factor\":{\"address\":\"$DEPLOYER\"}}"
```

Expected: Health factor > 1.0 (healthy position).

### 8d. Check position

```bash
$Q $LENDING "{\"position\":{\"address\":\"$DEPLOYER\"}}"
```

---

## Test 9: Lending — Repay + Withdraw Collateral

### 9a. Repay 3 INIT

```bash
$MINITIAD tx wasm execute $LENDING '{"repay":{}}' \
  --amount 3000000${DENOM} $FROM
```

### 9b. Withdraw 2 INITx collateral

```bash
$MINITIAD tx wasm execute $LENDING '{"withdraw_collateral":{"amount":"2000000"}}' $FROM
```

### 9c. Verify health factor still healthy

```bash
$Q $LENDING "{\"health_factor\":{\"address\":\"$DEPLOYER\"}}"
```

---

## Test 10: Governance — Create Proposal (via CW20 Send)

**What it tests:** User creates a governance proposal by sending INITx to the governance contract.

### 10a. Create proposal

```bash
MSG=$(echo -n '{"create_proposal":{"title":"Test Proposal","description":"Testing governance flow","action":{"text":"This is a test proposal"}}}' | base64)
$MINITIAD tx wasm execute $TOKEN \
  "{\"send\":{\"contract\":\"$GOVERNANCE\",\"amount\":\"1000000\",\"msg\":\"$MSG\"}}" \
  $FROM
```

### 10b. Query proposals

```bash
$Q $GOVERNANCE '{"proposals":{"start_after":null,"limit":10}}'
```

---

## Test 11: Governance — Vote on Proposal

### 11a. Vote YES on proposal 1

```bash
$MINITIAD tx wasm execute $GOVERNANCE \
  '{"vote":{"proposal_id":1,"vote":"yes"}}' $FROM
```

### 11b. Check vote

```bash
$Q $GOVERNANCE "{\"vote\":{\"proposal_id\":1,\"voter\":\"$DEPLOYER\"}}"
```

### 11c. Check proposal status

```bash
$Q $GOVERNANCE '{"proposal_status":{"id":1}}'
```

---

## Test 12: Staking — Admin Operations

### 12a. Pause staking

```bash
$MINITIAD tx wasm execute $STAKING '{"pause":{}}' $FROM
```

### 12b. Verify paused

```bash
$Q $STAKING '{"is_paused":{}}'
```

Expected: `true`

### 12c. Unpause

```bash
$MINITIAD tx wasm execute $STAKING '{"unpause":{}}' $FROM
```

---

## Test 13: Query All Configs

Verify all contracts are configured correctly:

```bash
$Q $STAKING '{"config":{}}'
$Q $LP_POOL '{"config":{}}'
$Q $LENDING '{"config":{}}'
$Q $GOVERNANCE '{"config":{}}'
```

Check that `initx_token` addresses, keepers, treasuries, and parameters are set correctly.

---

## Test 14: LP Pool — Accrued Fees

```bash
$Q $LP_POOL '{"accrued_fees":{}}'
```

After swaps, this should show accumulated protocol fees.

---

## Frontend Testing

1. Open `http://localhost:3000` in browser
2. Connect wallet via Keplr (InterwovenKit)
3. Navigate to each page and test:
   - **Stake:** Deposit INIT, see INITx balance update
   - **Swap:** Swap INIT <-> INITx
   - **Liquidity:** Add/remove liquidity
   - **Lend:** Supply INIT, deposit collateral, borrow
   - **Governance:** Create proposal, vote

---

## Troubleshooting

- **"out of gas"**: Increase `--gas-adjustment` to `2.0`
- **"insufficient funds"**: Bridge more INIT to wasm-1 via OPinit bridge
- **"unauthorized"**: Ensure you're using the correct key (deployer/keeper)
- **"no liquidity"**: LP pool needs initial liquidity before swaps work
- **Query fails**: Ensure you're using the correct node URL and contract address
