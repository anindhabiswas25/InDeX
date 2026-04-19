use cosmwasm_std::{
    entry_point, to_json_binary, Addr, BankMsg, Binary, Coin, CosmosMsg, Deps, DepsMut, Env,
    MessageInfo, Response, StdResult, Uint128, Uint256, WasmMsg,
};
use cw2::set_contract_version;
use cw20::{Cw20ExecuteMsg, Cw20ReceiveMsg};

use crate::error::ContractError;
use crate::msg::{
    AccruedFeesResponse, AssetInfo, Cw20HookMsg, ExecuteMsg, InstantiateMsg, LpBalanceResponse,
    QueryMsg, SwapEstimateResponse,
};
use crate::state::{Config, PoolState, CONFIG, LP_SHARES, POOL_STATE};

const CONTRACT_NAME: &str = "crates.io:initx-lp-pool";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── Helpers ──

/// Integer square root via Newton's method
fn isqrt(val: Uint256) -> Uint256 {
    if val.is_zero() {
        return Uint256::zero();
    }
    let mut x = val;
    let mut y = (x + Uint256::one()) >> 1;
    while y < x {
        x = y;
        y = (x + val / x) >> 1;
    }
    x
}

/// Calculate swap output using constant-product formula with fee:
/// out = (reserve_out * amount_in_after_fee) / (reserve_in + amount_in_after_fee)
fn compute_swap(
    offer_amount: Uint128,
    offer_reserve: Uint128,
    ask_reserve: Uint128,
    fee_bps: u64,
) -> (Uint128, Uint128) {
    let fee_amount = offer_amount.multiply_ratio(fee_bps as u128, 10_000u128);
    let amount_after_fee = offer_amount - fee_amount;
    let numerator = Uint256::from(ask_reserve) * Uint256::from(amount_after_fee);
    let denominator = Uint256::from(offer_reserve) + Uint256::from(amount_after_fee);
    let return_amount = Uint128::try_from(numerator / denominator).unwrap_or(Uint128::MAX);
    (return_amount, fee_amount)
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

fn send_init(denom: &str, to: &Addr, amount: Uint128) -> CosmosMsg {
    CosmosMsg::Bank(BankMsg::Send {
        to_address: to.to_string(),
        amount: vec![Coin {
            denom: denom.to_string(),
            amount,
        }],
    })
}

/// Extract the amount of a specific native denom from MessageInfo funds
fn extract_native(info: &MessageInfo, denom: &str) -> Uint128 {
    info.funds
        .iter()
        .find(|c| c.denom == denom)
        .map(|c| c.amount)
        .unwrap_or(Uint128::zero())
}

// ── Entry points ──

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let initx_token = deps.api.addr_validate(&msg.initx_token)?;
    let fee_collector = match msg.fee_collector {
        Some(addr) => deps.api.addr_validate(&addr)?,
        None => info.sender.clone(),
    };

    let config = Config {
        admin: info.sender.clone(),
        init_denom: msg.init_denom,
        initx_token,
        swap_fee_bps: msg.swap_fee_bps.unwrap_or(30),
        protocol_fee_bps: msg.protocol_fee_bps.unwrap_or(1667),
        fee_collector,
    };
    CONFIG.save(deps.storage, &config)?;

    let pool = PoolState {
        init_reserve: Uint128::zero(),
        initx_reserve: Uint128::zero(),
        total_lp_shares: Uint128::zero(),
        accrued_fees_init: Uint128::zero(),
        accrued_fees_initx: Uint128::zero(),
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
        ExecuteMsg::SwapInitForInitx { min_out } => {
            execute_swap_init_for_initx(deps, env, info, min_out)
        }
        ExecuteMsg::RemoveLiquidity { lp_shares } => {
            execute_remove_liquidity(deps, env, info, lp_shares)
        }
        ExecuteMsg::UpdateConfig {
            swap_fee_bps,
            protocol_fee_bps,
            fee_collector,
        } => execute_update_config(deps, info, swap_fee_bps, protocol_fee_bps, fee_collector),
        ExecuteMsg::CollectProtocolFees {} => execute_collect_protocol_fees(deps, info),
    }
}

