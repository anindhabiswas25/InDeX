use cosmwasm_std::{
    entry_point, from_json, to_json_binary, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Order, Response, StdResult, Uint128, WasmMsg,
};
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::*;
use crate::state::*;

const CONTRACT_NAME: &str = "crates.io:initx-staking";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const RATE_PRECISION: u128 = 1_000_000;

// ──────────────────────────── Instantiate ────────────────────────────

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let config = Config {
        initx_token: deps.api.addr_validate(&msg.initx_token)?,
        treasury: deps.api.addr_validate(&msg.treasury)?,
        keeper: deps.api.addr_validate(&msg.keeper)?,
        admin: info.sender.clone(),
        init_denom: msg.init_denom.clone(),
        protocol_fee_bps: msg.protocol_fee_bps,
        cooldown_period: msg.cooldown_period,
        validator: msg.validator,
        paused: false,
    };
    CONFIG.save(deps.storage, &config)?;

    // Determine initial buffer from sent funds
    let sent = info
        .funds
        .iter()
        .find(|c| c.denom == msg.init_denom)
        .map(|c| c.amount)
        .unwrap_or_default();

    let pool_state = PoolState {
        total_init_staked: Uint128::zero(),
        total_initx_supply: Uint128::zero(),
        liquidity_buffer: sent,
        treasury_balance: Uint128::zero(),
    };
    POOL_STATE.save(deps.storage, &pool_state)?;
    NEXT_WITHDRAWAL_ID.save(deps.storage, &0u64)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("admin", info.sender)
        .add_attribute("buffer", sent))
}

// ──────────────────────────── Execute ────────────────────────────

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Deposit {} => exec_deposit(deps, env, info),
        ExecuteMsg::Receive(cw20_msg) => exec_receive_cw20(deps, env, info, cw20_msg),
        ExecuteMsg::RequestWithdrawal { initx_amount } => {
            exec_request_withdrawal(deps, env, info, initx_amount)
        }
        ExecuteMsg::ClaimWithdrawal { withdrawal_id } => {
            exec_claim_withdrawal(deps, env, info, withdrawal_id)
        }
        ExecuteMsg::AddRewards {} => exec_add_rewards(deps, info),
        ExecuteMsg::ApplySlashing { amount } => exec_apply_slashing(deps, info, amount),
        ExecuteMsg::UpdateConfig {
            treasury,
            keeper,
            protocol_fee_bps,
            cooldown_period,
            validator,
        } => exec_update_config(
            deps,
            info,
            treasury,
            keeper,
            protocol_fee_bps,
            cooldown_period,
            validator,
        ),
        ExecuteMsg::ReplenishBuffer { amount } => exec_replenish_buffer(deps, info, amount),
        ExecuteMsg::Pause {} => exec_pause(deps, info),
        ExecuteMsg::Unpause {} => exec_unpause(deps, info),
        ExecuteMsg::WithdrawFees {} => exec_withdraw_fees(deps, info),
        ExecuteMsg::RecalibrateRate {} => exec_recalibrate_rate(deps, info),
    }
}

/// Handle CW20 Receive — dispatches based on inner hook message
fn exec_receive_cw20(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    cw20_msg: cw20::Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;

    // Only accept INITx token
    if info.sender != config.initx_token {
        return Err(ContractError::Unauthorized {});
    }

    let sender = deps.api.addr_validate(&cw20_msg.sender)?;
    let amount = cw20_msg.amount;

    let hook_msg: Cw20HookMsg = from_json(&cw20_msg.msg)?;
    match hook_msg {
        Cw20HookMsg::RequestWithdrawal {} => {
            exec_withdrawal_via_send(deps, env, sender, amount)
        }
    }
}

