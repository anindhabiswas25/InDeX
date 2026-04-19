use cosmwasm_std::{
    entry_point, to_json_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Decimal, Deps, DepsMut,
    Env, Fraction, MessageInfo, Response, StdError, StdResult, Uint128, Uint256, WasmMsg,
};
use cw2::set_contract_version;
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};

use crate::error::ContractError;
use crate::msg::{
    AccruedProtocolFeesResponse, Cw20HookMsg, ExecuteMsg, HealthFactorResponse, InstantiateMsg,
    PositionResponse, QueryMsg,
};
use crate::state::{Config, PoolState, UserPosition, CONFIG, LENDER_DEPOSITS, POOL_STATE, POSITIONS};

const CONTRACT_NAME: &str = "crates.io:initx-lending";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const SECONDS_PER_YEAR: u128 = 365 * 24 * 3600;

// ── Helpers ──

fn extract_native(info: &MessageInfo, denom: &str) -> Uint128 {
    info.funds
        .iter()
        .find(|c| c.denom == denom)
        .map(|c| c.amount)
        .unwrap_or(Uint128::zero())
}

/// For MVP, INITx price in INIT = 1:1 (simplification).
/// In production, query LP pool reserves: price = init_reserve / initx_reserve.
fn get_initx_price(_deps: Deps, _config: &Config) -> StdResult<Decimal> {
    // TODO: Query LP pool for actual price. For MVP, use 1:1 peg.
    Ok(Decimal::one())
}

/// Compute collateral value in INIT terms
fn collateral_value_in_init(collateral: Uint128, price: Decimal) -> Uint128 {
    collateral.multiply_ratio(price.numerator(), price.denominator())
}

/// Accrue interest on the pool state. Returns updated pool.
/// Splits interest: protocol_fee_bps% → accrued_protocol_fees, rest → lenders (compounds into total_borrowed).
fn accrue_interest(pool: &mut PoolState, config: &Config, now: u64) {
    if pool.total_borrowed.is_zero() || now <= pool.last_accrual_time {
        pool.last_accrual_time = now;
        return;
    }
    let elapsed = (now - pool.last_accrual_time) as u128;
    // interest = total_borrowed * rate * elapsed / seconds_per_year
    let interest = Uint256::from(pool.total_borrowed)
        * Uint256::from(config.borrow_rate.numerator())
        * Uint256::from(elapsed)
        / (Uint256::from(config.borrow_rate.denominator()) * Uint256::from(SECONDS_PER_YEAR));
    let interest = Uint128::try_from(interest).unwrap_or(Uint128::zero());

    if !interest.is_zero() {
        // Split interest: protocol fee vs lender share
        let protocol_fee = interest.multiply_ratio(config.protocol_fee_bps as u128, 10_000u128);
        let lender_share = interest - protocol_fee;

        // Protocol fee is tracked separately, NOT added to total_borrowed
        pool.accrued_protocol_fees += protocol_fee;
        // Only lender share compounds into the borrow pool
        pool.total_borrowed += lender_share;

        // Update borrow index based on lender share only
        let old_borrowed = pool.total_borrowed - lender_share;
        if !old_borrowed.is_zero() {
            let ratio = Decimal::from_ratio(lender_share, old_borrowed);
            pool.borrow_index = pool.borrow_index + pool.borrow_index * ratio;
        }
    }
    pool.last_accrual_time = now;
}

/// Get actual debt for a user position given current borrow index
fn get_user_debt(position: &UserPosition, current_index: Decimal) -> Uint128 {
    if position.borrow_amount.is_zero() || position.borrow_index_snapshot.is_zero() {
        return position.borrow_amount;
    }
    // debt = borrow_amount * current_index / snapshot_index
    let debt = Uint256::from(position.borrow_amount)
        * Uint256::from(current_index.numerator())
        * Uint256::from(position.borrow_index_snapshot.denominator())
        / (Uint256::from(current_index.denominator())
            * Uint256::from(position.borrow_index_snapshot.numerator()));
    Uint128::try_from(debt).unwrap_or(Uint128::MAX)
}

