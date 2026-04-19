use cosmwasm_schema::cw_serde;
use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Order, Response,
    StdResult, Uint128, WasmMsg,
};
use cw_storage_plus::Bound as CwBound;
use cw2::set_contract_version;

use crate::error::ContractError;
use crate::msg::*;
use crate::state::*;

const CONTRACT_NAME: &str = "crates.io:initx-token";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_LIMIT: u32 = 10;
const MAX_LIMIT: u32 = 30;

// ──────────────────────────── Instantiate ────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let token_info = TokenInfo {
        name: msg.name.clone(),
        symbol: msg.symbol.clone(),
        decimals: msg.decimals,
        total_supply: Uint128::zero(),
    };
    TOKEN_INFO.save(deps.storage, &token_info)?;
    ADMIN.save(deps.storage, &info.sender)?;

    if let Some(minter_str) = msg.minter {
        let minter_addr = deps.api.addr_validate(&minter_str)?;
        MINTER.save(deps.storage, &minter_addr)?;
    }

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("name", msg.name)
        .add_attribute("symbol", msg.symbol))
}

// ──────────────────────────── Execute ────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Mint { recipient, amount } => exec_mint(deps, info, recipient, amount),
        ExecuteMsg::Burn { amount } => exec_burn(deps, info, amount),
        ExecuteMsg::BurnFrom { owner, amount } => exec_burn_from(deps, info, owner, amount),
        ExecuteMsg::Transfer { recipient, amount } => {
            exec_transfer(deps, info, recipient, amount)
        }
        ExecuteMsg::TransferFrom {
            owner,
            recipient,
            amount,
        } => exec_transfer_from(deps, info, owner, recipient, amount),
        ExecuteMsg::IncreaseAllowance { spender, amount } => {
            exec_increase_allowance(deps, info, spender, amount)
        }
        ExecuteMsg::DecreaseAllowance { spender, amount } => {
            exec_decrease_allowance(deps, info, spender, amount)
        }
        ExecuteMsg::SetMinter { minter } => exec_set_minter(deps, info, minter),
        ExecuteMsg::Send {
            contract,
            amount,
            msg: send_msg,
        } => exec_send(deps, env, info, contract, amount, send_msg),
    }
}

fn only_minter(deps: &DepsMut, info: &MessageInfo) -> Result<(), ContractError> {
    let minter = MINTER
        .may_load(deps.storage)?
        .ok_or(ContractError::Unauthorized {})?;
    if info.sender != minter {
        return Err(ContractError::Unauthorized {});
    }
    Ok(())
}

fn exec_mint(
    deps: DepsMut,
    info: MessageInfo,
    recipient: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    only_minter(&deps, &info)?;

    let recipient_addr = deps.api.addr_validate(&recipient)?;

    // Update balance
    let balance = BALANCES
        .may_load(deps.storage, &recipient_addr)?
        .unwrap_or_default();
    BALANCES.save(deps.storage, &recipient_addr, &(balance + amount))?;

    // Update total supply
    TOKEN_INFO.update(deps.storage, |mut t| -> StdResult<_> {
        t.total_supply += amount;
        Ok(t)
    })?;

    Ok(Response::new()
        .add_attribute("action", "mint")
        .add_attribute("to", recipient)
        .add_attribute("amount", amount))
}

fn exec_burn(
    deps: DepsMut,
    info: MessageInfo,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    only_minter(&deps, &info)?;

    // Burn from minter's own balance
    let balance = BALANCES
        .may_load(deps.storage, &info.sender)?
        .unwrap_or_default();
    if balance < amount {
        return Err(ContractError::InsufficientBalance {
            needed: amount.to_string(),
            available: balance.to_string(),
        });
    }
    BALANCES.save(deps.storage, &info.sender, &(balance - amount))?;

    TOKEN_INFO.update(deps.storage, |mut t| -> StdResult<_> {
        t.total_supply -= amount;
        Ok(t)
    })?;

    Ok(Response::new()
        .add_attribute("action", "burn")
        .add_attribute("from", info.sender)
        .add_attribute("amount", amount))
}

