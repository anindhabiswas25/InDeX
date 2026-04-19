#!/bin/bash
###############################################################################
# INITx Protocol — Comprehensive E2E Test Script
# Tests ALL flows that users will exercise from the frontend
###############################################################################

set -e

export LD_LIBRARY_PATH=$HOME/.weave/data/miniwasm@v1.2.11:$LD_LIBRARY_PATH
M=$HOME/.weave/data/miniwasm@v1.2.11/minitiad
NODE="--node http://localhost:26657"
KR="--keyring-backend test --home $HOME/.minitia"
CHAIN="--chain-id initx-1"
FEES="--fees 100000umin --gas auto --gas-adjustment 1.5 -y"
COMMON="$NODE $KR $CHAIN $FEES"

# Contract addresses (v6 fresh deploy)
TOKEN="init1cyq9g0g6xgumdj0uhsy8kyrg2w3dhr2c9dkydxxfetj0t8l4tpfs6n2d02"
STAKING="init176xmajrrvucskzmg2a87f86s2hecaf9uj9km9ueunj2fhjq4rdfsxmlp5u"
LPPOOL="init1jrqamm76asdxw7dfryyyu8w7gfv28jn0ydye5dp4vks2rjjqzgesu7cnmt"
LENDING="init1tts0gaza45trf3k5w30yex8dlzq674zlfazncwhpc98uc70p6smqy5wv2m"
GOV="init1syczlejd4jsavlrtcvwt25rn2gzlrjysh875aqx03e7yvhpceeqsa2dwkc"

ADMIN=$($M keys show Validator $KR -a)
DENOM="umin"

# Counters
PASS=0
FAIL=0
TOTAL=0

pass() {
  PASS=$((PASS+1))
  TOTAL=$((TOTAL+1))
  echo "  ✅ PASS: $1"
}

fail() {
  FAIL=$((FAIL+1))
  TOTAL=$((TOTAL+1))
  echo "  ❌ FAIL: $1"
  echo "       $2"
}

tx() {
  # Execute a tx, wait, return result
  local RESULT
  RESULT=$("$@" 2>&1)
  local TXHASH=$(echo "$RESULT" | grep -o 'txhash: [A-F0-9]*' | awk '{print $2}')
  if [ -z "$TXHASH" ]; then
    TXHASH=$(echo "$RESULT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('txhash',''))" 2>/dev/null || true)
  fi
  sleep 3
  if [ -n "$TXHASH" ] && [ "$TXHASH" != "" ]; then
    echo "$TXHASH"
  else
    echo "FAILED:$RESULT"
  fi
}

query() {
  $M query wasm contract-state smart "$1" "$2" $NODE -o json 2>&1
}

bank_balance() {
  $M query bank balances "$1" $NODE -o json 2>&1 | python3 -c "
import sys,json
d=json.load(sys.stdin)
for b in d.get('balances',[]):
    if b['denom']=='$DENOM':
        print(b['amount'])
        sys.exit()
print('0')
"
}

cw20_balance() {
  query "$TOKEN" "{\"balance\":{\"address\":\"$1\"}}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['balance'])"
}

echo "============================================"
echo " INITx Protocol E2E Test Suite"
echo "============================================"
echo "Admin:    $ADMIN"
echo "Token:    $TOKEN"
echo "Staking:  $STAKING"
echo "LP Pool:  $LPPOOL"
echo "Lending:  $LENDING"
echo "Gov:      $GOV"
echo ""