/// Handle incoming CW20 tokens (must be INITx)
fn execute_receive(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    cw20_msg: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;

    // Only accept INITx
    if info.sender != config.initx_token {
        return Err(ContractError::Unauthorized {});
    }

    let sender = deps.api.addr_validate(&cw20_msg.sender)?;
    let amount = cw20_msg.amount;

    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    let hook_msg: Cw20HookMsg = cosmwasm_std::from_json(&cw20_msg.msg)?;

    match hook_msg {
        Cw20HookMsg::SwapInitxForInit { min_out } => {
            execute_swap_initx_for_init(deps, env, sender, amount, min_out)
        }
        Cw20HookMsg::AddLiquidity { min_lp_shares } => {
            // The INIT side should have been sent as native funds in the original
            // WasmMsg::Execute that triggered the CW20 Send. But CW20 Receive
            // doesn't carry native funds from the original sender.
            // So we need INIT to have been sent directly to this contract in the
            // same tx via a separate BankMsg, or we read from env.
            // For simplicity in MVP: the contract's INIT balance minus current
            // reserve AND accrued fees is the INIT being added.
            let pool = POOL_STATE.load(deps.storage)?;
            let contract_init_balance = deps
                .querier
                .query_balance(&env.contract.address, &config.init_denom)?
                .amount;
            let init_amount = contract_init_balance - pool.init_reserve - pool.accrued_fees_init;
            execute_add_liquidity(deps, sender, init_amount, amount, min_lp_shares)
        }
    }
}

