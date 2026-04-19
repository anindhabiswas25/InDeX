use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum SharedError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Invalid zero amount")]
    ZeroAmount {},

    #[error("Insufficient funds: need {needed}, have {available}")]
    InsufficientFunds { needed: String, available: String },

    #[error("Overflow error")]
    Overflow {},
}
