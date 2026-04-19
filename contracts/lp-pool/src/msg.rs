use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;
use cw20::Cw20ReceiveMsg;

#[cw_serde]
pub struct InstantiateMsg {
    /// Native denom for INIT (e.g., "uinit")
    pub init_denom: String,
    /// CW20 contract address for INITx token
    pub initx_token: String,
    /// Swap fee in basis points (default 30 = 0.30%)
    pub swap_fee_bps: Option<u64>,
    /// Protocol fee share of swap fees in bps (default 1667 ~= 1/6)
    pub protocol_fee_bps: Option<u64>,
    /// Address that receives protocol fees (defaults to admin)
    pub fee_collector: Option<String>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Receive CW20 tokens (INITx) — dispatches based on inner msg
    Receive(Cw20ReceiveMsg),

    /// Swap native INIT for INITx. Send INIT as funds.
    SwapInitForInitx { min_out: Option<Uint128> },

    /// Remove liquidity by burning LP shares. Returns both INIT and INITx.
    RemoveLiquidity { lp_shares: Uint128 },

    /// Admin: update config
    UpdateConfig {
        swap_fee_bps: Option<u64>,
        protocol_fee_bps: Option<u64>,
        fee_collector: Option<String>,
    },

    /// Collect accrued protocol fees (admin or fee_collector only)
    CollectProtocolFees {},
}

/// Messages that can be sent inside a CW20 Receive callback
#[cw_serde]
pub enum Cw20HookMsg {
    /// Swap INITx for INIT
    SwapInitxForInit { min_out: Option<Uint128> },
    /// Add liquidity: send INITx via CW20 Send, attach INIT as native funds
    /// (the INIT side is provided alongside the CW20 Send using the contract's
    /// WasmMsg::Execute with funds)
    AddLiquidity { min_lp_shares: Option<Uint128> },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(crate::state::Config)]
    Config {},

    #[returns(crate::state::PoolState)]
    PoolState {},

    #[returns(LpBalanceResponse)]
    LpBalance { address: String },

    #[returns(SwapEstimateResponse)]
    EstimateSwap {
        offer_asset: AssetInfo,
        offer_amount: Uint128,
    },

    #[returns(AccruedFeesResponse)]
    AccruedFees {},
}

#[cw_serde]
pub struct LpBalanceResponse {
    pub shares: Uint128,
    pub init_value: Uint128,
    pub initx_value: Uint128,
}

#[cw_serde]
pub struct SwapEstimateResponse {
    pub return_amount: Uint128,
    pub fee_amount: Uint128,
}

#[cw_serde]
pub enum AssetInfo {
    NativeInit,
    Cw20Initx,
}

#[cw_serde]
pub struct AccruedFeesResponse {
    pub init_fees: Uint128,
    pub initx_fees: Uint128,
}