/// Swap native INIT -> INITx
fn execute_swap_init_for_initx(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    min_out: Option<Uint128>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let init_in = extract_native(&info, &config.init_denom);
    if init_in.is_zero() {
        return Err(ContractError::NoInitFunds {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    if pool.init_reserve.is_zero() || pool.initx_reserve.is_zero() {
        return Err(ContractError::EmptyPool {});
    }

    let (initx_out, fee) = compute_swap(
        init_in,
        pool.init_reserve,
        pool.initx_reserve,
        config.swap_fee_bps,
    );

    if let Some(min) = min_out {
        if initx_out < min {
            return Err(ContractError::InsufficientOutputAmount {
                min_out: min.to_string(),
                actual: initx_out.to_string(),
            });
        }
    }

    pool.init_reserve += init_in;
    pool.initx_reserve -= initx_out;

    let protocol_fee = fee.multiply_ratio(config.protocol_fee_bps, 10_000u64);
    pool.accrued_fees_init += protocol_fee;

    POOL_STATE.save(deps.storage, &pool)?;

    let send_msg = send_initx(&config.initx_token, &info.sender, initx_out);

    Ok(Response::new()
        .add_message(send_msg)
        .add_attribute("action", "swap_init_for_initx")
        .add_attribute("init_in", init_in)
        .add_attribute("initx_out", initx_out)
        .add_attribute("fee", fee)
        .add_attribute("protocol_fee", protocol_fee))
}

/// Swap INITx -> INIT (called from CW20 receive)
fn execute_swap_initx_for_init(
    deps: DepsMut,
    _env: Env,
    sender: Addr,
    initx_in: Uint128,
    min_out: Option<Uint128>,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;

    if pool.init_reserve.is_zero() || pool.initx_reserve.is_zero() {
        return Err(ContractError::EmptyPool {});
    }

    let (init_out, fee) = compute_swap(
        initx_in,
        pool.initx_reserve,
        pool.init_reserve,
        config.swap_fee_bps,
    );

    if let Some(min) = min_out {
        if init_out < min {
            return Err(ContractError::InsufficientOutputAmount {
                min_out: min.to_string(),
                actual: init_out.to_string(),
            });
        }
    }

    pool.initx_reserve += initx_in;
    pool.init_reserve -= init_out;

    let protocol_fee = fee.multiply_ratio(config.protocol_fee_bps, 10_000u64);
    pool.accrued_fees_initx += protocol_fee;

    POOL_STATE.save(deps.storage, &pool)?;

    let send_msg = send_init(&config.init_denom, &sender, init_out);

    Ok(Response::new()
        .add_message(send_msg)
        .add_attribute("action", "swap_initx_for_init")
        .add_attribute("initx_in", initx_in)
        .add_attribute("init_out", init_out)
        .add_attribute("fee", fee)
        .add_attribute("protocol_fee", protocol_fee))
}

/// Add liquidity: provide INIT + INITx, receive LP shares
fn execute_add_liquidity(
    deps: DepsMut,
    sender: Addr,
    init_amount: Uint128,
    initx_amount: Uint128,
    min_lp_shares: Option<Uint128>,
) -> Result<Response, ContractError> {
    if init_amount.is_zero() || initx_amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;

    let lp_shares = if pool.total_lp_shares.is_zero() {
        // First deposit: shares = sqrt(init_amount * initx_amount)
        let product = Uint256::from(init_amount) * Uint256::from(initx_amount);
        let shares_256 = isqrt(product);
        Uint128::try_from(shares_256).map_err(|_| ContractError::InsufficientLiquidityMinted {})?
    } else {
        // Shares = min(init_amount/init_reserve, initx_amount/initx_reserve) * total_shares
        let share_init =
            Uint256::from(init_amount) * Uint256::from(pool.total_lp_shares) / Uint256::from(pool.init_reserve);
        let share_initx =
            Uint256::from(initx_amount) * Uint256::from(pool.total_lp_shares) / Uint256::from(pool.initx_reserve);
        let shares_256 = std::cmp::min(share_init, share_initx);
        Uint128::try_from(shares_256).map_err(|_| ContractError::InsufficientLiquidityMinted {})?
    };

    if lp_shares.is_zero() {
        return Err(ContractError::InsufficientLiquidityMinted {});
    }

    if let Some(min) = min_lp_shares {
        if lp_shares < min {
            return Err(ContractError::SlippageExceeded {});
        }
    }

    pool.init_reserve += init_amount;
    pool.initx_reserve += initx_amount;
    pool.total_lp_shares += lp_shares;
    POOL_STATE.save(deps.storage, &pool)?;

    let existing = LP_SHARES
        .may_load(deps.storage, &sender)?
        .unwrap_or(Uint128::zero());
    LP_SHARES.save(deps.storage, &sender, &(existing + lp_shares))?;

    Ok(Response::new()
        .add_attribute("action", "add_liquidity")
        .add_attribute("sender", &sender)
        .add_attribute("init_added", init_amount)
        .add_attribute("initx_added", initx_amount)
        .add_attribute("lp_shares_minted", lp_shares))
}

/// Remove liquidity: burn LP shares, receive proportional INIT + INITx
fn execute_remove_liquidity(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    lp_shares: Uint128,
) -> Result<Response, ContractError> {
    if lp_shares.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    let config = CONFIG.load(deps.storage)?;
    let mut pool = POOL_STATE.load(deps.storage)?;

    let user_shares = LP_SHARES
        .may_load(deps.storage, &info.sender)?
        .unwrap_or(Uint128::zero());
    if user_shares < lp_shares {
        return Err(ContractError::InsufficientLpShares {
            have: user_shares.to_string(),
            requested: lp_shares.to_string(),
        });
    }

    // Proportional withdrawal
    let init_out = pool
        .init_reserve
        .multiply_ratio(lp_shares, pool.total_lp_shares);
    let initx_out = pool
        .initx_reserve
        .multiply_ratio(lp_shares, pool.total_lp_shares);

    if init_out.is_zero() && initx_out.is_zero() {
        return Err(ContractError::InsufficientLiquidityBurned {});
    }

    pool.init_reserve -= init_out;
    pool.initx_reserve -= initx_out;
    pool.total_lp_shares -= lp_shares;
    POOL_STATE.save(deps.storage, &pool)?;

    let remaining = user_shares - lp_shares;
    if remaining.is_zero() {
        LP_SHARES.remove(deps.storage, &info.sender);
    } else {
        LP_SHARES.save(deps.storage, &info.sender, &remaining)?;
    }

    let mut msgs: Vec<CosmosMsg> = vec![];
    if !init_out.is_zero() {
        msgs.push(send_init(&config.init_denom, &info.sender, init_out));
    }
    if !initx_out.is_zero() {
        msgs.push(send_initx(&config.initx_token, &info.sender, initx_out));
    }

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "remove_liquidity")
        .add_attribute("lp_shares_burned", lp_shares)
        .add_attribute("init_out", init_out)
        .add_attribute("initx_out", initx_out))
}

fn execute_update_config(
    deps: DepsMut,
    info: MessageInfo,
    swap_fee_bps: Option<u64>,
    protocol_fee_bps: Option<u64>,
    fee_collector: Option<String>,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(f) = swap_fee_bps {
        config.swap_fee_bps = f;
    }
    if let Some(f) = protocol_fee_bps {
        config.protocol_fee_bps = f;
    }
    if let Some(addr) = fee_collector {
        config.fee_collector = deps.api.addr_validate(&addr)?;
    }
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

fn execute_collect_protocol_fees(
    deps: DepsMut,
    info: MessageInfo,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin && info.sender != config.fee_collector {
        return Err(ContractError::Unauthorized {});
    }

    let mut pool = POOL_STATE.load(deps.storage)?;
    let init_fees = pool.accrued_fees_init;
    let initx_fees = pool.accrued_fees_initx;

    if init_fees.is_zero() && initx_fees.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }

    // Subtract collected fees from reserves so reserves match actual contract balance
    pool.init_reserve -= init_fees;
    pool.initx_reserve -= initx_fees;
    pool.accrued_fees_init = Uint128::zero();
    pool.accrued_fees_initx = Uint128::zero();
    POOL_STATE.save(deps.storage, &pool)?;

    let mut msgs: Vec<CosmosMsg> = vec![];
    if !init_fees.is_zero() {
        msgs.push(send_init(&config.init_denom, &config.fee_collector, init_fees));
    }
    if !initx_fees.is_zero() {
        msgs.push(send_initx(&config.initx_token, &config.fee_collector, initx_fees));
    }

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "collect_protocol_fees")
        .add_attribute("init_fees", init_fees)
        .add_attribute("initx_fees", initx_fees))
}

