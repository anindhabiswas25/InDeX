use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Zero amount not allowed")]
    ZeroAmount {},

    #[error("Borrow would exceed collateral factor limit")]
    ExceedsCollateralFactor {},

    #[error("Position is not liquidatable (health factor >= 1)")]
    NotLiquidatable {},

    #[error("No outstanding debt to repay")]
    NoDebt {},

    #[error("Repay amount exceeds debt")]
    RepayExceedsDebt {},

    #[error("Insufficient pool liquidity for borrow")]
    InsufficientLiquidity {},

    #[error("Only INITx token contract can call Receive")]
    InvalidCw20Sender {},

    #[error("No collateral deposited")]
    NoCollateral {},

    #[error("Cannot withdraw: would make position liquidatable")]
    WithdrawWouldLiquidate {},

    #[error("No funds sent")]
    NoFunds {},

    #[error("No protocol fees to collect")]
    NoFeesToCollect {},
}