/// Process withdrawal when INITx is sent via CW20 Send pattern.
/// The INITx is already transferred to this contract, so we just burn it.
fn exec_withdrawal_via_send(
    deps: DepsMut,
    env: Env,
    sender: cosmwasm_std::Addr,
    initx_amount: Uint128,
) -> Result<Response, ContractError> {
    if initx_amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;

    if config.paused {
        return Err(ContractError::Paused {});
    }

    // Calculate INIT owed at current exchange rate
    let init_owed = if pool.total_initx_supply.is_zero() {
        initx_amount
    } else {
        initx_amount
            .checked_mul(pool.total_init_staked)
            .map_err(|_| ContractError::Overflow {})?
            .checked_div(pool.total_initx_supply)
            .map_err(|_| ContractError::Overflow {})?
    };

    // Update pool state (burn INITx, reduce total staked)
    pool.total_initx_supply -= initx_amount;
    pool.total_init_staked -= init_owed;
    POOL_STATE.save(deps.storage, &pool)?;

    let mut msgs: Vec<CosmosMsg> = vec![];

    // Burn the INITx that was sent to this contract
    let burn_msg = WasmMsg::Execute {
        contract_addr: config.initx_token.to_string(),
        msg: to_json_binary(&initx_token::msg::ExecuteMsg::Burn {
            amount: initx_amount,
        })?,
        funds: vec![],
    };
    msgs.push(burn_msg.into());

    // Check if instant withdrawal is possible
    if pool.liquidity_buffer >= init_owed {
        pool.liquidity_buffer -= init_owed;
        POOL_STATE.save(deps.storage, &pool)?;

        let send_msg = BankMsg::Send {
            to_address: sender.to_string(),
            amount: vec![Coin {
                denom: config.init_denom,
                amount: init_owed,
            }],
        };
        msgs.push(send_msg.into());

        Ok(Response::new()
            .add_messages(msgs)
            .add_attribute("action", "instant_withdrawal")
            .add_attribute("user", sender)
            .add_attribute("initx_burned", initx_amount)
            .add_attribute("init_returned", init_owed))
    } else {
        // Queued withdrawal
        let id = NEXT_WITHDRAWAL_ID.load(deps.storage)?;
        let request = WithdrawalRequest {
            init_amount: init_owed,
            ready_at: env.block.time.seconds() + config.cooldown_period,
        };
        WITHDRAWALS.save(deps.storage, (&sender, id), &request)?;
        NEXT_WITHDRAWAL_ID.save(deps.storage, &(id + 1))?;

        Ok(Response::new()
            .add_messages(msgs)
            .add_attribute("action", "queued_withdrawal")
            .add_attribute("user", sender)
            .add_attribute("withdrawal_id", id.to_string())
            .add_attribute("initx_burned", initx_amount)
            .add_attribute("init_owed", init_owed)
            .add_attribute("ready_at", request.ready_at.to_string()))
    }
}

/// Deposit INIT → receive INITx
fn exec_deposit(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;

    if config.paused {
        return Err(ContractError::Paused {});
    }

    // Extract INIT from sent funds
    let deposit_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.init_denom)
        .map(|c| c.amount)
        .unwrap_or_default();

    if deposit_amount.is_zero() {
        return Err(ContractError::NoFunds {});
    }

    // Calculate INITx to mint
    // If first deposit: 1:1 ratio
    // Otherwise: initx_to_mint = deposit_amount * total_initx_supply / total_init_staked
    let initx_to_mint = if pool.total_initx_supply.is_zero() || pool.total_init_staked.is_zero() {
        deposit_amount
    } else {
        deposit_amount
            .checked_mul(pool.total_initx_supply)
            .map_err(|_| ContractError::Overflow {})?
            .checked_div(pool.total_init_staked)
            .map_err(|_| ContractError::Overflow {})?
    };

    if initx_to_mint.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    // Update pool state — all INIT stays in contract (simulated yield model for rollup)
    pool.total_init_staked += deposit_amount;
    pool.total_initx_supply += initx_to_mint;
    pool.liquidity_buffer += deposit_amount; // All funds go to buffer (no real delegation on rollup)
    POOL_STATE.save(deps.storage, &pool)?;

    // Build messages
    let mut msgs: Vec<CosmosMsg> = vec![];

    // Mint INITx to depositor
    let mint_msg = WasmMsg::Execute {
        contract_addr: config.initx_token.to_string(),
        msg: to_json_binary(&initx_token::msg::ExecuteMsg::Mint {
            recipient: info.sender.to_string(),
            amount: initx_to_mint,
        })?,
        funds: vec![],
    };
    msgs.push(mint_msg.into());

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "deposit")
        .add_attribute("user", info.sender)
        .add_attribute("init_deposited", deposit_amount)
        .add_attribute("initx_minted", initx_to_mint)
        .add_attribute("exchange_rate", calc_rate(&pool)))
}