// ── Queries ──

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::PoolState {} => to_json_binary(&POOL_STATE.load(deps.storage)?),
        QueryMsg::LpBalance { address } => query_lp_balance(deps, address),
        QueryMsg::EstimateSwap {
            offer_asset,
            offer_amount,
        } => query_estimate_swap(deps, offer_asset, offer_amount),
        QueryMsg::AccruedFees {} => query_accrued_fees(deps),
    }
}

fn query_lp_balance(deps: Deps, address: String) -> StdResult<Binary> {
    let addr = deps.api.addr_validate(&address)?;
    let shares = LP_SHARES
        .may_load(deps.storage, &addr)?
        .unwrap_or(Uint128::zero());
    let pool = POOL_STATE.load(deps.storage)?;

    let (init_value, initx_value) = if pool.total_lp_shares.is_zero() {
        (Uint128::zero(), Uint128::zero())
    } else {
        (
            pool.init_reserve.multiply_ratio(shares, pool.total_lp_shares),
            pool.initx_reserve.multiply_ratio(shares, pool.total_lp_shares),
        )
    };

    to_json_binary(&LpBalanceResponse {
        shares,
        init_value,
        initx_value,
    })
}

fn query_estimate_swap(
    deps: Deps,
    offer_asset: AssetInfo,
    offer_amount: Uint128,
) -> StdResult<Binary> {
    let config = CONFIG.load(deps.storage)?;
    let pool = POOL_STATE.load(deps.storage)?;

    let (return_amount, fee_amount) = match offer_asset {
        AssetInfo::NativeInit => compute_swap(
            offer_amount,
            pool.init_reserve,
            pool.initx_reserve,
            config.swap_fee_bps,
        ),
        AssetInfo::Cw20Initx => compute_swap(
            offer_amount,
            pool.initx_reserve,
            pool.init_reserve,
            config.swap_fee_bps,
        ),
    };

    to_json_binary(&SwapEstimateResponse {
        return_amount,
        fee_amount,
    })
}