/// Calculate health factor = (collateral_value * liquidation_threshold) / debt
fn health_factor(
    collateral: Uint128,
    debt: Uint128,
    price: Decimal,
    liquidation_threshold: Decimal,
) -> Decimal {
    if debt.is_zero() {
        return Decimal::new(Uint128::MAX); // infinite health
    }
    let col_value = collateral_value_in_init(collateral, price);
    let threshold_value = col_value.multiply_ratio(liquidation_threshold.numerator(), liquidation_threshold.denominator());
    Decimal::from_ratio(threshold_value, debt)
}

fn send_init(denom: &str, to: &Addr, amount: Uint128) -> CosmosMsg {
    CosmosMsg::Bank(BankMsg::Send {
        to_address: to.to_string(),
        amount: vec![Coin {
            denom: denom.to_string(),
            amount,
        }],
    })
}

fn send_initx(initx_token: &Addr, to: &Addr, amount: Uint128) -> CosmosMsg {
    CosmosMsg::Wasm(WasmMsg::Execute {
        contract_addr: initx_token.to_string(),
        msg: to_json_binary(&Cw20ExecuteMsg::Transfer {
            recipient: to.to_string(),
            amount,
        })
        .unwrap(),
        funds: vec![],
    })
}

// ── Entry points ──

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let config = Config {
        admin: info.sender.clone(),
        init_denom: msg.init_denom,
        initx_token: deps.api.addr_validate(&msg.initx_token)?,
        lp_pool: deps.api.addr_validate(&msg.lp_pool)?,
        collateral_factor: msg
            .collateral_factor
            .unwrap_or(Decimal::percent(70)),
        liquidation_threshold: msg
            .liquidation_threshold
            .unwrap_or(Decimal::percent(80)),
        liquidation_bonus: msg
            .liquidation_bonus
            .unwrap_or(Decimal::percent(5)),
        borrow_rate: msg.borrow_rate.unwrap_or(Decimal::percent(5)),
        protocol_fee_bps: msg.protocol_fee_bps.unwrap_or(1000), // 10% default
        fee_collector: msg
            .fee_collector
            .map(|a| deps.api.addr_validate(&a))
            .transpose()?
            .unwrap_or(info.sender.clone()),
    };
    CONFIG.save(deps.storage, &config)?;

    let pool = PoolState {
        total_supply: Uint128::zero(),
        total_borrowed: Uint128::zero(),
        last_accrual_time: env.block.time.seconds(),
        borrow_index: Decimal::one(),
        accrued_protocol_fees: Uint128::zero(),
    };
    POOL_STATE.save(deps.storage, &pool)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("admin", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Receive(cw20_msg) => execute_receive(deps, env, info, cw20_msg),
        ExecuteMsg::Supply {} => execute_supply(deps, env, info),
        ExecuteMsg::WithdrawSupply { amount } => execute_withdraw_supply(deps, env, info, amount),
        ExecuteMsg::Borrow { amount } => execute_borrow(deps, env, info, amount),
        ExecuteMsg::Repay {} => execute_repay(deps, env, info),
        ExecuteMsg::WithdrawCollateral { amount } => {
            execute_withdraw_collateral(deps, env, info, amount)
        }
        ExecuteMsg::Liquidate { borrower } => execute_liquidate(deps, env, info, borrower),
        ExecuteMsg::UpdateConfig {
            collateral_factor,
            liquidation_threshold,
            liquidation_bonus,
            borrow_rate,
            protocol_fee_bps,
            fee_collector,
        } => execute_update_config(
            deps,
            info,
            collateral_factor,
            liquidation_threshold,
            liquidation_bonus,
            borrow_rate,
            protocol_fee_bps,
            fee_collector,
        ),
        ExecuteMsg::CollectProtocolFees {} => execute_collect_protocol_fees(deps, env, info),
    }
}

