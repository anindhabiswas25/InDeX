use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Decimal, Uint128};
use cw20::Cw20ReceiveMsg;

#[cw_serde]
pub struct InstantiateMsg {
    pub init_denom: String,
    pub initx_token: String,
    pub lp_pool: String,
    pub collateral_factor: Option<Decimal>,
    pub liquidation_threshold: Option<Decimal>,
    pub liquidation_bonus: Option<Decimal>,
    pub borrow_rate: Option<Decimal>,
    /// Protocol fee on interest in basis points (default 1000 = 10%)
    pub protocol_fee_bps: Option<u16>,
    /// Address authorized to collect protocol fees (defaults to admin)
    pub fee_collector: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Receive CW20 INITx (for depositing collateral)
    Receive(Cw20ReceiveMsg),
    /// Supply INIT to the lending pool (lender). Send INIT as native funds.
    Supply {},
    /// Withdraw supplied INIT from lending pool
    WithdrawSupply { amount: Uint128 },
    /// Borrow INIT against INITx collateral
    Borrow { amount: Uint128 },
    /// Repay borrowed INIT. Send INIT as native funds.
    Repay {},
    /// Withdraw INITx collateral (must keep position healthy)
    WithdrawCollateral { amount: Uint128 },
    /// Liquidate undercollateralized position. Send INIT to repay debt.
    Liquidate { borrower: String },
    /// Admin: update parameters
    UpdateConfig {
        collateral_factor: Option<Decimal>,
        liquidation_threshold: Option<Decimal>,
        liquidation_bonus: Option<Decimal>,
        borrow_rate: Option<Decimal>,
        protocol_fee_bps: Option<u16>,
        fee_collector: Option<String>,
    },
    /// Collect accrued protocol fees (fee_collector or admin only)
    CollectProtocolFees {},
}

#[cw_serde]
pub enum Cw20HookMsg {
    DepositCollateral {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(crate::state::Config)]
    Config {},

    #[returns(crate::state::PoolState)]
    PoolState {},

    #[returns(PositionResponse)]
    Position { address: String },

    #[returns(HealthFactorResponse)]
    HealthFactor { address: String },

    #[returns(AccruedProtocolFeesResponse)]
    AccruedProtocolFees {},
}

#[cw_serde]
pub struct PositionResponse {
    pub collateral: Uint128,
    pub debt: Uint128,
    pub max_borrow: Uint128,
    pub health_factor: Decimal,
}

#[cw_serde]
pub struct HealthFactorResponse {
    pub health_factor: Decimal,
    pub is_liquidatable: bool,
}

#[cw_serde]
pub struct AccruedProtocolFeesResponse {
    pub fees: Uint128,
}