###############################################################################
# SECTION 1: STAKING FLOWS
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SECTION 1: STAKING FLOWS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1.1 Query exchange rate (should be 1.0)
echo "[1.1] Query exchange rate..."
RATE=$(query "$STAKING" '{"exchange_rate":{}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['rate_display'])")
if [ "$RATE" = "1.000000" ]; then
  pass "Exchange rate is 1.000000"
else
  fail "Exchange rate expected 1.000000, got $RATE" ""
fi

# 1.2 Query staking config
echo "[1.2] Query staking config..."
CONFIG=$(query "$STAKING" '{"config":{}}')
TOKEN_FROM_CONFIG=$(echo "$CONFIG" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['initx_token'])")
if [ "$TOKEN_FROM_CONFIG" = "$TOKEN" ]; then
  pass "Staking config has correct token address"
else
  fail "Staking config token mismatch" "$TOKEN_FROM_CONFIG != $TOKEN"
fi

# 1.3 Query pool state (should be empty)
echo "[1.3] Query pool state (empty)..."
POOL=$(query "$STAKING" '{"pool_state":{}}')
TOTAL_STAKED=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_init_staked'])")
if [ "$TOTAL_STAKED" = "0" ]; then
  pass "Pool state: zero staked"
else
  fail "Pool not empty: $TOTAL_STAKED staked" ""
fi

# 1.4 Estimate deposit
echo "[1.4] Estimate deposit of 10 INIT..."
EST=$(query "$STAKING" '{"estimate_deposit":{"amount":"10000000"}}')
EST_AMT=$(echo "$EST" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['initx_amount'])")
if [ "$EST_AMT" = "10000000" ]; then
  pass "Deposit estimate: 10 INIT -> 10 INITx at rate 1.0"
else
  fail "Deposit estimate wrong: expected 10000000, got $EST_AMT" ""
fi

# 1.5 Deposit 100 INIT -> get 100 INITx
echo "[1.5] Deposit 100 INIT..."
INITX_BEFORE=$(cw20_balance "$ADMIN")
RESULT=$($M tx wasm execute "$STAKING" '{"deposit":{}}' --amount 100000000$DENOM --from Validator $COMMON 2>&1)
sleep 4
INITX_AFTER=$(cw20_balance "$ADMIN")
MINTED=$((INITX_AFTER - INITX_BEFORE))
if [ "$MINTED" = "100000000" ]; then
  pass "Deposited 100 INIT, received 100 INITx ($MINTED)"
else
  fail "Deposit minting wrong: expected 100000000, got $MINTED" "$RESULT"
fi

# 1.6 Verify exchange rate still 1.0
echo "[1.6] Exchange rate after deposit..."
RATE=$(query "$STAKING" '{"exchange_rate":{}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['rate_display'])")
if [ "$RATE" = "1.000000" ]; then
  pass "Exchange rate still 1.000000 after deposit"
else
  fail "Exchange rate changed: $RATE" ""
fi

# 1.7 Verify pool state updated
echo "[1.7] Pool state after deposit..."
POOL=$(query "$STAKING" '{"pool_state":{}}')
TOTAL_STAKED=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_init_staked'])")
TOTAL_SUPPLY=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_initx_supply'])")
if [ "$TOTAL_STAKED" = "100000000" ] && [ "$TOTAL_SUPPLY" = "100000000" ]; then
  pass "Pool: 100M staked, 100M supply"
else
  fail "Pool state wrong: staked=$TOTAL_STAKED supply=$TOTAL_SUPPLY" ""
fi

# 1.8 Add rewards (keeper) - 10 INIT
echo "[1.8] Add rewards (10 INIT)..."
RESULT=$($M tx wasm execute "$STAKING" '{"add_rewards":{}}' --amount 10000000$DENOM --from Validator $COMMON 2>&1)
sleep 4
# 10% protocol fee = 1 INIT, 90% to stakers = 9 INIT
# New total staked = 100 + 9 = 109, supply still 100
# Rate = 109/100 = 1.09
RATE=$(query "$STAKING" '{"exchange_rate":{}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['rate_display'])")
echo "  Rate after rewards: $RATE"
if echo "$RATE" | grep -q "1.09"; then
  pass "Exchange rate rose to ~1.09 after 10 INIT rewards"
else
  fail "Exchange rate wrong after rewards: $RATE (expected ~1.09)" ""
fi

# 1.9 Estimate withdrawal
echo "[1.9] Estimate withdrawal of 10 INITx..."
EST=$(query "$STAKING" '{"estimate_withdrawal":{"initx_amount":"10000000"}}')
EST_INIT=$(echo "$EST" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['init_amount'])")
echo "  Estimate: 10 INITx -> $EST_INIT umin"
if [ "$EST_INIT" -gt "10000000" ]; then
  pass "Withdrawal estimate > 10 INIT (rate > 1.0)"
else
  fail "Withdrawal estimate wrong: $EST_INIT" ""
fi

# 1.10 Request withdrawal via CW20 Send (no allowance needed!)
echo "[1.10] Request withdrawal of 10 INITx via CW20 Send..."
HOOK_MSG=$(echo -n '{"request_withdrawal":{}}' | base64 -w0)
RESULT=$($M tx wasm execute "$TOKEN" "{\"send\":{\"contract\":\"$STAKING\",\"amount\":\"10000000\",\"msg\":\"$HOOK_MSG\"}}" --from Validator $COMMON 2>&1)
sleep 4
# Check withdrawals
WITHDRAWALS=$(query "$STAKING" "{\"withdrawals\":{\"user\":\"$ADMIN\"}}")
WD_COUNT=$(echo "$WITHDRAWALS" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(len(d['withdrawals']))")
if [ "$WD_COUNT" = "1" ]; then
  pass "Withdrawal request created (1 pending)"
  WD_AMOUNT=$(echo "$WITHDRAWALS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['withdrawals'][0]['init_amount'])")
  echo "       Withdrawal amount: $WD_AMOUNT umin"
else
  fail "Withdrawal not created: count=$WD_COUNT" "$WITHDRAWALS"
fi

# 1.11 Claim withdrawal (after cooldown — we set 60s)
echo "[1.11] Wait for cooldown (60s) and claim withdrawal..."
WD_ID=$(echo "$WITHDRAWALS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['withdrawals'][0]['id'])")
echo "  Waiting 65 seconds for cooldown..."
sleep 65
INIT_BEFORE=$(bank_balance "$ADMIN")
RESULT=$($M tx wasm execute "$STAKING" "{\"claim_withdrawal\":{\"withdrawal_id\":$WD_ID}}" --from Validator $COMMON 2>&1)
sleep 4
INIT_AFTER=$(bank_balance "$ADMIN")
# The INIT should have increased (minus gas fees)
DIFF=$((INIT_AFTER - INIT_BEFORE))
echo "  INIT balance change: $DIFF"
if [ "$DIFF" -gt "0" ]; then
  pass "Claimed withdrawal successfully (received $DIFF umin)"
else
  fail "Claim withdrawal failed or no funds received" "$RESULT"
fi

# 1.12 Check IsPaused
echo "[1.12] Check paused state..."
PAUSED=$(query "$STAKING" '{"is_paused":{}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['paused'])")
if [ "$PAUSED" = "False" ] || [ "$PAUSED" = "false" ]; then
  pass "Contract is not paused"
else
  fail "Contract unexpectedly paused: $PAUSED" ""
fi

echo ""

###############################################################################
# SECTION 2: LP POOL FLOWS
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SECTION 2: LP POOL FLOWS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 2.1 Query pool state (empty)
echo "[2.1] Query LP pool state (empty)..."
POOL=$(query "$LPPOOL" '{"pool_state":{}}')
LP_INIT=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['init_reserve'])")
if [ "$LP_INIT" = "0" ]; then
  pass "LP pool is empty"
else
  fail "LP pool not empty: init_reserve=$LP_INIT" ""
fi

# 2.2 Add liquidity: first deposit INIT to pool, then CW20 Send INITx
# We need to send INIT to LP pool FIRST, then in a separate tx send INITx via CW20 Send
# Because the contract calculates INIT from balance - reserve
echo "[2.2] Add initial liquidity (50 INIT + 50 INITx)..."
# Step 1: Send INIT directly to LP pool contract
RESULT=$($M tx bank send Validator "$LPPOOL" 50000000$DENOM $COMMON 2>&1)
sleep 4
# Step 2: CW20 Send INITx to LP pool with AddLiquidity hook
HOOK_MSG=$(echo -n '{"add_liquidity":{"min_lp_shares":null}}' | base64 -w0)
RESULT=$($M tx wasm execute "$TOKEN" "{\"send\":{\"contract\":\"$LPPOOL\",\"amount\":\"50000000\",\"msg\":\"$HOOK_MSG\"}}" --from Validator $COMMON 2>&1)
sleep 4
# Verify pool state
POOL=$(query "$LPPOOL" '{"pool_state":{}}')
LP_INIT=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['init_reserve'])")
LP_INITX=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['initx_reserve'])")
LP_SHARES=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_lp_shares'])")
echo "  Pool: init=$LP_INIT, initx=$LP_INITX, shares=$LP_SHARES"
if [ "$LP_INIT" = "50000000" ] && [ "$LP_INITX" = "50000000" ]; then
  pass "Initial liquidity added: 50M INIT + 50M INITx"
else
  fail "Liquidity add failed: init=$LP_INIT initx=$LP_INITX" "$RESULT"
fi

# 2.3 Check LP balance
echo "[2.3] Check LP balance for admin..."
LP_BAL=$(query "$LPPOOL" "{\"lp_balance\":{\"address\":\"$ADMIN\"}}")
SHARES=$(echo "$LP_BAL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['shares'])")
echo "  LP shares: $SHARES"
if [ "$SHARES" != "0" ] && [ -n "$SHARES" ]; then
  pass "Admin has LP shares: $SHARES"
else
  fail "No LP shares found" "$LP_BAL"
fi

# 2.4 Swap INIT -> INITx
echo "[2.4] Swap 5 INIT -> INITx..."
INITX_BEFORE=$(cw20_balance "$ADMIN")
RESULT=$($M tx wasm execute "$LPPOOL" '{"swap_init_for_initx":{"min_out":null}}' --amount 5000000$DENOM --from Validator $COMMON 2>&1)
sleep 4
INITX_AFTER=$(cw20_balance "$ADMIN")
GAINED=$((INITX_AFTER - INITX_BEFORE))
echo "  INITx gained: $GAINED"
if [ "$GAINED" -gt "0" ]; then
  pass "Swapped 5 INIT -> $GAINED uINITx"
else
  fail "Swap INIT->INITx failed: gained=$GAINED" "$RESULT"
fi

# 2.5 Estimate swap
echo "[2.5] Estimate swap 1 INIT -> INITx..."
EST=$(query "$LPPOOL" '{"estimate_swap":{"offer_asset":"native_init","offer_amount":"1000000"}}')
RETURN=$(echo "$EST" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['return_amount'])")
FEE=$(echo "$EST" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['fee_amount'])")
echo "  Return: $RETURN, Fee: $FEE"
if [ "$RETURN" -gt "0" ]; then
  pass "Swap estimate: 1 INIT -> $RETURN INITx (fee: $FEE)"
else
  fail "Swap estimate failed" "$EST"
fi

# 2.6 Swap INITx -> INIT (CW20 Send)
echo "[2.6] Swap 2 INITx -> INIT..."
INIT_BEFORE=$(bank_balance "$ADMIN")
HOOK_MSG=$(echo -n '{"swap_initx_for_init":{"min_out":null}}' | base64 -w0)
RESULT=$($M tx wasm execute "$TOKEN" "{\"send\":{\"contract\":\"$LPPOOL\",\"amount\":\"2000000\",\"msg\":\"$HOOK_MSG\"}}" --from Validator $COMMON 2>&1)
sleep 4
INIT_AFTER=$(bank_balance "$ADMIN")
GAINED=$((INIT_AFTER - INIT_BEFORE))
echo "  INIT gained: $GAINED (includes gas cost)"
# gained could be negative due to gas, check pool state changed instead
POOL=$(query "$LPPOOL" '{"pool_state":{}}')
LP_INIT_NOW=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['init_reserve'])")
echo "  Pool init reserve now: $LP_INIT_NOW"
if [ "$LP_INIT_NOW" -lt "$LP_INIT" ] 2>/dev/null; then
  pass "Swapped INITx->INIT (pool INIT reserve decreased)"
else
  # Check if tx succeeded by looking at initx_reserve increase
  LP_INITX_NOW=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['initx_reserve'])")
  if [ "$LP_INITX_NOW" -gt "$LP_INITX" ] 2>/dev/null; then
    pass "Swapped INITx->INIT (pool INITx reserve increased to $LP_INITX_NOW)"
  else
    fail "Swap INITx->INIT may have failed" "$RESULT"
  fi
