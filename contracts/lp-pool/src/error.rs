use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Pool already initialized with liquidity")]
    PoolAlreadyInitialized {},

    #[error("Insufficient liquidity minted (would be zero)")]
    InsufficientLiquidityMinted {},

    #[error("Insufficient liquidity burned (would yield zero tokens)")]
    InsufficientLiquidityBurned {},

    #[error("Insufficient output amount: expected at least {min_out}, got {actual}")]
    InsufficientOutputAmount { min_out: String, actual: String },

    #[error("Zero amount not allowed")]
    ZeroAmount {},

    #[error("No INIT funds sent")]
    NoInitFunds {},

    #[error("Must send exactly one native denom")]
    InvalidFunds {},

    #[error("Pool has zero reserves")]
    EmptyPool {},

    #[error("Slippage tolerance exceeded")]
    SlippageExceeded {},

    #[error("Insufficient LP shares: have {have}, requested {requested}")]
    InsufficientLpShares { have: String, requested: String },
}