/// Request withdrawal: burn INITx, get INIT (instant or queued)
fn exec_request_withdrawal(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    initx_amount: Uint128,
) -> Result<Response, ContractError> {
    if initx_amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;

    if config.paused {
        return Err(ContractError::Paused {});
    }

    // Calculate INIT owed at current exchange rate
    let init_owed = if pool.total_initx_supply.is_zero() {
        initx_amount
    } else {
        initx_amount
            .checked_mul(pool.total_init_staked)
            .map_err(|_| ContractError::Overflow {})?
            .checked_div(pool.total_initx_supply)
            .map_err(|_| ContractError::Overflow {})?
    };

    // Update pool state (burn INITx, reduce total staked)
    pool.total_initx_supply -= initx_amount;
    pool.total_init_staked -= init_owed;
    POOL_STATE.save(deps.storage, &pool)?;

    let mut msgs: Vec<CosmosMsg> = vec![];

    // Burn INITx from the user (user must have granted allowance to this contract,
    // or we use Send pattern). For simplicity, user calls this directly and we
    // burn from the user's balance using BurnFrom with allowance.
    let burn_msg = WasmMsg::Execute {
        contract_addr: config.initx_token.to_string(),
        msg: to_json_binary(&initx_token::msg::ExecuteMsg::BurnFrom {
            owner: info.sender.to_string(),
            amount: initx_amount,
        })?,
        funds: vec![],
    };
    msgs.push(burn_msg.into());

    // Check if instant withdrawal is possible
    if pool.liquidity_buffer >= init_owed {
        // Instant withdrawal from buffer
        pool.liquidity_buffer -= init_owed;
        POOL_STATE.save(deps.storage, &pool)?;

        let send_msg = BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: config.init_denom,
                amount: init_owed,
            }],
        };
        msgs.push(send_msg.into());

        Ok(Response::new()
            .add_messages(msgs)
            .add_attribute("action", "instant_withdrawal")
            .add_attribute("user", info.sender)
            .add_attribute("initx_burned", initx_amount)
            .add_attribute("init_returned", init_owed))
    } else {
        // Queued withdrawal — cooldown period applies (simulated, no real undelegation)

        // Store in withdrawal queue
        let id = NEXT_WITHDRAWAL_ID.load(deps.storage)?;
        let request = WithdrawalRequest {
            init_amount: init_owed,
            ready_at: env.block.time.seconds() + config.cooldown_period,
        };
        WITHDRAWALS.save(deps.storage, (&info.sender, id), &request)?;
        NEXT_WITHDRAWAL_ID.save(deps.storage, &(id + 1))?;

        Ok(Response::new()
            .add_messages(msgs)
            .add_attribute("action", "queued_withdrawal")
            .add_attribute("user", info.sender)
            .add_attribute("withdrawal_id", id.to_string())
            .add_attribute("initx_burned", initx_amount)
            .add_attribute("init_owed", init_owed)
            .add_attribute("ready_at", request.ready_at.to_string()))
    }
}

/// Claim a queued withdrawal after cooldown
fn exec_claim_withdrawal(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    withdrawal_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let request = WITHDRAWALS
        .may_load(deps.storage, (&info.sender, withdrawal_id))?
        .ok_or(ContractError::WithdrawalNotFound {})?;

    if env.block.time.seconds() < request.ready_at {
        return Err(ContractError::WithdrawalNotReady {
            ready_at: request.ready_at,
            current: env.block.time.seconds(),
        });
    }

    // Remove from queue
    WITHDRAWALS.remove(deps.storage, (&info.sender, withdrawal_id));

    // Send INIT to user (unbonded funds should be in the contract now)
    let send_msg = BankMsg::Send {
        to_address: info.sender.to_string(),
        amount: vec![Coin {
            denom: config.init_denom,
            amount: request.init_amount,
        }],
    };

    Ok(Response::new()
        .add_message(send_msg)
        .add_attribute("action", "claim_withdrawal")
        .add_attribute("user", info.sender)
        .add_attribute("withdrawal_id", withdrawal_id.to_string())
        .add_attribute("init_claimed", request.init_amount))
}