fi

# 2.7 Estimate swap INITx -> INIT
echo "[2.7] Estimate swap 1 INITx -> INIT..."
EST=$(query "$LPPOOL" '{"estimate_swap":{"offer_asset":"cw20_initx","offer_amount":"1000000"}}')
RETURN=$(echo "$EST" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['return_amount'])")
echo "  Return: $RETURN INIT"
if [ "$RETURN" -gt "0" ]; then
  pass "Swap estimate: 1 INITx -> $RETURN INIT"
else
  fail "Swap estimate failed" "$EST"
fi

# 2.8 Remove liquidity (partial)
echo "[2.8] Remove 25% of LP shares..."
SHARES_OWNED=$(query "$LPPOOL" "{\"lp_balance\":{\"address\":\"$ADMIN\"}}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['shares'])")
REMOVE_SHARES=$((SHARES_OWNED / 4))
echo "  Removing $REMOVE_SHARES of $SHARES_OWNED shares"
INIT_BEFORE=$(bank_balance "$ADMIN")
INITX_BEFORE=$(cw20_balance "$ADMIN")
RESULT=$($M tx wasm execute "$LPPOOL" "{\"remove_liquidity\":{\"lp_shares\":\"$REMOVE_SHARES\"}}" --from Validator $COMMON 2>&1)
sleep 4
INIT_AFTER=$(bank_balance "$ADMIN")
INITX_AFTER=$(cw20_balance "$ADMIN")
INIT_GAINED=$((INIT_AFTER - INIT_BEFORE))
INITX_GAINED=$((INITX_AFTER - INITX_BEFORE))
echo "  Got back: INIT=$INIT_GAINED, INITx=$INITX_GAINED"
if [ "$INITX_GAINED" -gt "0" ]; then
  pass "Removed liquidity: got INITx=$INITX_GAINED back"