fn exec_burn_from(
    deps: DepsMut,
    info: MessageInfo,
    owner: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    only_minter(&deps, &info)?;

    let owner_addr = deps.api.addr_validate(&owner)?;

    // Check and deduct allowance
    let allowance = ALLOWANCES
        .may_load(deps.storage, (&owner_addr, &info.sender))?
        .unwrap_or_default();
    if allowance < amount {
        return Err(ContractError::InsufficientAllowance {
            needed: amount.to_string(),
            available: allowance.to_string(),
        });
    }
    ALLOWANCES.save(
        deps.storage,
        (&owner_addr, &info.sender),
        &(allowance - amount),
    )?;

    // Deduct balance
    let balance = BALANCES
        .may_load(deps.storage, &owner_addr)?
        .unwrap_or_default();
    if balance < amount {
        return Err(ContractError::InsufficientBalance {
            needed: amount.to_string(),
            available: balance.to_string(),
        });
    }
    BALANCES.save(deps.storage, &owner_addr, &(balance - amount))?;

    TOKEN_INFO.update(deps.storage, |mut t| -> StdResult<_> {
        t.total_supply -= amount;
        Ok(t)
    })?;

    Ok(Response::new()
        .add_attribute("action", "burn_from")
        .add_attribute("from", owner)
        .add_attribute("amount", amount))
}

fn exec_transfer(
    deps: DepsMut,
    info: MessageInfo,
    recipient: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let recipient_addr = deps.api.addr_validate(&recipient)?;

    let sender_balance = BALANCES
        .may_load(deps.storage, &info.sender)?
        .unwrap_or_default();
    if sender_balance < amount {
        return Err(ContractError::InsufficientBalance {
            needed: amount.to_string(),
            available: sender_balance.to_string(),
        });
    }
    BALANCES.save(deps.storage, &info.sender, &(sender_balance - amount))?;

    let recipient_balance = BALANCES
        .may_load(deps.storage, &recipient_addr)?
        .unwrap_or_default();
    BALANCES.save(
        deps.storage,
        &recipient_addr,
        &(recipient_balance + amount),
    )?;

    Ok(Response::new()
        .add_attribute("action", "transfer")
        .add_attribute("from", info.sender)
        .add_attribute("to", recipient)
        .add_attribute("amount", amount))
}

fn exec_transfer_from(
    deps: DepsMut,
    info: MessageInfo,
    owner: String,
    recipient: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let owner_addr = deps.api.addr_validate(&owner)?;
    let recipient_addr = deps.api.addr_validate(&recipient)?;

    // Check allowance
    let allowance = ALLOWANCES
        .may_load(deps.storage, (&owner_addr, &info.sender))?
        .unwrap_or_default();
    if allowance < amount {
        return Err(ContractError::InsufficientAllowance {
            needed: amount.to_string(),
            available: allowance.to_string(),
        });
    }
    ALLOWANCES.save(
        deps.storage,
        (&owner_addr, &info.sender),
        &(allowance - amount),
    )?;

    // Transfer
    let owner_balance = BALANCES
        .may_load(deps.storage, &owner_addr)?
        .unwrap_or_default();
    if owner_balance < amount {
        return Err(ContractError::InsufficientBalance {
            needed: amount.to_string(),
            available: owner_balance.to_string(),
        });
    }
    BALANCES.save(deps.storage, &owner_addr, &(owner_balance - amount))?;

    let recipient_balance = BALANCES
        .may_load(deps.storage, &recipient_addr)?
        .unwrap_or_default();
    BALANCES.save(
        deps.storage,
        &recipient_addr,
        &(recipient_balance + amount),
    )?;

    Ok(Response::new()
        .add_attribute("action", "transfer_from")
        .add_attribute("from", owner)
        .add_attribute("to", recipient)
        .add_attribute("by", info.sender)
        .add_attribute("amount", amount))
}

fn exec_increase_allowance(
    deps: DepsMut,
    info: MessageInfo,
    spender: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let spender_addr = deps.api.addr_validate(&spender)?;
    let current = ALLOWANCES
        .may_load(deps.storage, (&info.sender, &spender_addr))?
        .unwrap_or_default();
    ALLOWANCES.save(
        deps.storage,
        (&info.sender, &spender_addr),
        &(current + amount),
    )?;

    Ok(Response::new()
        .add_attribute("action", "increase_allowance")
        .add_attribute("owner", info.sender)
        .add_attribute("spender", spender)
        .add_attribute("amount", amount))
}