/// Add rewards — called by keeper. 10% to treasury, 90% increases exchange rate.
fn exec_add_rewards(
    deps: DepsMut,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;

    // Only keeper can call
    if info.sender != config.keeper {
        return Err(ContractError::Unauthorized {});
    }

    // Extract INIT from sent funds
    let reward_amount = info
        .funds
        .iter()
        .find(|c| c.denom == config.init_denom)
        .map(|c| c.amount)
        .unwrap_or_default();

    if reward_amount.is_zero() {
        return Err(ContractError::NoFunds {});
    }

    // Split: protocol fee goes to treasury, rest increases total_init_staked
    let protocol_fee = reward_amount.multiply_ratio(
        config.protocol_fee_bps as u128,
        10_000u128,
    );
    let staker_reward = reward_amount - protocol_fee;

    let mut pool = POOL_STATE.load(deps.storage)?;
    pool.total_init_staked += staker_reward;
    pool.treasury_balance += protocol_fee;
    POOL_STATE.save(deps.storage, &pool)?;

    Ok(Response::new()
        .add_attribute("action", "add_rewards")
        .add_attribute("total_reward", reward_amount)
        .add_attribute("protocol_fee", protocol_fee)
        .add_attribute("staker_reward", staker_reward)
        .add_attribute("new_exchange_rate", calc_rate(&pool)))
}

/// Apply slashing — reduces total_init_staked, lowering exchange rate
fn exec_apply_slashing(
    deps: DepsMut,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin && info.sender != config.keeper {
        return Err(ContractError::Unauthorized {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    pool.total_init_staked = pool.total_init_staked.saturating_sub(amount);
    POOL_STATE.save(deps.storage, &pool)?;

    Ok(Response::new()
        .add_attribute("action", "apply_slashing")
        .add_attribute("slashed_amount", amount)
        .add_attribute("new_exchange_rate", calc_rate(&pool)))
}

/// Update config (admin only)
fn exec_update_config(
    deps: DepsMut,
    info: MessageInfo,
    treasury: Option<String>,
    keeper: Option<String>,
    protocol_fee_bps: Option<u16>,
    cooldown_period: Option<u64>,
    validator: Option<String>,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }

    if let Some(t) = treasury {
        config.treasury = deps.api.addr_validate(&t)?;
    }
    if let Some(k) = keeper {
        config.keeper = deps.api.addr_validate(&k)?;
    }
    if let Some(f) = protocol_fee_bps {
        config.protocol_fee_bps = f;
    }
    if let Some(c) = cooldown_period {
        config.cooldown_period = c;
    }
    if let Some(v) = validator {
        config.validator = v;
    }

    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

/// Replenish buffer from contract's held INIT
fn exec_replenish_buffer(
    deps: DepsMut,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin && info.sender != config.keeper {
        return Err(ContractError::Unauthorized {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    pool.liquidity_buffer += amount;
    POOL_STATE.save(deps.storage, &pool)?;

    Ok(Response::new()
        .add_attribute("action", "replenish_buffer")
        .add_attribute("amount", amount))
}

/// Pause the contract (admin only)
fn exec_pause(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    config.paused = true;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "pause"))
}

/// Unpause the contract (admin only)
fn exec_unpause(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    config.paused = false;
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "unpause"))
}

/// Withdraw accumulated treasury fees (admin only)
fn exec_withdraw_fees(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    let amount = pool.treasury_balance;
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    pool.treasury_balance = Uint128::zero();
    POOL_STATE.save(deps.storage, &pool)?;

    let send_msg = BankMsg::Send {
        to_address: config.treasury.to_string(),
        amount: vec![Coin {
            denom: config.init_denom,
            amount,
        }],
    };

    Ok(Response::new()
        .add_message(send_msg)
        .add_attribute("action", "withdraw_fees")
        .add_attribute("amount", amount))
}

/// Recalibrate rate — emit current exchange rate for off-chain indexers
fn exec_recalibrate_rate(deps: DepsMut, info: MessageInfo) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin && info.sender != config.keeper {
        return Err(ContractError::Unauthorized {});
    }

    let pool = POOL_STATE.load(deps.storage)?;
    Ok(Response::new()
        .add_attribute("action", "recalibrate_rate")
        .add_attribute("exchange_rate", calc_rate(&pool)))
}

// ──────────────────────────── Query ────────────────────────────

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&query_config(deps)?),
        QueryMsg::PoolState {} => to_json_binary(&query_pool_state(deps)?),
        QueryMsg::ExchangeRate {} => to_json_binary(&query_exchange_rate(deps)?),
        QueryMsg::Withdrawals { user } => to_json_binary(&query_withdrawals(deps, user)?),
        QueryMsg::EstimateDeposit { amount } => {
            to_json_binary(&query_estimate_deposit(deps, amount)?)
        }
        QueryMsg::EstimateWithdrawal { initx_amount } => {
            to_json_binary(&query_estimate_withdrawal(deps, initx_amount)?)
        }
        QueryMsg::IsPaused {} => to_json_binary(&query_is_paused(deps)?),
        QueryMsg::TreasuryBalance {} => to_json_binary(&query_treasury_balance(deps)?),
    }
}