fn execute_receive(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    cw20_msg: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.initx_token {
        return Err(ContractError::InvalidCw20Sender {});
    }

    let sender = deps.api.addr_validate(&cw20_msg.sender)?;
    let amount = cw20_msg.amount;
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    let hook_msg: Cw20HookMsg = cosmwasm_std::from_json(&cw20_msg.msg)?;
    match hook_msg {
        Cw20HookMsg::DepositCollateral {} => {
            let mut position = POSITIONS
                .may_load(deps.storage, &sender)?
                .unwrap_or(UserPosition {
                    collateral: Uint128::zero(),
                    borrow_amount: Uint128::zero(),
                    borrow_index_snapshot: Decimal::one(),
                });
            position.collateral += amount;
            POSITIONS.save(deps.storage, &sender, &position)?;

            Ok(Response::new()
                .add_attribute("action", "deposit_collateral")
                .add_attribute("sender", sender)
                .add_attribute("amount", amount))
        }
    }
}

/// Lender supplies INIT to the pool
fn execute_supply(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let amount = extract_native(&info, &config.init_denom);
    if amount.is_zero() {
        return Err(ContractError::NoFunds {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());
    pool.total_supply += amount;
    POOL_STATE.save(deps.storage, &pool)?;

    let existing = LENDER_DEPOSITS
        .may_load(deps.storage, &info.sender)?
        .unwrap_or(Uint128::zero());
    LENDER_DEPOSITS.save(deps.storage, &info.sender, &(existing + amount))?;

    Ok(Response::new()
        .add_attribute("action", "supply")
        .add_attribute("supplier", info.sender)
        .add_attribute("amount", amount))
}

fn execute_withdraw_supply(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let deposited = LENDER_DEPOSITS
        .may_load(deps.storage, &info.sender)?
        .unwrap_or(Uint128::zero());
    if deposited < amount {
        return Err(ContractError::Std(StdError::generic_err("Withdraw exceeds deposit")));
    }

    // Reserve INIT for accrued protocol fees that haven't been collected yet
    let available = pool.total_supply - pool.total_borrowed - pool.accrued_protocol_fees;
    if available < amount {
        return Err(ContractError::InsufficientLiquidity {});
    }

    pool.total_supply -= amount;
    POOL_STATE.save(deps.storage, &pool)?;
    LENDER_DEPOSITS.save(deps.storage, &info.sender, &(deposited - amount))?;

    let msg = send_init(&config.init_denom, &info.sender, amount);
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "withdraw_supply")
        .add_attribute("amount", amount))
}

fn execute_borrow(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    // Reserve INIT for accrued protocol fees that haven't been collected yet
    let available = pool.total_supply - pool.total_borrowed - pool.accrued_protocol_fees;
    if available < amount {
        return Err(ContractError::InsufficientLiquidity {});
    }

    let price = get_initx_price(deps.as_ref(), &config)?;
    let mut position = POSITIONS
        .may_load(deps.storage, &info.sender)?
        .unwrap_or(UserPosition {
            collateral: Uint128::zero(),
            borrow_amount: Uint128::zero(),
            borrow_index_snapshot: pool.borrow_index,
        });

    if position.collateral.is_zero() {
        return Err(ContractError::NoCollateral {});
    }

    // Calculate existing debt + new borrow
    let existing_debt = get_user_debt(&position, pool.borrow_index);
    let new_total_debt = existing_debt + amount;

    // Check collateral factor: debt <= collateral_value * CF
    let col_value = collateral_value_in_init(position.collateral, price);
    let max_borrow = col_value.multiply_ratio(config.collateral_factor.numerator(), config.collateral_factor.denominator());
    if new_total_debt > max_borrow {
        return Err(ContractError::ExceedsCollateralFactor {});
    }

    // Update position: store total debt at current index
    position.borrow_amount = new_total_debt;
    position.borrow_index_snapshot = pool.borrow_index;
    POSITIONS.save(deps.storage, &info.sender, &position)?;

    pool.total_borrowed += amount;
    POOL_STATE.save(deps.storage, &pool)?;

    let msg = send_init(&config.init_denom, &info.sender, amount);
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "borrow")
        .add_attribute("borrower", info.sender)
        .add_attribute("amount", amount))
}