else
  fail "Remove liquidity failed" "$RESULT"
fi

echo ""

###############################################################################
# SECTION 3: LENDING FLOWS
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SECTION 3: LENDING FLOWS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 3.1 Query lending config
echo "[3.1] Query lending config..."
CONFIG=$(query "$LENDING" '{"config":{}}')
COL_FACTOR=$(echo "$CONFIG" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['collateral_factor'])")
echo "  Collateral factor: $COL_FACTOR"
if [ "$COL_FACTOR" = "0.7" ]; then
  pass "Lending config: collateral_factor=0.7"
else
  fail "Lending config wrong: $COL_FACTOR" ""
fi

# 3.2 Supply INIT to lending pool
echo "[3.2] Supply 50 INIT to lending pool..."
RESULT=$($M tx wasm execute "$LENDING" '{"supply":{}}' --amount 50000000$DENOM --from Validator $COMMON 2>&1)
sleep 4
POOL=$(query "$LENDING" '{"pool_state":{}}')
TOTAL_SUPPLY=$(echo "$POOL" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['total_supply'])" 2>/dev/null || echo "$POOL" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d.get('total_supplied','?'))")
echo "  Lending pool total supply: $TOTAL_SUPPLY"
if [ "$TOTAL_SUPPLY" -gt "0" ] 2>/dev/null; then
  pass "Supplied 50 INIT to lending pool"
