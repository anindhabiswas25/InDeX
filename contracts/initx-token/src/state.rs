use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};
use cosmwasm_schema::cw_serde;

#[cw_serde]
pub struct TokenInfo {
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: Uint128,
}

/// Token metadata
pub const TOKEN_INFO: Item<TokenInfo> = Item::new("token_info");

/// Minter (staking contract) — only this address can mint/burn
pub const MINTER: Item<Addr> = Item::new("minter");

/// Admin who can set minter once (deployer)
pub const ADMIN: Item<Addr> = Item::new("admin");

/// Balances: address -> amount
pub const BALANCES: Map<&Addr, Uint128> = Map::new("balances");

/// Allowances: (owner, spender) -> amount
pub const ALLOWANCES: Map<(&Addr, &Addr), Uint128> = Map::new("allowances");