fn execute_repay(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let repay_amount = extract_native(&info, &config.init_denom);
    if repay_amount.is_zero() {
        return Err(ContractError::NoFunds {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let mut position = POSITIONS.load(deps.storage, &info.sender)?;
    let debt = get_user_debt(&position, pool.borrow_index);

    if debt.is_zero() {
        return Err(ContractError::NoDebt {});
    }

    let actual_repay = std::cmp::min(repay_amount, debt);
    let remaining_debt = debt - actual_repay;

    position.borrow_amount = remaining_debt;
    position.borrow_index_snapshot = pool.borrow_index;
    POSITIONS.save(deps.storage, &info.sender, &position)?;

    pool.total_borrowed = pool.total_borrowed.saturating_sub(actual_repay);
    POOL_STATE.save(deps.storage, &pool)?;

    let mut msgs: Vec<CosmosMsg> = vec![];
    // Refund excess
    let refund = repay_amount - actual_repay;
    if !refund.is_zero() {
        msgs.push(send_init(&config.init_denom, &info.sender, refund));
    }

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "repay")
        .add_attribute("repaid", actual_repay)
        .add_attribute("remaining_debt", remaining_debt))
}

fn execute_withdraw_collateral(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let mut position = POSITIONS.load(deps.storage, &info.sender)?;
    if position.collateral < amount {
        return Err(ContractError::NoCollateral {});
    }

    let new_collateral = position.collateral - amount;
    let debt = get_user_debt(&position, pool.borrow_index);

    // If there's debt, check position would remain healthy after withdrawal
    if !debt.is_zero() {
        let price = get_initx_price(deps.as_ref(), &config)?;
        let hf = health_factor(new_collateral, debt, price, config.liquidation_threshold);
        if hf < Decimal::one() {
            return Err(ContractError::WithdrawWouldLiquidate {});
        }
    }

    position.collateral = new_collateral;
    POSITIONS.save(deps.storage, &info.sender, &position)?;
    POOL_STATE.save(deps.storage, &pool)?;

    let msg = send_initx(&config.initx_token, &info.sender, amount);
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "withdraw_collateral")
        .add_attribute("amount", amount))
}

fn execute_liquidate(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    borrower: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let repay_amount = extract_native(&info, &config.init_denom);
    if repay_amount.is_zero() {
        return Err(ContractError::NoFunds {});
    }

    let borrower_addr = deps.api.addr_validate(&borrower)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let mut position = POSITIONS.load(deps.storage, &borrower_addr)?;
    let debt = get_user_debt(&position, pool.borrow_index);
    let price = get_initx_price(deps.as_ref(), &config)?;

    let hf = health_factor(
        position.collateral,
        debt,
        price,
        config.liquidation_threshold,
    );
    if hf >= Decimal::one() {
        return Err(ContractError::NotLiquidatable {});
    }

    // Liquidator can repay up to 50% of debt
    let max_repay = debt / Uint128::new(2);
    let actual_repay = std::cmp::min(repay_amount, std::cmp::min(max_repay, debt));

    // Collateral seized = repay_amount_in_init / price * (1 + bonus)
    // Since price = INITx/INIT, collateral_seized = actual_repay / price * (1 + bonus)
    let bonus_factor = Decimal::one() + config.liquidation_bonus;
    let collateral_seized_value = actual_repay.multiply_ratio(bonus_factor.numerator(), bonus_factor.denominator());
    // Convert INIT value to INITx amount: initx_amount = init_value / price
    let collateral_seized = if price.is_zero() {
        Uint128::zero()
    } else {
        collateral_seized_value.multiply_ratio(price.denominator(), price.numerator())
    };
    let collateral_seized = std::cmp::min(collateral_seized, position.collateral);

    position.collateral -= collateral_seized;
    let remaining_debt = debt - actual_repay;
    position.borrow_amount = remaining_debt;
    position.borrow_index_snapshot = pool.borrow_index;
    POSITIONS.save(deps.storage, &borrower_addr, &position)?;

    pool.total_borrowed = pool.total_borrowed.saturating_sub(actual_repay);
    POOL_STATE.save(deps.storage, &pool)?;

    let mut msgs: Vec<CosmosMsg> = vec![];
    if !collateral_seized.is_zero() {
        msgs.push(send_initx(&config.initx_token, &info.sender, collateral_seized));
    }
    // Refund excess INIT
    let refund = repay_amount - actual_repay;
    if !refund.is_zero() {
        msgs.push(send_init(&config.init_denom, &info.sender, refund));
    }

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "liquidate")
        .add_attribute("liquidator", info.sender)
        .add_attribute("borrower", borrower)
        .add_attribute("repaid", actual_repay)
        .add_attribute("collateral_seized", collateral_seized))
}