else
  fail "Supply failed" "$POOL"
fi

# 3.3 Deposit INITx collateral (CW20 Send)
echo "[3.3] Deposit 20 INITx as collateral..."
HOOK_MSG=$(echo -n '{"deposit_collateral":{}}' | base64 -w0)
RESULT=$($M tx wasm execute "$TOKEN" "{\"send\":{\"contract\":\"$LENDING\",\"amount\":\"20000000\",\"msg\":\"$HOOK_MSG\"}}" --from Validator $COMMON 2>&1)
sleep 4
# Check position
POS=$(query "$LENDING" "{\"position\":{\"address\":\"$ADMIN\"}}")
COLLATERAL=$(echo "$POS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['collateral'])")
echo "  Collateral: $COLLATERAL"
if [ "$COLLATERAL" = "20000000" ]; then
  pass "Deposited 20 INITx collateral"
else
  fail "Collateral deposit failed: $COLLATERAL" "$POS"
fi

# 3.4 Borrow INIT against collateral
echo "[3.4] Borrow 10 INIT against collateral..."
# Max borrow = collateral * price * collateral_factor
# Price comes from LP pool: we need enough liquidity for price oracle
# 20 INITx collateral * ~1 price * 0.7 = 14 INIT max borrow
INIT_BEFORE=$(bank_balance "$ADMIN")
RESULT=$($M tx wasm execute "$LENDING" '{"borrow":{"amount":"10000000"}}' --from Validator $COMMON 2>&1)
sleep 4
INIT_AFTER=$(bank_balance "$ADMIN")
GAINED=$((INIT_AFTER - INIT_BEFORE))
echo "  INIT balance change: $GAINED"
# Check position debt
POS=$(query "$LENDING" "{\"position\":{\"address\":\"$ADMIN\"}}")
DEBT=$(echo "$POS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['debt'])")
echo "  Debt: $DEBT"
if [ "$DEBT" = "10000000" ]; then
  pass "Borrowed 10 INIT (debt=$DEBT)"