fn exec_decrease_allowance(
    deps: DepsMut,
    info: MessageInfo,
    spender: String,
    amount: Uint128,
) -> Result<Response, ContractError> {
    let spender_addr = deps.api.addr_validate(&spender)?;
    let current = ALLOWANCES
        .may_load(deps.storage, (&info.sender, &spender_addr))?
        .unwrap_or_default();
    let new_allowance = current.checked_sub(amount).unwrap_or_default();
    ALLOWANCES.save(
        deps.storage,
        (&info.sender, &spender_addr),
        &new_allowance,
    )?;

    Ok(Response::new()
        .add_attribute("action", "decrease_allowance")
        .add_attribute("owner", info.sender)
        .add_attribute("spender", spender)
        .add_attribute("new_allowance", new_allowance))
}

fn exec_set_minter(
    deps: DepsMut,
    info: MessageInfo,
    minter: String,
) -> Result<Response, ContractError> {
    let admin = ADMIN.load(deps.storage)?;
    if info.sender != admin {
        return Err(ContractError::Unauthorized {});
    }
    if MINTER.may_load(deps.storage)?.is_some() {
        return Err(ContractError::MinterAlreadySet {});
    }
    let minter_addr = deps.api.addr_validate(&minter)?;
    MINTER.save(deps.storage, &minter_addr)?;

    Ok(Response::new()
        .add_attribute("action", "set_minter")
        .add_attribute("minter", minter))
}

/// Wrapper so the CW20 Receive callback serializes as `{"receive":{...}}`
/// which is the variant every receiving contract expects.
#[cw_serde]
enum ReceiverExecuteMsg {
    Receive(cw20::Cw20ReceiveMsg),
}

fn exec_send(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    contract: String,
    amount: Uint128,
    msg: Binary,
) -> Result<Response, ContractError> {
    if amount.is_zero() {
        return Err(ContractError::ZeroAmount {});
    }
    let contract_addr = deps.api.addr_validate(&contract)?;

    // Deduct from sender
    let balance = BALANCES
        .may_load(deps.storage, &info.sender)?
        .unwrap_or_default();
    if balance < amount {
        return Err(ContractError::InsufficientBalance {
            needed: amount.to_string(),
            available: balance.to_string(),
        });
    }
    BALANCES.save(deps.storage, &info.sender, &(balance - amount))?;

    // Credit to contract
    let contract_balance = BALANCES
        .may_load(deps.storage, &contract_addr)?
        .unwrap_or_default();
    BALANCES.save(
        deps.storage,
        &contract_addr,
        &(contract_balance + amount),
    )?;

    // Build CW20 Receive callback — wrapped in ExecuteMsg::Receive
    let receive_msg = cw20::Cw20ReceiveMsg {
        sender: info.sender.to_string(),
        amount,
        msg,
    };

    // The receiving contract expects {"receive": {...}} as its ExecuteMsg variant
    let callback = WasmMsg::Execute {
        contract_addr: contract.clone(),
        msg: to_json_binary(&ReceiverExecuteMsg::Receive(receive_msg))?,
        funds: vec![],
    };

    Ok(Response::new()
        .add_message(callback)
        .add_attribute("action", "send")
        .add_attribute("from", info.sender)
        .add_attribute("to", contract)
        .add_attribute("amount", amount))
}

// ──────────────────────────── Query ────────────────────────────

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Balance { address } => to_json_binary(&query_balance(deps, address)?),
        QueryMsg::TokenInfo {} => to_json_binary(&query_token_info(deps)?),
        QueryMsg::Minter {} => to_json_binary(&query_minter(deps)?),
        QueryMsg::Allowance { owner, spender } => {
            to_json_binary(&query_allowance(deps, owner, spender)?)
        }
        QueryMsg::AllAllowances {
            owner,
            start_after,
            limit,
        } => to_json_binary(&query_all_allowances(deps, owner, start_after, limit)?),
        QueryMsg::AllAccounts {
            start_after,
            limit,
        } => to_json_binary(&query_all_accounts(deps, start_after, limit)?),
    }
}

fn query_balance(deps: Deps, address: String) -> StdResult<BalanceResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let balance = BALANCES
        .may_load(deps.storage, &addr)?
        .unwrap_or_default();
    Ok(BalanceResponse { balance })
}

