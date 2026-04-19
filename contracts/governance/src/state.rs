use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Decimal, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// CW20 INITx token address (voting power source)
    pub initx_token: Addr,
    /// Voting period in seconds (e.g., 3 days = 259200)
    pub voting_period: u64,
    /// Minimum quorum: fraction of total supply that must vote (e.g., 0.10 = 10%)
    pub quorum: Decimal,
    /// Threshold: fraction of votes that must be "yes" to pass (e.g., 0.50 = 50%)
    pub threshold: Decimal,
    /// Minimum INITx deposit to create a proposal
    pub proposal_deposit: Uint128,
}

#[cw_serde]
pub struct Proposal {
    pub id: u64,
    pub proposer: Addr,
    pub title: String,
    pub description: String,
    /// Optional JSON-encoded list of messages to execute if passed
    pub messages: Option<String>,
    pub start_time: u64,
    pub end_time: u64,
    pub yes_votes: Uint128,
    pub no_votes: Uint128,
    pub abstain_votes: Uint128,
    /// Total INITx supply at proposal creation (snapshot for quorum calc)
    pub total_supply_snapshot: Uint128,
    pub executed: bool,
    /// Deposit amount held
    pub deposit: Uint128,
}

#[cw_serde]
pub enum VoteOption {
    Yes,
    No,
    Abstain,
}

#[cw_serde]
pub struct VoteRecord {
    pub voter: Addr,
    pub option: VoteOption,
    pub power: Uint128,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const PROPOSAL_COUNT: Item<u64> = Item::new("proposal_count");
pub const PROPOSALS: Map<u64, Proposal> = Map::new("proposals");
/// (proposal_id, voter_addr) -> VoteRecord
pub const VOTES: Map<(u64, &Addr), VoteRecord> = Map::new("votes");