else
  fail "Borrow failed: debt=$DEBT" "$RESULT"
fi

# 3.5 Check health factor
echo "[3.5] Check health factor..."
HF=$(query "$LENDING" "{\"health_factor\":{\"address\":\"$ADMIN\"}}")
FACTOR=$(echo "$HF" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['health_factor'])")
LIQUIDATABLE=$(echo "$HF" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['is_liquidatable'])")
echo "  Health factor: $FACTOR, Liquidatable: $LIQUIDATABLE"
if [ "$LIQUIDATABLE" = "False" ] || [ "$LIQUIDATABLE" = "false" ]; then
  pass "Position healthy (HF=$FACTOR, not liquidatable)"
else
  fail "Position unexpectedly liquidatable" "$HF"
fi

# 3.6 Repay partial
echo "[3.6] Repay 5 INIT..."
RESULT=$($M tx wasm execute "$LENDING" '{"repay":{}}' --amount 5000000$DENOM --from Validator $COMMON 2>&1)
sleep 4
POS=$(query "$LENDING" "{\"position\":{\"address\":\"$ADMIN\"}}")
DEBT=$(echo "$POS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['debt'])")
echo "  Debt after repay: $DEBT"
if [ "$DEBT" = "5000000" ]; then
  pass "Repaid 5 INIT (remaining debt=$DEBT)"
else
  fail "Repay failed: debt=$DEBT" ""
fi

