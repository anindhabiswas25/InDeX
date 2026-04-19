use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid zero amount")]
    ZeroAmount {},

    #[error("No INIT funds sent")]
    NoFunds {},

    #[error("Wrong denomination: expected {expected}, got {got}")]
    WrongDenom { expected: String, got: String },

    #[error("Insufficient liquidity buffer: need {needed}, have {available}")]
    InsufficientBuffer { needed: String, available: String },

    #[error("Withdrawal not ready: ready at {ready_at}, current time {current}")]
    WithdrawalNotReady { ready_at: u64, current: u64 },

    #[error("Withdrawal not found")]
    WithdrawalNotFound {},

    #[error("Overflow")]
    Overflow {},

    #[error("Contract is paused")]
    Paused {},
}