fn query_token_info(deps: Deps) -> StdResult<TokenInfoResponse> {
    let info = TOKEN_INFO.load(deps.storage)?;
    Ok(TokenInfoResponse {
        name: info.name,
        symbol: info.symbol,
        decimals: info.decimals,
        total_supply: info.total_supply,
    })
}

fn query_minter(deps: Deps) -> StdResult<MinterResponse> {
    let minter = MINTER.may_load(deps.storage)?;
    Ok(MinterResponse { minter })
}

fn query_allowance(deps: Deps, owner: String, spender: String) -> StdResult<AllowanceResponse> {
    let owner_addr = deps.api.addr_validate(&owner)?;
    let spender_addr = deps.api.addr_validate(&spender)?;
    let allowance = ALLOWANCES
        .may_load(deps.storage, (&owner_addr, &spender_addr))?
        .unwrap_or_default();
    Ok(AllowanceResponse { allowance })
}

fn query_all_allowances(
    deps: Deps,
    owner: String,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<AllAllowancesResponse> {
    let owner_addr = deps.api.addr_validate(&owner)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    let start = start_after
        .map(|s| deps.api.addr_validate(&s))
        .transpose()?;

    let allowances: Vec<AllowanceInfo> = ALLOWANCES
        .prefix(&owner_addr)
        .range(
            deps.storage,
            start.as_ref().map(CwBound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit)
        .map(|item| {
            let (spender, allowance) = item?;
            Ok(AllowanceInfo { spender, allowance })
        })
        .collect::<StdResult<Vec<_>>>()?;

    Ok(AllAllowancesResponse { allowances })
}

fn query_all_accounts(
    deps: Deps,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<AllAccountsResponse> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    let start = start_after
        .map(|s| deps.api.addr_validate(&s))
        .transpose()?;

    let accounts: Vec<String> = BALANCES
        .range(
            deps.storage,
            start.as_ref().map(CwBound::exclusive),
            None,
            Order::Ascending,
        )
        .take(limit)
        .map(|item| {
            let (addr, _) = item?;
            Ok(addr.to_string())
        })
        .collect::<StdResult<Vec<_>>>()?;

    Ok(AllAccountsResponse { accounts })
}

// ──────────────────────────── Tests ────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{mock_dependencies, mock_env, message_info, MockApi};
    use cosmwasm_std::Addr;

    fn mock_addr(label: &str) -> Addr {
        MockApi::default().addr_make(label)
    }

    fn setup_token(deps: DepsMut) {
        let minter = mock_addr("minter");
        let admin = mock_addr("admin");
        let msg = InstantiateMsg {
            name: "INITx".to_string(),
            symbol: "INITx".to_string(),
            decimals: 6,
            minter: Some(minter.to_string()),
        };
        let info = message_info(&admin, &[]);
        instantiate(deps, mock_env(), info, msg).unwrap();
    }

    #[test]
    fn test_instantiate() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let info = TOKEN_INFO.load(&deps.storage).unwrap();
        assert_eq!(info.name, "INITx");
        assert_eq!(info.symbol, "INITx");
        assert_eq!(info.decimals, 6);
        assert_eq!(info.total_supply, Uint128::zero());

        let minter = crate::state::MINTER.load(&deps.storage).unwrap();
        assert_eq!(minter, mock_addr("minter"));
    }

    #[test]
    fn test_mint_only_by_minter() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let random = mock_addr("random");
        let minter = mock_addr("minter");
        let user1 = mock_addr("user1");

        // Non-minter cannot mint
        let info = message_info(&random, &[]);
        let msg = ExecuteMsg::Mint {
            recipient: user1.to_string(),
            amount: Uint128::new(1000),
        };
        let err = execute(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});

        // Minter can mint
        let info = message_info(&minter, &[]);
        let msg = ExecuteMsg::Mint {
            recipient: user1.to_string(),
            amount: Uint128::new(1000),
        };
        execute(deps.as_mut(), mock_env(), info, msg).unwrap();

        let bal = BALANCES.load(&deps.storage, &user1).unwrap();
        assert_eq!(bal, Uint128::new(1000));

        let ti = TOKEN_INFO.load(&deps.storage).unwrap();
        assert_eq!(ti.total_supply, Uint128::new(1000));
    }

    #[test]
    fn test_transfer() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let minter = mock_addr("minter");
        let user1 = mock_addr("user1");
        let user2 = mock_addr("user2");

        let info = message_info(&minter, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Mint { recipient: user1.to_string(), amount: Uint128::new(500) },
        ).unwrap();

        let info = message_info(&user1, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Transfer { recipient: user2.to_string(), amount: Uint128::new(200) },
        ).unwrap();

        assert_eq!(BALANCES.load(&deps.storage, &user1).unwrap(), Uint128::new(300));
        assert_eq!(BALANCES.load(&deps.storage, &user2).unwrap(), Uint128::new(200));
    }

    #[test]
    fn test_transfer_insufficient() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let minter = mock_addr("minter");
        let user1 = mock_addr("user1");
        let user2 = mock_addr("user2");

        let info = message_info(&minter, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Mint { recipient: user1.to_string(), amount: Uint128::new(100) },
        ).unwrap();

        let info = message_info(&user1, &[]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Transfer { recipient: user2.to_string(), amount: Uint128::new(200) },
        ).unwrap_err();
        assert!(matches!(err, ContractError::InsufficientBalance { .. }));
    }

    #[test]
    fn test_burn() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let minter = mock_addr("minter");

        let info = message_info(&minter, &[]);
        execute(
            deps.as_mut(), mock_env(), info.clone(),
            ExecuteMsg::Mint { recipient: minter.to_string(), amount: Uint128::new(1000) },
        ).unwrap();

        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Burn { amount: Uint128::new(400) },
        ).unwrap();

        assert_eq!(BALANCES.load(&deps.storage, &minter).unwrap(), Uint128::new(600));
        assert_eq!(TOKEN_INFO.load(&deps.storage).unwrap().total_supply, Uint128::new(600));
    }

    #[test]
    fn test_allowance_and_transfer_from() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let minter = mock_addr("minter");
        let user1 = mock_addr("user1");
        let user2 = mock_addr("user2");
        let spender = mock_addr("spender");

        let info = message_info(&minter, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Mint { recipient: user1.to_string(), amount: Uint128::new(1000) },
        ).unwrap();

        let info = message_info(&user1, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::IncreaseAllowance { spender: spender.to_string(), amount: Uint128::new(500) },
        ).unwrap();

        let info = message_info(&spender, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::TransferFrom {
                owner: user1.to_string(),
                recipient: user2.to_string(),
                amount: Uint128::new(300),
            },
        ).unwrap();

        assert_eq!(BALANCES.load(&deps.storage, &user1).unwrap(), Uint128::new(700));
        assert_eq!(BALANCES.load(&deps.storage, &user2).unwrap(), Uint128::new(300));
        assert_eq!(
            ALLOWANCES.load(&deps.storage, (&user1, &spender)).unwrap(),
            Uint128::new(200)
        );
    }

    #[test]
    fn test_set_minter_only_admin() {
        let mut deps = mock_dependencies();

        let admin = mock_addr("admin");
        let minter = mock_addr("minter");
        let random = mock_addr("random");

        let msg = InstantiateMsg {
            name: "INITx".to_string(),
            symbol: "INITx".to_string(),
            decimals: 6,
            minter: None,
        };
        let info = message_info(&admin, &[]);
        instantiate(deps.as_mut(), mock_env(), info, msg).unwrap();

        // Non-admin cannot set minter
        let info = message_info(&random, &[]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::SetMinter { minter: minter.to_string() },
        ).unwrap_err();
        assert_eq!(err, ContractError::Unauthorized {});

        // Admin sets minter
        let info = message_info(&admin, &[]);
        execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::SetMinter { minter: minter.to_string() },
        ).unwrap();

        // Cannot set again
        let info = message_info(&admin, &[]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::SetMinter { minter: random.to_string() },
        ).unwrap_err();
        assert_eq!(err, ContractError::MinterAlreadySet {});
    }

    #[test]
    fn test_zero_amount_rejected() {
        let mut deps = mock_dependencies();
        setup_token(deps.as_mut());

        let minter = mock_addr("minter");
        let user1 = mock_addr("user1");

        let info = message_info(&minter, &[]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Mint { recipient: user1.to_string(), amount: Uint128::zero() },
        ).unwrap_err();
        assert_eq!(err, ContractError::ZeroAmount {});
    }
}