fn query_accrued_fees(deps: Deps) -> StdResult<Binary> {
    let pool = POOL_STATE.load(deps.storage)?;
    to_json_binary(&AccruedFeesResponse {
        init_fees: pool.accrued_fees_init,
        initx_fees: pool.accrued_fees_initx,
    })
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi};
    use cosmwasm_std::Coin;

    #[test]
    fn test_instantiate() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: None,
            protocol_fee_bps: None,
            fee_collector: None,
        };
        let info = message_info(&admin, &[]);
        let res = instantiate(deps.as_mut(), mock_env(), info, msg).unwrap();
        assert_eq!(res.attributes[0].value, "instantiate");

        let config = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(config.init_denom, "uinit");
        assert_eq!(config.swap_fee_bps, 30);
        assert_eq!(config.initx_token, initx_token);

        let pool = POOL_STATE.load(deps.as_ref().storage).unwrap();
        assert!(pool.total_lp_shares.is_zero());
    }

    #[test]
    fn test_add_liquidity_first_deposit() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");

        // Instantiate
        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        let info = message_info(&admin, &[]);
        instantiate(deps.as_mut(), mock_env(), info, msg).unwrap();

        // Add liquidity via internal function (simulating CW20 receive path)
        let res = execute_add_liquidity(
            deps.as_mut(),
            user.clone(),
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        assert_eq!(res.attributes[0].value, "add_liquidity");

        let pool = POOL_STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(pool.init_reserve, Uint128::new(1_000_000));
        assert_eq!(pool.initx_reserve, Uint128::new(1_000_000));
        // sqrt(1_000_000 * 1_000_000) = 1_000_000
        assert_eq!(pool.total_lp_shares, Uint128::new(1_000_000));

        let shares = LP_SHARES.load(deps.as_ref().storage, &user).unwrap();
        assert_eq!(shares, Uint128::new(1_000_000));
    }

    #[test]
    fn test_add_liquidity_second_deposit() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user1 = api.addr_make("user1");
        let user2 = api.addr_make("user2");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        // First deposit
        execute_add_liquidity(
            deps.as_mut(),
            user1.clone(),
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Second deposit (50% of pool)
        execute_add_liquidity(
            deps.as_mut(),
            user2.clone(),
            Uint128::new(500_000),
            Uint128::new(500_000),
            None,
        )
        .unwrap();

        let pool = POOL_STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(pool.total_lp_shares, Uint128::new(1_500_000));

        let shares2 = LP_SHARES.load(deps.as_ref().storage, &user2).unwrap();
        assert_eq!(shares2, Uint128::new(500_000));
    }

    #[test]
    fn test_swap_init_for_initx() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");
        let swapper = api.addr_make("swapper");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        // Seed pool
        execute_add_liquidity(
            deps.as_mut(),
            user,
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Swap 10000 INIT for INITx
        let info = message_info(
            &swapper,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(10_000),
            }],
        );
        let res = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::SwapInitForInitx { min_out: None },
        )
        .unwrap();

        // Should get ~9901 INITx (minus 0.3% fee, then constant product)
        let initx_out: u128 = res
            .attributes
            .iter()
            .find(|a| a.key == "initx_out")
            .unwrap()
            .value
            .parse()
            .unwrap();
        assert!(initx_out > 9800 && initx_out < 10000, "got {}", initx_out);

        let pool = POOL_STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(pool.init_reserve, Uint128::new(1_010_000));
    }

    #[test]
    fn test_swap_initx_for_init() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");
        let swapper = api.addr_make("swapper");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        execute_add_liquidity(
            deps.as_mut(),
            user,
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Swap INITx->INIT via CW20 receive
        let cw20_msg = Cw20ReceiveMsg {
            sender: swapper.to_string(),
            amount: Uint128::new(10_000),
            msg: to_json_binary(&Cw20HookMsg::SwapInitxForInit { min_out: None }).unwrap(),
        };
        let info = message_info(&initx_token, &[]);
        let res = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::Receive(cw20_msg),
        )
        .unwrap();

        let init_out: u128 = res
            .attributes
            .iter()
            .find(|a| a.key == "init_out")
            .unwrap()
            .value
            .parse()
            .unwrap();
        assert!(init_out > 9800 && init_out < 10000, "got {}", init_out);
    }

    #[test]
    fn test_swap_wrong_token_rejected() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let wrong_token = api.addr_make("wrong_token");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        let cw20_msg = Cw20ReceiveMsg {
            sender: admin.to_string(),
            amount: Uint128::new(10_000),
            msg: to_json_binary(&Cw20HookMsg::SwapInitxForInit { min_out: None }).unwrap(),
        };
        let info = message_info(&wrong_token, &[]);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::Receive(cw20_msg),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});
    }

    #[test]
    fn test_remove_liquidity() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        execute_add_liquidity(
            deps.as_mut(),
            user.clone(),
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Remove half
        let info = message_info(&user, &[]);
        let res = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::RemoveLiquidity {
                lp_shares: Uint128::new(500_000),
            },
        )
        .unwrap();

        assert_eq!(res.messages.len(), 2); // INIT + INITx sends

        let pool = POOL_STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(pool.init_reserve, Uint128::new(500_000));
        assert_eq!(pool.initx_reserve, Uint128::new(500_000));
        assert_eq!(pool.total_lp_shares, Uint128::new(500_000));
    }

    #[test]
    fn test_remove_liquidity_insufficient_shares() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        execute_add_liquidity(
            deps.as_mut(),
            user.clone(),
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        let info = message_info(&user, &[]);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::RemoveLiquidity {
                lp_shares: Uint128::new(2_000_000),
            },
        )
        .unwrap_err();
        assert!(matches!(err, ContractError::InsufficientLpShares { .. }));
    }

    #[test]
    fn test_min_out_slippage_protection() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");
        let swapper = api.addr_make("swapper");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        execute_add_liquidity(
            deps.as_mut(),
            user,
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Swap with unreasonably high min_out
        let info = message_info(
            &swapper,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(10_000),
            }],
        );
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::SwapInitForInitx {
                min_out: Some(Uint128::new(10_000)),
            },
        )
        .unwrap_err();
        assert!(matches!(
            err,
            ContractError::InsufficientOutputAmount { .. }
        ));
    }

    #[test]
    fn test_estimate_swap_query() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let user = api.addr_make("user");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        execute_add_liquidity(
            deps.as_mut(),
            user,
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        let res: SwapEstimateResponse = cosmwasm_std::from_json(
            query(
                deps.as_ref(),
                mock_env(),
                QueryMsg::EstimateSwap {
                    offer_asset: AssetInfo::NativeInit,
                    offer_amount: Uint128::new(10_000),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert!(res.return_amount > Uint128::new(9800));
        assert!(res.fee_amount == Uint128::new(30)); // 0.3% of 10000
    }

    #[test]
    fn test_swap_on_empty_pool_fails() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let swapper = api.addr_make("swapper");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: None,
            fee_collector: None,
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        let info = message_info(
            &swapper,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(10_000),
            }],
        );
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::SwapInitForInitx { min_out: None },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::EmptyPool {});
    }

    #[test]
    fn test_collect_protocol_fees() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let fee_collector = api.addr_make("fee_collector");
        let user = api.addr_make("user");
        let swapper = api.addr_make("swapper");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: Some(1667),
            fee_collector: Some(fee_collector.to_string()),
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        // Seed pool
        execute_add_liquidity(
            deps.as_mut(),
            user,
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Swap INIT -> INITx (accrues INIT fees)
        let info = message_info(
            &swapper,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(10_000),
            }],
        );
        execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::SwapInitForInitx { min_out: None },
        )
        .unwrap();

        // Check accrued fees via query
        let res: AccruedFeesResponse = cosmwasm_std::from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::AccruedFees {}).unwrap(),
        )
        .unwrap();
        // fee = 10000 * 30 / 10000 = 30, protocol_fee = 30 * 1667 / 10000 = 5
        assert_eq!(res.init_fees, Uint128::new(5));
        assert_eq!(res.initx_fees, Uint128::zero());

        // Unauthorized user cannot collect
        let random = api.addr_make("random");
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&random, &[]),
            ExecuteMsg::CollectProtocolFees {},
        )
        .unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});

        // Fee collector can collect
        let res = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&fee_collector, &[]),
            ExecuteMsg::CollectProtocolFees {},
        )
        .unwrap();
        assert_eq!(res.messages.len(), 1); // Only INIT fees (no INITx fees)
        assert_eq!(
            res.attributes.iter().find(|a| a.key == "init_fees").unwrap().value,
            "5"
        );

        // Fees reset to zero
        let res: AccruedFeesResponse = cosmwasm_std::from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::AccruedFees {}).unwrap(),
        )
        .unwrap();
        assert_eq!(res.init_fees, Uint128::zero());
        assert_eq!(res.initx_fees, Uint128::zero());

        // Collecting again should fail (zero amount)
        let err = execute(
            deps.as_mut(),
            mock_env(),
            message_info(&fee_collector, &[]),
            ExecuteMsg::CollectProtocolFees {},
        )
        .unwrap_err();
        assert_eq!(err, ContractError::ZeroAmount {});
    }

    #[test]
    fn test_collect_fees_reserves_match_balance() {
        // After collecting protocol fees, reserves must be reduced so
        // reserves == actual contract balance. Swaps must still work.
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");
        let fee_collector = api.addr_make("fee_collector");
        let user = api.addr_make("user");
        let swapper = api.addr_make("swapper");

        let msg = InstantiateMsg {
            init_denom: "uinit".to_string(),
            initx_token: initx_token.to_string(),
            swap_fee_bps: Some(30),
            protocol_fee_bps: Some(1667),
            fee_collector: Some(fee_collector.to_string()),
        };
        instantiate(deps.as_mut(), mock_env(), message_info(&admin, &[]), msg).unwrap();

        // Seed pool with 1M each
        execute_add_liquidity(
            deps.as_mut(),
            user.clone(),
            Uint128::new(1_000_000),
            Uint128::new(1_000_000),
            None,
        )
        .unwrap();

        // Swap INIT -> INITx (accrues INIT fees)
        let info = message_info(
            &swapper,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(100_000),
            }],
        );
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::SwapInitForInitx { min_out: None }).unwrap();

        // Check pool state before collection
        let pool_before: PoolState = cosmwasm_std::from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::PoolState {}).unwrap(),
        ).unwrap();
        let init_reserve_before = pool_before.init_reserve;
        let init_fees = pool_before.accrued_fees_init;
        assert!(init_fees > Uint128::zero());

        // Collect fees
        execute(
            deps.as_mut(),
            mock_env(),
            message_info(&fee_collector, &[]),
            ExecuteMsg::CollectProtocolFees {},
        ).unwrap();

        // Check pool state after collection — reserves must be reduced by fee amounts
        let pool_after: PoolState = cosmwasm_std::from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::PoolState {}).unwrap(),
        ).unwrap();
        assert_eq!(pool_after.init_reserve, init_reserve_before - init_fees);
        assert_eq!(pool_after.accrued_fees_init, Uint128::zero());
        assert_eq!(pool_after.accrued_fees_initx, Uint128::zero());

        // Swap should still work after fee collection (reserves are consistent)
        let info2 = message_info(
            &swapper,
            &[Coin {
                denom: "uinit".to_string(),
                amount: Uint128::new(10_000),
            }],
        );
        let res = execute(deps.as_mut(), mock_env(), info2, ExecuteMsg::SwapInitForInitx { min_out: None });
        assert!(res.is_ok(), "Swap must succeed after fee collection");
    }
}
