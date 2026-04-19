use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{Decimal, Uint128};
use cw20::Cw20ReceiveMsg;

use crate::state::VoteOption;

#[cw_serde]
pub struct InstantiateMsg {
    pub initx_token: String,
    /// Voting period in seconds (default 259200 = 3 days)
    pub voting_period: Option<u64>,
    /// Quorum fraction (default 0.10)
    pub quorum: Option<Decimal>,
    /// Threshold fraction (default 0.50)
    pub threshold: Option<Decimal>,
    /// Minimum INITx deposit to create proposal (default 1000_000000)
    pub proposal_deposit: Option<Uint128>,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Receive CW20 INITx (for creating proposals with deposit)
    Receive(Cw20ReceiveMsg),
    /// Vote on a proposal (voter's INITx balance = voting power)
    Vote { proposal_id: u64, vote: VoteOption },
    /// Execute a passed proposal after voting period ends
    Execute { proposal_id: u64 },
    /// Admin: update config
    UpdateConfig {
        voting_period: Option<u64>,
        quorum: Option<Decimal>,
        threshold: Option<Decimal>,
        proposal_deposit: Option<Uint128>,
    },
}

#[cw_serde]
pub enum Cw20HookMsg {
    /// Create a new proposal (INITx deposit required)
    CreateProposal {
        title: String,
        description: String,
        messages: Option<String>,
    },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(crate::state::Config)]
    Config {},

    #[returns(crate::state::Proposal)]
    Proposal { id: u64 },

    #[returns(ProposalListResponse)]
    Proposals {
        start_after: Option<u64>,
        limit: Option<u32>,
    },

    #[returns(crate::state::VoteRecord)]
    Vote { proposal_id: u64, voter: String },

    #[returns(ProposalStatusResponse)]
    ProposalStatus { id: u64 },
}

#[cw_serde]
pub struct ProposalListResponse {
    pub proposals: Vec<crate::state::Proposal>,
}

#[cw_serde]
pub struct ProposalStatusResponse {
    pub passed: bool,
    pub quorum_reached: bool,
    pub threshold_reached: bool,
    pub total_votes: Uint128,
}