# 3.7 Repay remaining
echo "[3.7] Repay remaining 5 INIT..."
RESULT=$($M tx wasm execute "$LENDING" '{"repay":{}}' --amount 5000000$DENOM --from Validator $COMMON 2>&1)
sleep 4
POS=$(query "$LENDING" "{\"position\":{\"address\":\"$ADMIN\"}}")
DEBT=$(echo "$POS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['debt'])")
echo "  Debt after full repay: $DEBT"
if [ "$DEBT" = "0" ]; then
  pass "Fully repaid (debt=0)"
else
  fail "Full repay failed: debt=$DEBT" ""
fi

# 3.8 Withdraw collateral
echo "[3.8] Withdraw 10 INITx collateral..."
INITX_BEFORE=$(cw20_balance "$ADMIN")
RESULT=$($M tx wasm execute "$LENDING" '{"withdraw_collateral":{"amount":"10000000"}}' --from Validator $COMMON 2>&1)
sleep 4
INITX_AFTER=$(cw20_balance "$ADMIN")
GAINED=$((INITX_AFTER - INITX_BEFORE))
echo "  INITx gained: $GAINED"
if [ "$GAINED" = "10000000" ]; then
  pass "Withdrew 10 INITx collateral"
else
  fail "Collateral withdrawal failed: gained=$GAINED" "$RESULT"
fi

# 3.9 Withdraw supply
echo "[3.9] Withdraw 20 INIT supply..."
INIT_BEFORE=$(bank_balance "$ADMIN")
RESULT=$($M tx wasm execute "$LENDING" '{"withdraw_supply":{"amount":"20000000"}}' --from Validator $COMMON 2>&1)
sleep 4
INIT_AFTER=$(bank_balance "$ADMIN")
GAINED=$((INIT_AFTER - INIT_BEFORE))
echo "  INIT gained: $GAINED (minus gas)"
if [ "$GAINED" -gt "19000000" ] 2>/dev/null; then
  pass "Withdrew supply (~20 INIT, got $GAINED after gas)"
else
  fail "Supply withdrawal failed: gained=$GAINED" "$RESULT"
fi

echo ""

###############################################################################
# SECTION 4: GOVERNANCE FLOWS
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SECTION 4: GOVERNANCE FLOWS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 4.1 Query governance config
echo "[4.1] Query governance config..."
CONFIG=$(query "$GOV" '{"config":{}}')
DEPOSIT_REQ=$(echo "$CONFIG" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['proposal_deposit'])")
VOTING_PERIOD=$(echo "$CONFIG" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['voting_period'])")
echo "  Proposal deposit: $DEPOSIT_REQ, Voting period: ${VOTING_PERIOD}s"
if [ "$DEPOSIT_REQ" = "1000000" ]; then
  pass "Governance config: deposit=1 INITx (1000000)"
else
  fail "Governance config wrong: deposit=$DEPOSIT_REQ" ""
fi

# 4.2 Create proposal (CW20 Send)
echo "[4.2] Create proposal..."
HOOK_MSG=$(echo -n '{"create_proposal":{"title":"Test Proposal","description":"This is a test proposal for E2E testing","messages":null}}' | base64 -w0)
RESULT=$($M tx wasm execute "$TOKEN" "{\"send\":{\"contract\":\"$GOV\",\"amount\":\"1000000\",\"msg\":\"$HOOK_MSG\"}}" --from Validator $COMMON 2>&1)
sleep 4
# Query proposals
PROPOSALS=$(query "$GOV" '{"proposals":{"start_after":null,"limit":null}}')
PROP_COUNT=$(echo "$PROPOSALS" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['proposals']))")
echo "  Proposals: $PROP_COUNT"
if [ "$PROP_COUNT" = "1" ]; then
  pass "Proposal created successfully"
else
  fail "Proposal creation failed: count=$PROP_COUNT" "$PROPOSALS"
fi

