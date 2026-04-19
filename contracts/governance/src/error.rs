use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("Unauthorized")]
    Unauthorized {},

    #[error("Proposal not found")]
    ProposalNotFound {},

    #[error("Voting period has ended")]
    VotingEnded {},

    #[error("Voting period has not ended yet")]
    VotingNotEnded {},

    #[error("Already voted on this proposal")]
    AlreadyVoted {},

    #[error("No voting power (zero INITx balance)")]
    NoVotingPower {},

    #[error("Proposal already executed")]
    AlreadyExecuted {},

    #[error("Proposal did not pass (quorum or threshold not met)")]
    ProposalNotPassed {},

    #[error("Empty title or description")]
    EmptyProposal {},

    #[error("Only INITx token contract can call Receive")]
    InvalidCw20Sender {},
}
