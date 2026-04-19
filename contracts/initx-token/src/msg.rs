use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Addr, Uint128};

#[cw_serde]
pub struct InstantiateMsg {
    /// Token name
    pub name: String,
    /// Token symbol
    pub symbol: String,
    /// Decimal places (typically 6 for Cosmos)
    pub decimals: u8,
    /// Optional: set minter at instantiation. Can also be set later via SetMinter.
    pub minter: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Mint new tokens — only callable by minter (staking contract)
    Mint { recipient: String, amount: Uint128 },
    /// Burn tokens from caller — only callable by minter (staking contract)
    Burn { amount: Uint128 },
    /// Burn tokens from an account using allowance — only callable by minter
    BurnFrom { owner: String, amount: Uint128 },
    /// Standard transfer
    Transfer { recipient: String, amount: Uint128 },
    /// Transfer using allowance
    TransferFrom {
        owner: String,
        recipient: String,
        amount: Uint128,
    },
    /// Approve spender to use up to `amount` of caller's tokens
    IncreaseAllowance {
        spender: String,
        amount: Uint128,
    },
    /// Decrease allowance
    DecreaseAllowance {
        spender: String,
        amount: Uint128,
    },
    /// Set the minter address — only callable once by contract admin
    SetMinter { minter: String },
    /// Send tokens to a contract and trigger a Receive callback (CW20 Send)
    Send {
        contract: String,
        amount: Uint128,
        msg: cosmwasm_std::Binary,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Returns token balance for address
    #[returns(BalanceResponse)]
    Balance { address: String },
    /// Returns token metadata
    #[returns(TokenInfoResponse)]
    TokenInfo {},
    /// Returns the minter address
    #[returns(MinterResponse)]
    Minter {},
    /// Returns the allowance for a given owner-spender pair
    #[returns(AllowanceResponse)]
    Allowance { owner: String, spender: String },
    /// Returns all allowances for a given owner
    #[returns(AllAllowancesResponse)]
    AllAllowances {
        owner: String,
        start_after: Option<String>,
        limit: Option<u32>,
    },
    /// Returns all accounts with balances
    #[returns(AllAccountsResponse)]
    AllAccounts {
        start_after: Option<String>,
        limit: Option<u32>,
    },
}

// Response types
#[cw_serde]
pub struct BalanceResponse {
    pub balance: Uint128,
}

#[cw_serde]
pub struct TokenInfoResponse {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: Uint128,
}

#[cw_serde]
pub struct MinterResponse {
    pub minter: Option<Addr>,
}

#[cw_serde]
pub struct AllowanceResponse {
    pub allowance: Uint128,
}

#[cw_serde]
pub struct AllAllowancesResponse {
    pub allowances: Vec<AllowanceInfo>,
}

#[cw_serde]
pub struct AllowanceInfo {
    pub spender: Addr,
    pub allowance: Uint128,
}

#[cw_serde]
pub struct AllAccountsResponse {
    pub accounts: Vec<String>,
}

/// CW20 Receive message for cross-contract calls
#[cw_serde]
pub struct Cw20ReceiveMsg {
    pub sender: String,
    pub amount: Uint128,
    pub msg: cosmwasm_std::Binary,
}