fn query_config(deps: Deps) -> StdResult<ConfigResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(ConfigResponse {
        initx_token: config.initx_token.to_string(),
        treasury: config.treasury.to_string(),
        keeper: config.keeper.to_string(),
        init_denom: config.init_denom,
        protocol_fee_bps: config.protocol_fee_bps,
        cooldown_period: config.cooldown_period,
        validator: config.validator,
    })
}

fn query_pool_state(deps: Deps) -> StdResult<PoolStateResponse> {
    let pool = POOL_STATE.load(deps.storage)?;
    Ok(PoolStateResponse {
        total_init_staked: pool.total_init_staked,
        total_initx_supply: pool.total_initx_supply,
        liquidity_buffer: pool.liquidity_buffer,
    })
}

fn query_exchange_rate(deps: Deps) -> StdResult<ExchangeRateResponse> {
    let pool = POOL_STATE.load(deps.storage)?;
    let rate = calc_rate(&pool);
    let rate_u128: u128 = rate.parse().unwrap_or(RATE_PRECISION);
    let whole = rate_u128 / RATE_PRECISION;
    let frac = rate_u128 % RATE_PRECISION;
    Ok(ExchangeRateResponse {
        rate: Uint128::new(rate_u128),
        rate_display: format!("{}.{:06}", whole, frac),
    })
}

fn query_withdrawals(deps: Deps, user: String) -> StdResult<WithdrawalsResponse> {
    let user_addr = deps.api.addr_validate(&user)?;
    let withdrawals: Vec<WithdrawalInfo> = WITHDRAWALS
        .prefix(&user_addr)
        .range(deps.storage, None, None, Order::Ascending)
        .map(|item| {
            let (id, req) = item?;
            Ok(WithdrawalInfo {
                id,
                init_amount: req.init_amount,
                ready_at: req.ready_at,
            })
        })
        .collect::<StdResult<Vec<_>>>()?;

    Ok(WithdrawalsResponse { withdrawals })
}

fn query_estimate_deposit(deps: Deps, amount: Uint128) -> StdResult<EstimateDepositResponse> {
    let pool = POOL_STATE.load(deps.storage)?;
    let initx_amount = if pool.total_initx_supply.is_zero() || pool.total_init_staked.is_zero() {
        amount
    } else {
        amount
            .checked_mul(pool.total_initx_supply)?
            .checked_div(pool.total_init_staked)?
    };
    Ok(EstimateDepositResponse {
        initx_amount,
    })
}

fn query_estimate_withdrawal(
    deps: Deps,
    initx_amount: Uint128,
) -> StdResult<EstimateWithdrawalResponse> {
    let pool = POOL_STATE.load(deps.storage)?;
    let init_amount = if pool.total_initx_supply.is_zero() {
        initx_amount
    } else {
        initx_amount
            .checked_mul(pool.total_init_staked)?
            .checked_div(pool.total_initx_supply)?
    };
    Ok(EstimateWithdrawalResponse { init_amount })
}

fn query_is_paused(deps: Deps) -> StdResult<IsPausedResponse> {
    let config = CONFIG.load(deps.storage)?;
    Ok(IsPausedResponse {
        paused: config.paused,
    })
}

fn query_treasury_balance(deps: Deps) -> StdResult<TreasuryBalanceResponse> {
    let pool = POOL_STATE.load(deps.storage)?;
    Ok(TreasuryBalanceResponse {
        treasury_balance: pool.treasury_balance,
    })
}

// ──────────────────────────── Helpers ────────────────────────────