fn execute_update_config(
    deps: DepsMut,
    info: MessageInfo,
    collateral_factor: Option<Decimal>,
    liquidation_threshold: Option<Decimal>,
    liquidation_bonus: Option<Decimal>,
    borrow_rate: Option<Decimal>,
    protocol_fee_bps: Option<u16>,
    fee_collector: Option<String>,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(v) = collateral_factor {
        config.collateral_factor = v;
    }
    if let Some(v) = liquidation_threshold {
        config.liquidation_threshold = v;
    }
    if let Some(v) = liquidation_bonus {
        config.liquidation_bonus = v;
    }
    if let Some(v) = borrow_rate {
        config.borrow_rate = v;
    }
    if let Some(v) = protocol_fee_bps {
        config.protocol_fee_bps = v;
    }
    if let Some(v) = fee_collector {
        config.fee_collector = deps.api.addr_validate(&v)?;
    }
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

/// Collect accrued protocol fees. Only fee_collector or admin can call.
fn execute_collect_protocol_fees(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.fee_collector && info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    // Accrue any pending interest first so fees are up to date
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let fees = pool.accrued_protocol_fees;
    if fees.is_zero() {
        return Err(ContractError::NoFeesToCollect {});
    }

    // Reset accrued fees
    pool.accrued_protocol_fees = Uint128::zero();
    POOL_STATE.save(deps.storage, &pool)?;

    // Send fees to the caller (fee_collector)
    let msg = send_init(&config.init_denom, &info.sender, fees);
    Ok(Response::new()
        .add_message(msg)
        .add_attribute("action", "collect_protocol_fees")
        .add_attribute("amount", fees)
        .add_attribute("collector", info.sender))
}

// ── Queries ──

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::PoolState {} => to_json_binary(&POOL_STATE.load(deps.storage)?),
        QueryMsg::Position { address } => query_position(deps, env, address),
        QueryMsg::HealthFactor { address } => query_health_factor(deps, env, address),
        QueryMsg::AccruedProtocolFees {} => query_accrued_protocol_fees(deps, env),
    }
}

fn query_position(deps: Deps, env: Env, address: String) -> StdResult<Binary> {
    let addr = deps.api.addr_validate(&address)?;
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let position = POSITIONS
        .may_load(deps.storage, &addr)?
        .unwrap_or(UserPosition {
            collateral: Uint128::zero(),
            borrow_amount: Uint128::zero(),
            borrow_index_snapshot: Decimal::one(),
        });

    let debt = get_user_debt(&position, pool.borrow_index);
    let price = get_initx_price(deps, &config)?;
    let col_value = collateral_value_in_init(position.collateral, price);
    let max_borrow = col_value.multiply_ratio(config.collateral_factor.numerator(), config.collateral_factor.denominator());
    let hf = health_factor(
        position.collateral,
        debt,
        price,
        config.liquidation_threshold,
    );

    to_json_binary(&PositionResponse {
        collateral: position.collateral,
        debt,
        max_borrow,
        health_factor: hf,
    })
}

fn query_health_factor(deps: Deps, env: Env, address: String) -> StdResult<Binary> {
    let addr = deps.api.addr_validate(&address)?;
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());

    let position = POSITIONS
        .may_load(deps.storage, &addr)?
        .unwrap_or(UserPosition {
            collateral: Uint128::zero(),
            borrow_amount: Uint128::zero(),
            borrow_index_snapshot: Decimal::one(),
        });

    let debt = get_user_debt(&position, pool.borrow_index);
    let price = get_initx_price(deps, &config)?;
    let hf = health_factor(
        position.collateral,
        debt,
        price,
        config.liquidation_threshold,
    );

    to_json_binary(&HealthFactorResponse {
        health_factor: hf,
        is_liquidatable: hf < Decimal::one(),
    })
}