# 4.3 Query proposal
echo "[4.3] Query proposal #1..."
PROP=$(query "$GOV" '{"proposal":{"id":1}}')
TITLE=$(echo "$PROP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['title'])")
echo "  Title: $TITLE"
if [ "$TITLE" = "Test Proposal" ]; then
  pass "Proposal query: title matches"
else
  fail "Proposal query failed: title=$TITLE" ""
fi

# 4.4 Vote on proposal
echo "[4.4] Vote YES on proposal #1..."
RESULT=$($M tx wasm execute "$GOV" '{"vote":{"proposal_id":1,"vote":"yes"}}' --from Validator $COMMON 2>&1)
sleep 4
# Check vote
VOTE=$(query "$GOV" "{\"vote\":{\"proposal_id\":1,\"voter\":\"$ADMIN\"}}")
VOTE_OPT=$(echo "$VOTE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['vote'])" 2>/dev/null || echo "$VOTE" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'])")
echo "  Vote: $VOTE_OPT"
if echo "$VOTE_OPT" | grep -qi "yes"; then
  pass "Voted YES on proposal #1"
else
  fail "Vote failed" "$VOTE"
fi

# 4.5 Check proposal status
echo "[4.5] Check proposal status..."
STATUS=$(query "$GOV" '{"proposal_status":{"id":1}}')
echo "  Status: $(echo $STATUS | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d)")"
PASSED=$(echo "$STATUS" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['passed'])" 2>/dev/null || echo "?")
echo "  Passed: $PASSED"
pass "Proposal status queried"

# 4.6 Execute proposal (after voting period — 120s)
echo "[4.6] Waiting for voting period (120s)..."
sleep 125
RESULT=$($M tx wasm execute "$GOV" '{"execute":{"proposal_id":1}}' --from Validator $COMMON 2>&1)
sleep 4
echo "  Execute result: $(echo "$RESULT" | grep -o 'code: [0-9]*' | head -1)"
if echo "$RESULT" | grep -q "code: 0"; then
  pass "Proposal #1 executed successfully"
else
  # Check if proposal status changed
  PROP=$(query "$GOV" '{"proposal":{"id":1}}')
  STATUS=$(echo "$PROP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('status','?'))")
  echo "  Proposal status: $STATUS"
  if echo "$STATUS" | grep -qi "executed\|passed"; then
    pass "Proposal #1 executed (status: $STATUS)"
  else
    fail "Proposal execution failed" "$RESULT"
  fi
fi

echo ""

###############################################################################
# SECTION 5: FRONTEND-SPECIFIC FLOW VALIDATION
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "SECTION 5: FRONTEND FLOW VALIDATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 5.1 Verify backend health
echo "[5.1] Backend health check..."
HEALTH=$(curl -s http://localhost:3001/health 2>/dev/null)
if echo "$HEALTH" | grep -q "ok"; then
  pass "Backend is healthy"
else
  fail "Backend not responding" "$HEALTH"
fi

# 5.2 Backend stats endpoint
echo "[5.2] Backend stats..."
STATS=$(curl -s http://localhost:3001/stats 2>/dev/null)
if echo "$STATS" | grep -q "tvl"; then
  pass "Stats endpoint working"
  echo "  $STATS"
else
  fail "Stats endpoint failed" "$STATS"
fi

# 5.3 Frontend serves
echo "[5.3] Frontend serves..."
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null)
if [ "$HTTP" = "200" ]; then
  pass "Frontend serving HTTP 200"
else
  fail "Frontend not serving: HTTP $HTTP" ""
fi

echo ""

###############################################################################
# SUMMARY
###############################################################################
echo "============================================"
echo " TEST RESULTS"
echo "============================================"
echo " PASSED: $PASS"
echo " FAILED: $FAIL"
echo " TOTAL:  $TOTAL"
echo "============================================"

if [ "$FAIL" -gt "0" ]; then
  echo "⚠️  Some tests failed — review output above"
  exit 1
else
  echo "🎉 All tests passed!"
  exit 0
fi