/// Calculate exchange rate as string (scaled by RATE_PRECISION)
fn calc_rate(pool: &PoolState) -> String {
    if pool.total_initx_supply.is_zero() {
        return RATE_PRECISION.to_string();
    }
    let rate = pool
        .total_init_staked
        .checked_mul(Uint128::new(RATE_PRECISION))
        .unwrap_or(Uint128::new(RATE_PRECISION))
        .checked_div(pool.total_initx_supply)
        .unwrap_or(Uint128::new(RATE_PRECISION));
    rate.to_string()
}

// ──────────────────────────── Tests ────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, message_info, MockApi};
    use cosmwasm_std::{Addr, Coin, Timestamp};

    fn mock_addr(label: &str) -> Addr {
        MockApi::default().addr_make(label)
    }

    fn setup(deps: DepsMut) -> (Addr, Addr, Addr, Addr) {
        let admin = mock_addr("admin");
        let token = mock_addr("initx_token");
        let treasury = mock_addr("treasury");
        let keeper = mock_addr("keeper");

        let msg = InstantiateMsg {
            initx_token: token.to_string(),
            treasury: treasury.to_string(),
            keeper: keeper.to_string(),
            init_denom: "uinit".to_string(),
            protocol_fee_bps: 1000, // 10%
            cooldown_period: 100,   // 100s for testing
            validator: "validator1".to_string(),
            buffer_percentage_bps: 1000,
        };
        let info = message_info(&admin, &[]);
        instantiate(deps, mock_env(), info, msg).unwrap();

        (admin, token, treasury, keeper)
    }

    #[test]
    fn test_instantiate() {
        let mut deps = mock_dependencies();
        let (admin, token, treasury, keeper) = setup(deps.as_mut());

        let config = CONFIG.load(&deps.storage).unwrap();
        assert_eq!(config.admin, admin);
        assert_eq!(config.initx_token, token);
        assert_eq!(config.treasury, treasury);
        assert_eq!(config.keeper, keeper);
        assert_eq!(config.init_denom, "uinit");
        assert_eq!(config.protocol_fee_bps, 1000);

        let pool = POOL_STATE.load(&deps.storage).unwrap();
        assert_eq!(pool.total_init_staked, Uint128::zero());
        assert_eq!(pool.total_initx_supply, Uint128::zero());
        assert_eq!(pool.treasury_balance, Uint128::zero());
        assert!(!config.paused);
    }

    #[test]
    fn test_deposit_first_user() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        let res = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Should have 1 message: mint (no delegation on rollup)
        assert_eq!(res.messages.len(), 1);

        let pool = POOL_STATE.load(&deps.storage).unwrap();
        // First deposit: 1:1 ratio
        assert_eq!(pool.total_init_staked, Uint128::new(1_000_000));
        assert_eq!(pool.total_initx_supply, Uint128::new(1_000_000));
        // All funds in buffer (simulated yield)
        assert_eq!(pool.liquidity_buffer, Uint128::new(1_000_000));
    }

    #[test]
    fn test_deposit_no_funds_fails() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let user = mock_addr("user1");
        let info = message_info(&user, &[]);
        let err = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap_err();
        assert_eq!(err, ContractError::NoFunds {});
    }

    #[test]
    fn test_add_rewards_increases_rate() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, keeper) = setup(deps.as_mut());

        // First deposit: 1M uinit
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Add 100k reward (keeper)
        let info = message_info(&keeper, &[Coin::new(100_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::AddRewards {}).unwrap();

        let pool = POOL_STATE.load(&deps.storage).unwrap();
        // 10% fee = 10k to treasury_balance, 90k to stakers
        // total_init_staked = 1_000_000 + 90_000 = 1_090_000
        assert_eq!(pool.total_init_staked, Uint128::new(1_090_000));
        // Supply unchanged
        assert_eq!(pool.total_initx_supply, Uint128::new(1_000_000));
        // Treasury balance accumulated
        assert_eq!(pool.treasury_balance, Uint128::new(10_000));
    }

    #[test]
    fn test_add_rewards_unauthorized() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let random = mock_addr("random");
        let info = message_info(&random, &[Coin::new(100_000u128, "uinit")]);
        let err = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::AddRewards {}).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn test_slashing_decreases_rate() {
        let mut deps = mock_dependencies();
        let (admin, _token, _treasury, _keeper) = setup(deps.as_mut());

        // Deposit
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Slash 100k
        let info = message_info(&admin, &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::ApplySlashing {
                amount: Uint128::new(100_000),
            },
        )
        .unwrap();

        let pool = POOL_STATE.load(&deps.storage).unwrap();
        assert_eq!(pool.total_init_staked, Uint128::new(900_000));
    }

    #[test]
    fn test_queued_withdrawal() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, _keeper) = setup(deps.as_mut());

        // Deposit 1M (buffer = 1M in simulated model)
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Drain most of the buffer first with an instant withdrawal
        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info.clone(),
            ExecuteMsg::RequestWithdrawal {
                initx_amount: Uint128::new(800_000),
            },
        )
        .unwrap();

        // Now request more than remaining buffer (200k buffer, request remaining 200k INITx)
        // But pool state changed: total_init_staked=200k, total_initx=200k, buffer should be 200k
        // Manually reduce buffer to force a queued withdrawal
        let mut pool = POOL_STATE.load(&deps.storage).unwrap();
        pool.liquidity_buffer = Uint128::zero();
        POOL_STATE.save(&mut deps.storage, &pool).unwrap();

        let res = execute(
            deps.as_mut(),
            mock_env(),
            info.clone(),
            ExecuteMsg::RequestWithdrawal {
                initx_amount: Uint128::new(100_000),
            },
        )
        .unwrap();

        assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "queued_withdrawal"));

        // Query withdrawal
        let withdrawals = query_withdrawals(deps.as_ref(), user.to_string()).unwrap();
        assert_eq!(withdrawals.withdrawals.len(), 1);
        assert_eq!(withdrawals.withdrawals[0].init_amount, Uint128::new(100_000));
    }

    #[test]
    fn test_claim_before_cooldown_fails() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, _keeper) = setup(deps.as_mut());

        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Force empty buffer to trigger queued withdrawal
        let mut pool = POOL_STATE.load(&deps.storage).unwrap();
        pool.liquidity_buffer = Uint128::zero();
        POOL_STATE.save(&mut deps.storage, &pool).unwrap();

        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info.clone(),
            ExecuteMsg::RequestWithdrawal {
                initx_amount: Uint128::new(500_000),
            },
        )
        .unwrap();

        // Try to claim immediately — should fail
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::ClaimWithdrawal { withdrawal_id: 0 },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::WithdrawalNotReady { .. }));
    }

    #[test]
    fn test_claim_after_cooldown() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, _keeper) = setup(deps.as_mut());

        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Force empty buffer to trigger queued withdrawal
        let mut pool = POOL_STATE.load(&deps.storage).unwrap();
        pool.liquidity_buffer = Uint128::zero();
        POOL_STATE.save(&mut deps.storage, &pool).unwrap();

        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            mock_env(),
            info.clone(),
            ExecuteMsg::RequestWithdrawal {
                initx_amount: Uint128::new(500_000),
            },
        )
        .unwrap();

        // Fast forward time past cooldown (100s)
        let mut env = mock_env();
        env.block.time = Timestamp::from_seconds(env.block.time.seconds() + 200);

        let res = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::ClaimWithdrawal { withdrawal_id: 0 },
        )
        .unwrap();

        assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "claim_withdrawal"));
    }

    #[test]
    fn test_exchange_rate_query() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, keeper) = setup(deps.as_mut());

        // Before any deposit: rate should be 1.0
        let rate = query_exchange_rate(deps.as_ref()).unwrap();
        assert_eq!(rate.rate, Uint128::new(1_000_000));

        // Deposit
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Rate still 1.0 after first deposit
        let rate = query_exchange_rate(deps.as_ref()).unwrap();
        assert_eq!(rate.rate, Uint128::new(1_000_000));

        // Add rewards → rate increases
        let info = message_info(&keeper, &[Coin::new(100_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::AddRewards {}).unwrap();

        let rate = query_exchange_rate(deps.as_ref()).unwrap();
        // 1_090_000 * 1_000_000 / 1_000_000 = 1_090_000
        assert_eq!(rate.rate, Uint128::new(1_090_000));
    }

    #[test]
    fn test_estimate_deposit_after_rate_change() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, keeper) = setup(deps.as_mut());

        // First deposit
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Add rewards to change rate
        let info = message_info(&keeper, &[Coin::new(100_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::AddRewards {}).unwrap();

        // Estimate: 1M uinit should now mint fewer INITx
        let est = query_estimate_deposit(deps.as_ref(), Uint128::new(1_000_000)).unwrap();
        // 1_000_000 * 1_000_000 / 1_090_000 = ~917_431
        assert!(est.initx_amount < Uint128::new(1_000_000));
        assert!(est.initx_amount > Uint128::new(900_000));
    }

    #[test]
    fn test_pause_unpause() {
        let mut deps = mock_dependencies();
        let (admin, _token, _treasury, _keeper) = setup(deps.as_mut());

        // Pause
        let info = message_info(&admin, &[]);
        execute(deps.as_mut(), mock_env(), info.clone(), ExecuteMsg::Pause {}).unwrap();

        let config = CONFIG.load(&deps.storage).unwrap();
        assert!(config.paused);

        // Query
        let res = query_is_paused(deps.as_ref()).unwrap();
        assert!(res.paused);

        // Deposit should fail when paused
        let user = mock_addr("user1");
        let user_info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        let err = execute(deps.as_mut(), mock_env(), user_info, ExecuteMsg::Deposit {}).unwrap_err();
        assert_eq!(err, ContractError::Paused {});

        // RequestWithdrawal should fail when paused
        let user_info = message_info(&user, &[]);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            user_info,
            ExecuteMsg::RequestWithdrawal {
                initx_amount: Uint128::new(100),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Paused {});

        // Unpause
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Unpause {}).unwrap();
        let config = CONFIG.load(&deps.storage).unwrap();
        assert!(!config.paused);
    }

    #[test]
    fn test_pause_unauthorized() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let random = mock_addr("random");
        let info = message_info(&random, &[]);
        let err = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Pause {}).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn test_withdraw_fees() {
        let mut deps = mock_dependencies();
        let (admin, _token, _treasury, keeper) = setup(deps.as_mut());

        // Deposit
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Add rewards to accumulate fees
        let info = message_info(&keeper, &[Coin::new(100_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::AddRewards {}).unwrap();

        // Check treasury balance query
        let res = query_treasury_balance(deps.as_ref()).unwrap();
        assert_eq!(res.treasury_balance, Uint128::new(10_000));

        // Withdraw fees
        let info = message_info(&admin, &[]);
        let res = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::WithdrawFees {}).unwrap();
        assert_eq!(res.messages.len(), 1);
        assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "withdraw_fees"));

        // Treasury balance should be zero now
        let pool = POOL_STATE.load(&deps.storage).unwrap();
        assert_eq!(pool.treasury_balance, Uint128::zero());
    }

    #[test]
    fn test_withdraw_fees_zero() {
        let mut deps = mock_dependencies();
        let (admin, _token, _treasury, _keeper) = setup(deps.as_mut());

        let info = message_info(&admin, &[]);
        let err = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::WithdrawFees {}).unwrap_err();
        assert_eq!(err, ContractError::ZeroAmount {});
    }

    #[test]
    fn test_withdraw_fees_unauthorized() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let random = mock_addr("random");
        let info = message_info(&random, &[]);
        let err = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::WithdrawFees {}).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn test_recalibrate_rate() {
        let mut deps = mock_dependencies();
        let (_admin, _token, _treasury, keeper) = setup(deps.as_mut());

        // Deposit
        let user = mock_addr("user1");
        let info = message_info(&user, &[Coin::new(1_000_000u128, "uinit")]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Deposit {}).unwrap();

        // Recalibrate as keeper
        let info = message_info(&keeper, &[]);
        let res = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::RecalibrateRate {}).unwrap();
        assert!(res.attributes.iter().any(|a| a.key == "action" && a.value == "recalibrate_rate"));
        assert!(res.attributes.iter().any(|a| a.key == "exchange_rate"));

        // No state change
        let pool = POOL_STATE.load(&deps.storage).unwrap();
        assert_eq!(pool.total_init_staked, Uint128::new(1_000_000));
    }

    #[test]
    fn test_recalibrate_rate_unauthorized() {
        let mut deps = mock_dependencies();
        setup(deps.as_mut());

        let random = mock_addr("random");
        let info = message_info(&random, &[]);
        let err = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::RecalibrateRate {}).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }
}
