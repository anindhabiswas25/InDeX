use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Decimal, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    pub init_denom: String,
    pub initx_token: Addr,
    /// LP pool contract for INITx price oracle (price = init_reserve / initx_reserve)
    pub lp_pool: Addr,
    /// Max borrow_value / collateral_value (e.g., 0.70)
    pub collateral_factor: Decimal,
    /// Position liquidatable when debt/collateral exceeds this (e.g., 0.80)
    pub liquidation_threshold: Decimal,
    /// Bonus collateral given to liquidators (e.g., 0.05 = 5%)
    pub liquidation_bonus: Decimal,
    /// Annual interest rate on borrows (e.g., 0.05 = 5% APR)
    pub borrow_rate: Decimal,
    /// Protocol fee on interest in basis points (e.g., 1000 = 10%)
    pub protocol_fee_bps: u16,
    /// Address authorized to collect protocol fees
    pub fee_collector: Addr,
}

#[cw_serde]
pub struct PoolState {
    /// Total INIT supplied by lenders
    pub total_supply: Uint128,
    /// Total INIT borrowed
    pub total_borrowed: Uint128,
    /// Last time interest was accrued (seconds)
    pub last_accrual_time: u64,
    /// Cumulative borrow index (starts at 1.0)
    pub borrow_index: Decimal,
    /// Accrued protocol fees available for collection (in INIT)
    pub accrued_protocol_fees: Uint128,
}

#[cw_serde]
pub struct UserPosition {
    /// INITx collateral deposited
    pub collateral: Uint128,
    /// Borrow shares (actual debt = shares * current_borrow_index / user_index)
    pub borrow_amount: Uint128,
    /// Borrow index at time of last borrow/repay
    pub borrow_index_snapshot: Decimal,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const POOL_STATE: Item<PoolState> = Item::new("pool_state");
pub const POSITIONS: Map<&Addr, UserPosition> = Map::new("positions");
/// Track how much each lender has supplied
pub const LENDER_DEPOSITS: Map<&Addr, Uint128> = Map::new("lender_deposits");
