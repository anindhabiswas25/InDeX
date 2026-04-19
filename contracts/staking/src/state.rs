use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};
use cosmwasm_schema::cw_serde;

/// Contract configuration
#[cw_serde]
pub struct Config {
    /// INITx token contract address
    pub initx_token: Addr,
    /// Treasury address for protocol fees
    pub treasury: Addr,
    /// Keeper address (can call add_rewards)
    pub keeper: Addr,
    /// Admin/governance address
    pub admin: Addr,
    /// Native INIT denomination
    pub init_denom: String,
    /// Protocol fee in basis points (e.g., 1000 = 10%)
    pub protocol_fee_bps: u16,
    /// Withdrawal cooldown in seconds (21 days = 1_814_400)
    pub cooldown_period: u64,
    /// Validator address to delegate to (single validator for MVP)
    pub validator: String,
    /// Whether the contract is paused
    pub paused: bool,
}

/// Pool state tracking staked amounts
#[cw_serde]
pub struct PoolState {
    /// Total INIT considered staked (includes rewards, minus slashing)
    pub total_init_staked: Uint128,
    /// Total INITx supply (mirrors token contract)
    pub total_initx_supply: Uint128,
    /// Liquidity buffer for instant withdrawals (INIT held in contract)
    pub liquidity_buffer: Uint128,
    /// Accumulated treasury fees not yet withdrawn
    pub treasury_balance: Uint128,
}

/// Queued withdrawal request
#[cw_serde]
pub struct WithdrawalRequest {
    /// INIT amount owed to the user
    pub init_amount: Uint128,
    /// Timestamp when withdrawal can be claimed
    pub ready_at: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const POOL_STATE: Item<PoolState> = Item::new("pool_state");

/// Withdrawal queue: (user_addr, withdrawal_id) -> WithdrawalRequest
pub const WITHDRAWALS: Map<(&Addr, u64), WithdrawalRequest> = Map::new("withdrawals");

/// Next withdrawal ID counter
pub const NEXT_WITHDRAWAL_ID: Item<u64> = Item::new("next_withdrawal_id");
