use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;
use cw20::Cw20ReceiveMsg;

#[cw_serde]
pub struct InstantiateMsg {
    /// INITx token contract address
    pub initx_token: String,
    /// Treasury address for protocol fees
    pub treasury: String,
    /// Keeper address (bot that calls add_rewards)
    pub keeper: String,
    /// Native INIT denomination (e.g., "uinit")
    pub init_denom: String,
    /// Protocol fee basis points (default 1000 = 10%)
    pub protocol_fee_bps: u16,
    /// Withdrawal cooldown in seconds (default 1_814_400 = 21 days)
    pub cooldown_period: u64,
    /// Validator address to delegate to
    pub validator: String,
    /// Initial liquidity buffer amount (from sent funds)
    pub buffer_percentage_bps: u16,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Deposit INIT, receive INITx. Send INIT as funds.
    Deposit {},
    /// Receive CW20 INITx (for withdrawal via Send pattern)
    Receive(Cw20ReceiveMsg),
    /// Request withdrawal: burn INITx, receive INIT (instant or queued).
    /// DEPRECATED: prefer sending INITx via CW20 Send to this contract.
    RequestWithdrawal { initx_amount: Uint128 },
    /// Claim a queued withdrawal after cooldown.
    ClaimWithdrawal { withdrawal_id: u64 },
    /// Add rewards to the pool (called by keeper). Sends INIT as funds.
    AddRewards {},
    /// Apply slashing penalty (called by admin/keeper).
    ApplySlashing { amount: Uint128 },
    /// Update config parameters (admin only).
    UpdateConfig {
        treasury: Option<String>,
        keeper: Option<String>,
        protocol_fee_bps: Option<u16>,
        cooldown_period: Option<u64>,
        validator: Option<String>,
    },
    /// Replenish the liquidity buffer from contract balance (admin/keeper).
    ReplenishBuffer { amount: Uint128 },
    /// Pause the contract (admin only).
    Pause {},
    /// Unpause the contract (admin only).
    Unpause {},
    /// Withdraw accumulated treasury fees (admin only).
    WithdrawFees {},
    /// Emit current exchange rate for off-chain indexers (keeper or admin).
    RecalibrateRate {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    /// Returns contract config
    #[returns(ConfigResponse)]
    Config {},
    /// Returns pool state (total staked, total supply, buffer)
    #[returns(PoolStateResponse)]
    PoolState {},
    /// Returns current exchange rate (scaled by 1_000_000)
    #[returns(ExchangeRateResponse)]
    ExchangeRate {},
    /// Returns pending withdrawals for a user
    #[returns(WithdrawalsResponse)]
    Withdrawals { user: String },
    /// Estimate how much INITx you get for depositing `amount` INIT
    #[returns(EstimateDepositResponse)]
    EstimateDeposit { amount: Uint128 },
    /// Estimate how much INIT you get for withdrawing `initx_amount` INITx
    #[returns(EstimateWithdrawalResponse)]
    EstimateWithdrawal { initx_amount: Uint128 },
    /// Returns whether the contract is paused
    #[returns(IsPausedResponse)]
    IsPaused {},
    /// Returns accumulated treasury balance
    #[returns(TreasuryBalanceResponse)]
    TreasuryBalance {},
}

// ── CW20 hook messages (sent inside Send) ──

#[cw_serde]
pub enum Cw20HookMsg {
    /// Withdraw: send INITx to this contract to burn and receive INIT back
    RequestWithdrawal {},
}

// ── Response types ──

#[cw_serde]
pub struct ConfigResponse {
    pub initx_token: String,
    pub treasury: String,
    pub keeper: String,
    pub init_denom: String,
    pub protocol_fee_bps: u16,
    pub cooldown_period: u64,
    pub validator: String,
}

#[cw_serde]
pub struct PoolStateResponse {
    pub total_init_staked: Uint128,
    pub total_initx_supply: Uint128,
    pub liquidity_buffer: Uint128,
}

#[cw_serde]
pub struct ExchangeRateResponse {
    /// Rate scaled by 1_000_000 (1.0 = 1_000_000)
    pub rate: Uint128,
    /// Human-readable rate string
    pub rate_display: String,
}

#[cw_serde]
pub struct WithdrawalsResponse {
    pub withdrawals: Vec<WithdrawalInfo>,
}

#[cw_serde]
pub struct WithdrawalInfo {
    pub id: u64,
    pub init_amount: Uint128,
    pub ready_at: u64,
}

#[cw_serde]
pub struct EstimateDepositResponse {
    pub initx_amount: Uint128,
}

#[cw_serde]
pub struct EstimateWithdrawalResponse {
    pub init_amount: Uint128,
}

#[cw_serde]
pub struct IsPausedResponse {
    pub paused: bool,
}

#[cw_serde]
pub struct TreasuryBalanceResponse {
    pub treasury_balance: Uint128,
}
