use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized: only the minter (staking contract) can call this")]
    Unauthorized {},

    #[error("Invalid zero amount")]
    ZeroAmount {},

    #[error("Cannot set minter to zero address")]
    InvalidMinter {},

    #[error("Minter already set")]
    MinterAlreadySet {},

    #[error("Insufficient balance: need {needed}, have {available}")]
    InsufficientBalance { needed: String, available: String },

    #[error("Insufficient allowance: need {needed}, have {available}")]
    InsufficientAllowance { needed: String, available: String },
}
