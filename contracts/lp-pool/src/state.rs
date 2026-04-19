use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    /// Admin address
    pub admin: Addr,
    /// Native denom for INIT (e.g., "uinit")
    pub init_denom: String,
    /// CW20 contract address for INITx token
    pub initx_token: Addr,
    /// Swap fee in basis points (e.g., 30 = 0.30%)
    pub swap_fee_bps: u64,
    /// Protocol fee share of swap fees in basis points (e.g., 1667 = 1/6 of fee)
    pub protocol_fee_bps: u64,
    /// Address that receives protocol fees
    pub fee_collector: Addr,
}

#[cw_serde]
pub struct PoolState {
    /// Reserve of native INIT in the pool
    pub init_reserve: Uint128,
    /// Reserve of CW20 INITx in the pool
    pub initx_reserve: Uint128,
    /// Total LP shares outstanding
    pub total_lp_shares: Uint128,
    /// Accrued protocol fees in INIT
    pub accrued_fees_init: Uint128,
    /// Accrued protocol fees in INITx
    pub accrued_fees_initx: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const POOL_STATE: Item<PoolState> = Item::new("pool_state");
/// Map of address -> LP share balance
pub const LP_SHARES: Map<&Addr, Uint128> = Map::new("lp_shares");