fn query_accrued_protocol_fees(deps: Deps, env: Env) -> StdResult<Binary> {
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;
    accrue_interest(&mut pool, &config, env.block.time.seconds());
    to_json_binary(&AccruedProtocolFeesResponse {
        fees: pool.accrued_protocol_fees,
    })
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi};
    use cosmwasm_std::Coin;

    fn default_instantiate(deps: DepsMut, env: Env) -> (Addr, Addr, Addr) {
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let lp_pool = api.addr_make("lp_pool");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            lp_pool: lp_pool.to_string(),
            collateral_factor: None,
            liquidation_threshold: None,
            liquidation_bonus: None,
            borrow_rate: None,
            protocol_fee_bps: Some(1000), // 10%
            fee_collector: None,           // defaults to admin
        };
        let info = message_info(&admin, &[]);
        instantiate(deps, env, info, msg).unwrap();
        (admin, initx_token, lp_pool)
    }

    fn deposit_collateral(deps: DepsMut, env: Env, initx_token: &Addr, user: &Addr, amount: u128) {
        let cw20_msg = Cw20ReceiveMsg {
            sender: user.to_string(),
            amount: Uint128::new(amount),
            msg: to_json_binary(&Cw20HookMsg::DepositCollateral {}).unwrap(),
        };
        let info = message_info(initx_token, &[]);
        execute(deps, env, info, ExecuteMsg::Receive(cw20_msg)).unwrap();
    }

    fn supply_init(deps: DepsMut, env: Env, supplier: &Addr, amount: u128) {
        let info = message_info(
            supplier,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(amount),
            }],
        );
        execute(deps, env, info, ExecuteMsg::Supply {}).unwrap();
    }

    #[test]
    fn test_instantiate() {
        let mut deps = mock_dependencies();
        let (admin, initx_token, _) = default_instantiate(deps.as_mut(), mock_env());

        let config = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(config.admin, admin);
        assert_eq!(config.initx_token, initx_token);
        assert_eq!(config.collateral_factor, Decimal::percent(70));
        assert_eq!(config.liquidation_threshold, Decimal::percent(80));
        assert_eq!(config.liquidation_bonus, Decimal::percent(5));
        assert_eq!(config.protocol_fee_bps, 1000);
        assert_eq!(config.fee_collector, admin);
    }

    #[test]
    fn test_deposit_collateral() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let api = MockApi::default();
        let user = api.addr_make("user");

        deposit_collateral(deps.as_mut(), env, &initx_token, &user, 1_000_000);

        let pos = POSITIONS.load(deps.as_ref().storage, &user).unwrap();
        assert_eq!(pos.collateral, Uint128::new(1_000_000));
    }

    #[test]
    fn test_supply_and_borrow() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        // Lender supplies 1M INIT
        supply_init(deps.as_mut(), env.clone(), &lender, 1_000_000);

        // User deposits 1M INITx collateral
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 1_000_000);

        // Borrow 700_000 INIT (70% CF)
        let info = message_info(&user, &[]);
        let res = execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(700_000),
            },
        )
        .unwrap();
        assert_eq!(res.attributes[0].value, "borrow");

        let pool = POOL_STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(pool.total_borrowed, Uint128::new(700_000));
    }

    #[test]
    fn test_borrow_exceeds_cf() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        supply_init(deps.as_mut(), env.clone(), &lender, 2_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 1_000_000);

        // Try borrowing 710_000 (>70%)
        let info = message_info(&user, &[]);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(710_000),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::ExceedsCollateralFactor {});
    }

    #[test]
    fn test_repay() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        supply_init(deps.as_mut(), env.clone(), &lender, 1_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 1_000_000);

        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(500_000),
            },
        )
        .unwrap();

        // Repay 200k
        let info = message_info(
            &user,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(200_000),
            }],
        );
        let res = execute(deps.as_mut(), env, info, ExecuteMsg::Repay {}).unwrap();
        assert_eq!(
            res.attributes
                .iter()
                .find(|a| a.key == "repaid")
                .unwrap()
                .value,
            "200000"
        );

        let pos = POSITIONS.load(deps.as_ref().storage, &user).unwrap();
        assert_eq!(pos.borrow_amount, Uint128::new(300_000));
    }

    #[test]
    fn test_withdraw_collateral_healthy() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");

        // Deposit collateral, no debt — can withdraw freely
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 1_000_000);

        let info = message_info(&user, &[]);
        let res = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::WithdrawCollateral {
                amount: Uint128::new(500_000),
            },
        )
        .unwrap();
        assert_eq!(res.messages.len(), 1);

        let pos = POSITIONS.load(deps.as_ref().storage, &user).unwrap();
        assert_eq!(pos.collateral, Uint128::new(500_000));
    }

    #[test]
    fn test_withdraw_collateral_would_liquidate() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        supply_init(deps.as_mut(), env.clone(), &lender, 1_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 1_000_000);

        // Borrow 700k (max at 70% CF)
        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(700_000),
            },
        )
        .unwrap();

        // Try to withdraw 200k collateral — would push health below 1
        let info = message_info(&user, &[]);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::WithdrawCollateral {
                amount: Uint128::new(200_000),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::WithdrawWouldLiquidate {});
    }

    #[test]
    fn test_liquidation() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let borrower = api.addr_make("borrower");
        let lender = api.addr_make("lender");
        let liquidator = api.addr_make("liquidator");

        supply_init(deps.as_mut(), env.clone(), &lender, 2_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &borrower, 1_000_000);

        // Borrow at max
        let info = message_info(&borrower, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(700_000),
            },
        )
        .unwrap();

        // Manually make position undercollateralized by reducing collateral
        // (simulating price drop — in production the oracle price would change)
        let mut pos = POSITIONS.load(deps.as_ref().storage, &borrower).unwrap();
        pos.collateral = Uint128::new(800_000); // now debt/col = 700k/800k = 87.5% > 80% threshold
        POSITIONS.save(deps.as_mut().storage, &borrower, &pos).unwrap();

        // Liquidate
        let info = message_info(
            &liquidator,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(350_000), // repay up to 50% of debt
            }],
        );
        let res = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::Liquidate {
                borrower: borrower.to_string(),
            },
        )
        .unwrap();

        let repaid: u128 = res
            .attributes
            .iter()
            .find(|a| a.key == "repaid")
            .unwrap()
            .value
            .parse()
            .unwrap();
        assert_eq!(repaid, 350_000);

        let seized: u128 = res
            .attributes
            .iter()
            .find(|a| a.key == "collateral_seized")
            .unwrap()
            .value
            .parse()
            .unwrap();
        // 350k * 1.05 = 367_500 INITx (at 1:1 price)
        assert_eq!(seized, 367_500);
    }

    #[test]
    fn test_not_liquidatable() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let borrower = api.addr_make("borrower");
        let lender = api.addr_make("lender");
        let liquidator = api.addr_make("liquidator");

        supply_init(deps.as_mut(), env.clone(), &lender, 2_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &borrower, 1_000_000);

        let info = message_info(&borrower, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(500_000),
            },
        )
        .unwrap();

        // Position is healthy — liquidation should fail
        let info = message_info(
            &liquidator,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(100_000),
            }],
        );
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::Liquidate {
                borrower: borrower.to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::NotLiquidatable {});
    }

    #[test]
    fn test_query_position() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        supply_init(deps.as_mut(), env.clone(), &lender, 1_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 1_000_000);

        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(500_000),
            },
        )
        .unwrap();

        let res: PositionResponse = cosmwasm_std::from_json(
            query(
                deps.as_ref(),
                env,
                QueryMsg::Position {
                    address: user.to_string(),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(res.collateral, Uint128::new(1_000_000));
        assert_eq!(res.debt, Uint128::new(500_000));
        assert_eq!(res.max_borrow, Uint128::new(700_000));
    }

    #[test]
    fn test_protocol_fee_accrual() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        let api = MockApi::default();
        let (_, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        supply_init(deps.as_mut(), env.clone(), &lender, 10_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 10_000_000);

        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(5_000_000),
            },
        )
        .unwrap();

        // Advance time by 1 year to accrue interest
        env.block.time = env.block.time.plus_seconds(365 * 24 * 3600);

        // Query accrued protocol fees (triggers accrual)
        let res: AccruedProtocolFeesResponse = cosmwasm_std::from_json(
            query(deps.as_ref(), env.clone(), QueryMsg::AccruedProtocolFees {}).unwrap(),
        )
        .unwrap();

        // 5M borrowed at 5% APR = 250k interest
        // 10% protocol fee = 25k
        assert!(res.fees > Uint128::zero(), "fees should be > 0");
        // Allow some rounding: ~25000
        assert!(res.fees >= Uint128::new(24_000) && res.fees <= Uint128::new(26_000),
            "expected ~25000, got {}", res.fees);
    }

    #[test]
    fn test_collect_protocol_fees() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        let api = MockApi::default();
        let (admin, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());
        let user = api.addr_make("user");
        let lender = api.addr_make("lender");

        supply_init(deps.as_mut(), env.clone(), &lender, 10_000_000);
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &user, 10_000_000);

        let info = message_info(&user, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow {
                amount: Uint128::new(5_000_000),
            },
        )
        .unwrap();

        // Advance time
        env.block.time = env.block.time.plus_seconds(365 * 24 * 3600);

        // Collect fees (admin is fee_collector by default)
        let info = message_info(&admin, &[]);
        let res = execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::CollectProtocolFees {},
        )
        .unwrap();

        // Should have a bank send message
        assert_eq!(res.messages.len(), 1);
        assert_eq!(
            res.attributes.iter().find(|a| a.key == "action").unwrap().value,
            "collect_protocol_fees"
        );

        // After collection, fees should be zero
        let res2: AccruedProtocolFeesResponse = cosmwasm_std::from_json(
            query(deps.as_ref(), env, QueryMsg::AccruedProtocolFees {}).unwrap(),
        )
        .unwrap();
        assert_eq!(res2.fees, Uint128::zero());
    }

    #[test]
    fn test_collect_fees_unauthorized() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, _, _) = default_instantiate(deps.as_mut(), env.clone());
        let random_user = api.addr_make("random");

        let info = message_info(&random_user, &[]);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::CollectProtocolFees {},
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn test_withdraw_reserves_init_for_protocol_fees() {
        // After interest accrues, withdrawal availability must reserve INIT
        // for uncollected protocol fees.
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        let api = MockApi::default();
        let (admin, initx_token, _) = default_instantiate(deps.as_mut(), env.clone());

        let lender = api.addr_make("lender");
        let borrower = api.addr_make("borrower");

        // Lender supplies 1000
        supply_init(deps.as_mut(), env.clone(), &lender, 1_000_000);

        // Borrower deposits collateral and borrows
        deposit_collateral(deps.as_mut(), env.clone(), &initx_token, &borrower, 2_000_000);
        let info = message_info(&borrower, &[]);
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::Borrow { amount: Uint128::new(500_000) },
        )
        .unwrap();

        // Advance time by 1 year to accrue significant interest
        // borrow_rate = 5%, borrowed = 500_000, interest ~ 25_000
        // protocol_fee = 10% of 25_000 = 2_500
        env.block.time = env.block.time.plus_seconds(365 * 24 * 3600);

        // Lender tries to withdraw everything (1_000_000)
        // Available should be: total_supply(1_000_000) - total_borrowed(~522_500) - accrued_fees(~2_500) = ~475_000
        // So withdrawing 1_000_000 should fail
        let info = message_info(&lender, &[]);
        let err = execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::WithdrawSupply { amount: Uint128::new(1_000_000) },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::InsufficientLiquidity {});

        // But a smaller withdrawal should succeed
        let info = message_info(&lender, &[]);
        let res = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::WithdrawSupply { amount: Uint128::new(400_000) },
        );
        assert!(res.is_ok(), "Smaller withdrawal must succeed");
    }
}
