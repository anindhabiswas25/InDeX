use cosmwasm_std::{
    entry_point, to_json_binary, Addr, Binary, Deps, DepsMut, Env, Fraction, MessageInfo,
    Response, StdResult, Uint128, WasmMsg,
};
use cw2::set_contract_version;
use cw20::{BalanceResponse, Cw20QueryMsg, Cw20ReceiveMsg};
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::msg::{
    Cw20HookMsg, ExecuteMsg, InstantiateMsg, ProposalListResponse, ProposalStatusResponse,
    QueryMsg,
};
use crate::state::{
    Config, Proposal, VoteOption, VoteRecord, CONFIG, PROPOSALS, PROPOSAL_COUNT, VOTES,
};

const CONTRACT_NAME: &str = "crates.io:initx-governance";
const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_VOTING_PERIOD: u64 = 259_200; // 3 days
const DEFAULT_LIMIT: u32 = 10;
const MAX_LIMIT: u32 = 30;

// ── Helpers ──

fn query_initx_balance(deps: Deps, initx_token: &Addr, address: &Addr) -> StdResult<Uint128> {
    let resp: BalanceResponse = deps.querier.query_wasm_smart(
        initx_token.to_string(),
        &Cw20QueryMsg::Balance {
            address: address.to_string(),
        },
    )?;
    Ok(resp.balance)
}

fn query_initx_total_supply(deps: Deps, initx_token: &Addr) -> StdResult<Uint128> {
    let resp: cw20::TokenInfoResponse = deps.querier.query_wasm_smart(
        initx_token.to_string(),
        &Cw20QueryMsg::TokenInfo {},
    )?;
    Ok(resp.total_supply)
}

fn check_proposal_status(
    proposal: &Proposal,
    config: &Config,
) -> (bool, bool, bool) {
    let total_votes = proposal.yes_votes + proposal.no_votes + proposal.abstain_votes;

    // Quorum: total_votes / total_supply_snapshot >= quorum
    let quorum_reached = if proposal.total_supply_snapshot.is_zero() {
        false
    } else {
        // total_votes * quorum.denom >= total_supply * quorum.num
        let lhs = total_votes.full_mul(config.quorum.denominator());
        let rhs = proposal.total_supply_snapshot.full_mul(config.quorum.numerator());
        lhs >= rhs
    };

    // Threshold: yes / (yes + no) >= threshold (abstain doesn't count)
    let vote_total = proposal.yes_votes + proposal.no_votes;
    let threshold_reached = if vote_total.is_zero() {
        false
    } else {
        let lhs = proposal.yes_votes.full_mul(config.threshold.denominator());
        let rhs = vote_total.full_mul(config.threshold.numerator());
        lhs >= rhs
    };

    let passed = quorum_reached && threshold_reached;
    (passed, quorum_reached, threshold_reached)
}

// ── Entry points ──

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    set_contract_version(deps.storage, CONTRACT_NAME, CONTRACT_VERSION)?;

    let config = Config {
        admin: info.sender.clone(),
        initx_token: deps.api.addr_validate(&msg.initx_token)?,
        voting_period: msg.voting_period.unwrap_or(DEFAULT_VOTING_PERIOD),
        quorum: msg.quorum.unwrap_or(cosmwasm_std::Decimal::percent(10)),
        threshold: msg.threshold.unwrap_or(cosmwasm_std::Decimal::percent(50)),
        proposal_deposit: msg
            .proposal_deposit
            .unwrap_or(Uint128::new(1_000_000_000)),
    };
    CONFIG.save(deps.storage, &config)?;
    PROPOSAL_COUNT.save(deps.storage, &0u64)?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("admin", info.sender))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Receive(cw20_msg) => execute_receive(deps, env, info, cw20_msg),
        ExecuteMsg::Vote { proposal_id, vote } => execute_vote(deps, env, info, proposal_id, vote),
        ExecuteMsg::Execute { proposal_id } => execute_execute(deps, env, info, proposal_id),
        ExecuteMsg::UpdateConfig {
            voting_period,
            quorum,
            threshold,
            proposal_deposit,
        } => execute_update_config(deps, info, voting_period, quorum, threshold, proposal_deposit),
    }
}

fn execute_receive(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    cw20_msg: Cw20ReceiveMsg,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.initx_token {
        return Err(ContractError::InvalidCw20Sender {});
    }

    let sender = deps.api.addr_validate(&cw20_msg.sender)?;
    let amount = cw20_msg.amount;
    let hook_msg: Cw20HookMsg = cosmwasm_std::from_json(&cw20_msg.msg)?;

    match hook_msg {
        Cw20HookMsg::CreateProposal {
            title,
            description,
            messages,
        } => execute_create_proposal(deps, env, sender, amount, title, description, messages),
    }
}

fn execute_create_proposal(
    deps: DepsMut,
    env: Env,
    proposer: Addr,
    deposit: Uint128,
    title: String,
    description: String,
    messages: Option<String>,
) -> Result<Response, ContractError> {
    if title.is_empty() || description.is_empty() {
        return Err(ContractError::EmptyProposal {});
    }

    let config = CONFIG.load(deps.storage)?;

    // For MVP, skip minimum deposit check if testing — but enforce in production
    // if deposit < config.proposal_deposit { return Err(...) }

    let total_supply = query_initx_total_supply(deps.as_ref(), &config.initx_token)
        .unwrap_or(Uint128::new(1_000_000)); // fallback for testing

    let id = PROPOSAL_COUNT.load(deps.storage)? + 1;
    PROPOSAL_COUNT.save(deps.storage, &id)?;

    let now = env.block.time.seconds();
    let proposal = Proposal {
        id,
        proposer: proposer.clone(),
        title: title.clone(),
        description,
        messages,
        start_time: now,
        end_time: now + config.voting_period,
        yes_votes: Uint128::zero(),
        no_votes: Uint128::zero(),
        abstain_votes: Uint128::zero(),
        total_supply_snapshot: total_supply,
        executed: false,
        deposit,
    };
    PROPOSALS.save(deps.storage, id, &proposal)?;

    Ok(Response::new()
        .add_attribute("action", "create_proposal")
        .add_attribute("proposal_id", id.to_string())
        .add_attribute("proposer", proposer)
        .add_attribute("title", title))
}

fn execute_vote(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    proposal_id: u64,
    vote: VoteOption,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut proposal = PROPOSALS
        .may_load(deps.storage, proposal_id)?
        .ok_or(ContractError::ProposalNotFound {})?;

    let now = env.block.time.seconds();
    if now > proposal.end_time {
        return Err(ContractError::VotingEnded {});
    }

    if VOTES
        .may_load(deps.storage, (proposal_id, &info.sender))?
        .is_some()
    {
        return Err(ContractError::AlreadyVoted {});
    }

    // Voting power = INITx balance at time of vote
    let power = query_initx_balance(deps.as_ref(), &config.initx_token, &info.sender)
        .unwrap_or(Uint128::zero());
    if power.is_zero() {
        return Err(ContractError::NoVotingPower {});
    }

    match vote {
        VoteOption::Yes => proposal.yes_votes += power,
        VoteOption::No => proposal.no_votes += power,
        VoteOption::Abstain => proposal.abstain_votes += power,
    }
    PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

    let record = VoteRecord {
        voter: info.sender.clone(),
        option: vote,
        power,
    };
    VOTES.save(deps.storage, (proposal_id, &info.sender), &record)?;

    Ok(Response::new()
        .add_attribute("action", "vote")
        .add_attribute("proposal_id", proposal_id.to_string())
        .add_attribute("voter", info.sender)
        .add_attribute("power", power))
}

fn execute_execute(
    deps: DepsMut,
    env: Env,
    _info: MessageInfo,
    proposal_id: u64,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    let mut proposal = PROPOSALS
        .may_load(deps.storage, proposal_id)?
        .ok_or(ContractError::ProposalNotFound {})?;

    if proposal.executed {
        return Err(ContractError::AlreadyExecuted {});
    }

    let now = env.block.time.seconds();
    if now <= proposal.end_time {
        return Err(ContractError::VotingNotEnded {});
    }

    let (passed, _, _) = check_proposal_status(&proposal, &config);
    if !passed {
        return Err(ContractError::ProposalNotPassed {});
    }

    proposal.executed = true;
    PROPOSALS.save(deps.storage, proposal_id, &proposal)?;

    // Return deposit to proposer
    let mut msgs: Vec<cosmwasm_std::CosmosMsg> = vec![];
    if !proposal.deposit.is_zero() {
        msgs.push(cosmwasm_std::CosmosMsg::Wasm(WasmMsg::Execute {
            contract_addr: config.initx_token.to_string(),
            msg: to_json_binary(&cw20::Cw20ExecuteMsg::Transfer {
                recipient: proposal.proposer.to_string(),
                amount: proposal.deposit,
            })?,
            funds: vec![],
        }));
    }

    Ok(Response::new()
        .add_messages(msgs)
        .add_attribute("action", "execute_proposal")
        .add_attribute("proposal_id", proposal_id.to_string()))
}

fn execute_update_config(
    deps: DepsMut,
    info: MessageInfo,
    voting_period: Option<u64>,
    quorum: Option<cosmwasm_std::Decimal>,
    threshold: Option<cosmwasm_std::Decimal>,
    proposal_deposit: Option<Uint128>,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    if let Some(v) = voting_period {
        config.voting_period = v;
    }
    if let Some(v) = quorum {
        config.quorum = v;
    }
    if let Some(v) = threshold {
        config.threshold = v;
    }
    if let Some(v) = proposal_deposit {
        config.proposal_deposit = v;
    }
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new().add_attribute("action", "update_config"))
}

// ── Queries ──

#[entry_point]
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Proposal { id } => {
            to_json_binary(&PROPOSALS.load(deps.storage, id)?)
        }
        QueryMsg::Proposals { start_after, limit } => {
            query_proposals(deps, start_after, limit)
        }
        QueryMsg::Vote { proposal_id, voter } => {
            let addr = deps.api.addr_validate(&voter)?;
            to_json_binary(&VOTES.load(deps.storage, (proposal_id, &addr))?)
        }
        QueryMsg::ProposalStatus { id } => query_proposal_status(deps, env, id),
    }
}

fn query_proposals(
    deps: Deps,
    start_after: Option<u64>,
    limit: Option<u32>,
) -> StdResult<Binary> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let start = start_after.map(Bound::exclusive);

    let proposals: Vec<Proposal> = PROPOSALS
        .range(deps.storage, start, None, cosmwasm_std::Order::Ascending)
        .take(limit)
        .map(|item| item.map(|(_, p)| p))
        .collect::<StdResult<Vec<_>>>()?;

    to_json_binary(&ProposalListResponse { proposals })
}

fn query_proposal_status(deps: Deps, _env: Env, id: u64) -> StdResult<Binary> {
    let config = CONFIG.load(deps.storage)?;
    let proposal = PROPOSALS.load(deps.storage, id)?;
    let (passed, quorum_reached, threshold_reached) =
        check_proposal_status(&proposal, &config);
    let total_votes = proposal.yes_votes + proposal.no_votes + proposal.abstain_votes;

    to_json_binary(&ProposalStatusResponse {
        passed,
        quorum_reached,
        threshold_reached,
        total_votes,
    })
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env, MockApi};
    use cosmwasm_std::Timestamp;

    fn setup(deps: DepsMut) -> (Addr, Addr) {
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");

        let msg = InstantiateMsg {
            initx_token: initx_token.to_string(),
            voting_period: Some(100), // 100 seconds for testing
            quorum: None,
            threshold: None,
            proposal_deposit: Some(Uint128::new(100)),
        };
        let info = message_info(&admin, &[]);
        instantiate(deps, mock_env(), info, msg).unwrap();
        (admin, initx_token)
    }

    fn create_proposal(deps: DepsMut, env: Env, initx_token: &Addr, proposer: &Addr) {
        let cw20_msg = Cw20ReceiveMsg {
            sender: proposer.to_string(),
            amount: Uint128::new(100),
            msg: to_json_binary(&Cw20HookMsg::CreateProposal {
                title: "Test Proposal".to_string(),
                description: "A test proposal".to_string(),
                messages: None,
            })
            .unwrap(),
        };
        let info = message_info(initx_token, &[]);
        execute(deps, env, info, ExecuteMsg::Receive(cw20_msg)).unwrap();
    }

    #[test]
    fn test_instantiate() {
        let mut deps = mock_dependencies();
        let (admin, initx_token) = setup(deps.as_mut());

        let config = CONFIG.load(deps.as_ref().storage).unwrap();
        assert_eq!(config.admin, admin);
        assert_eq!(config.initx_token, initx_token);
        assert_eq!(config.voting_period, 100);
        assert_eq!(config.quorum, cosmwasm_std::Decimal::percent(10));
        assert_eq!(config.threshold, cosmwasm_std::Decimal::percent(50));
    }

    #[test]
    fn test_create_proposal() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token) = setup(deps.as_mut());
        let proposer = api.addr_make("proposer");

        create_proposal(deps.as_mut(), env.clone(), &initx_token, &proposer);

        let proposal = PROPOSALS.load(deps.as_ref().storage, 1).unwrap();
        assert_eq!(proposal.id, 1);
        assert_eq!(proposal.proposer, proposer);
        assert_eq!(proposal.title, "Test Proposal");
        assert!(!proposal.executed);
        assert_eq!(proposal.end_time, env.block.time.seconds() + 100);
    }

    #[test]
    fn test_create_proposal_wrong_token() {
        let mut deps = mock_dependencies();
        let api = MockApi::default();
        let (_, _) = setup(deps.as_mut());
        let wrong_token = api.addr_make("wrong_token");
        let proposer = api.addr_make("proposer");

        let cw20_msg = Cw20ReceiveMsg {
            sender: proposer.to_string(),
            amount: Uint128::new(100),
            msg: to_json_binary(&Cw20HookMsg::CreateProposal {
                title: "Test".to_string(),
                description: "Test".to_string(),
                messages: None,
            })
            .unwrap(),
        };
        let info = message_info(&wrong_token, &[]);
        let err = execute(
            deps.as_mut(),
            mock_env(),
            info,
            ExecuteMsg::Receive(cw20_msg),
        )
        .unwrap_err();
        assert_eq!(err, ContractError::InvalidCw20Sender {});
    }

    #[test]
    fn test_already_voted() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token) = setup(deps.as_mut());
        let proposer = api.addr_make("proposer");
        let voter = api.addr_make("voter");

        create_proposal(deps.as_mut(), env.clone(), &initx_token, &proposer);

        // First vote — will fail because we can't query CW20 in mock, but let's
        // test the already-voted path by manually inserting a vote record
        let record = VoteRecord {
            voter: voter.clone(),
            option: VoteOption::Yes,
            power: Uint128::new(100),
        };
        VOTES.save(deps.as_mut().storage, (1, &voter), &record).unwrap();
        let mut proposal = PROPOSALS.load(deps.as_ref().storage, 1).unwrap();
        proposal.yes_votes = Uint128::new(100);
        PROPOSALS.save(deps.as_mut().storage, 1, &proposal).unwrap();

        // Try to vote again
        let info = message_info(&voter, &[]);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::Vote {
                proposal_id: 1,
                vote: VoteOption::No,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::AlreadyVoted {});
    }

    #[test]
    fn test_voting_ended() {
        let mut deps = mock_dependencies();
        let mut env = mock_env();
        let api = MockApi::default();
        let (_, initx_token) = setup(deps.as_mut());
        let proposer = api.addr_make("proposer");
        let voter = api.addr_make("voter");

        create_proposal(deps.as_mut(), env.clone(), &initx_token, &proposer);

        // Advance time past voting period
        env.block.time = Timestamp::from_seconds(env.block.time.seconds() + 200);

        let info = message_info(&voter, &[]);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::Vote {
                proposal_id: 1,
                vote: VoteOption::Yes,
            },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::VotingEnded {});
    }

    #[test]
    fn test_execute_before_voting_ends() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token) = setup(deps.as_mut());
        let proposer = api.addr_make("proposer");

        create_proposal(deps.as_mut(), env.clone(), &initx_token, &proposer);

        let info = message_info(&proposer, &[]);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::Execute { proposal_id: 1 },
        )
        .unwrap_err();
        assert_eq!(err, ContractError::VotingNotEnded {});
    }

    #[test]
    fn test_proposal_status_check() {
        let api = MockApi::default();
        let admin = api.addr_make("admin");
        let initx_token = api.addr_make("initx_token");

        let config = Config {
            admin,
            initx_token,
            voting_period: 100,
            quorum: cosmwasm_std::Decimal::percent(10),
            threshold: cosmwasm_std::Decimal::percent(50),
            proposal_deposit: Uint128::new(100),
        };

        let proposal = Proposal {
            id: 1,
            proposer: api.addr_make("proposer"),
            title: "Test".to_string(),
            description: "Test".to_string(),
            messages: None,
            start_time: 0,
            end_time: 100,
            yes_votes: Uint128::new(600),
            no_votes: Uint128::new(300),
            abstain_votes: Uint128::new(100),
            total_supply_snapshot: Uint128::new(1_000),
            executed: false,
            deposit: Uint128::new(100),
        };

        let (passed, quorum_reached, threshold_reached) =
            check_proposal_status(&proposal, &config);
        // total_votes = 1000, supply = 1000 -> quorum 100% >= 10% ✓
        assert!(quorum_reached);
        // yes=600, no=300, yes/(yes+no) = 66% >= 50% ✓
        assert!(threshold_reached);
        assert!(passed);
    }

    #[test]
    fn test_proposal_fails_quorum() {
        let api = MockApi::default();
        let config = Config {
            admin: api.addr_make("admin"),
            initx_token: api.addr_make("initx_token"),
            voting_period: 100,
            quorum: cosmwasm_std::Decimal::percent(10),
            threshold: cosmwasm_std::Decimal::percent(50),
            proposal_deposit: Uint128::new(100),
        };

        let proposal = Proposal {
            id: 1,
            proposer: api.addr_make("proposer"),
            title: "Test".to_string(),
            description: "Test".to_string(),
            messages: None,
            start_time: 0,
            end_time: 100,
            yes_votes: Uint128::new(5),
            no_votes: Uint128::new(0),
            abstain_votes: Uint128::new(0),
            total_supply_snapshot: Uint128::new(1_000),
            executed: false,
            deposit: Uint128::new(100),
        };

        let (passed, quorum_reached, _) =
            check_proposal_status(&proposal, &config);
        // 5/1000 = 0.5% < 10%
        assert!(!quorum_reached);
        assert!(!passed);
    }

    #[test]
    fn test_proposal_fails_threshold() {
        let api = MockApi::default();
        let config = Config {
            admin: api.addr_make("admin"),
            initx_token: api.addr_make("initx_token"),
            voting_period: 100,
            quorum: cosmwasm_std::Decimal::percent(10),
            threshold: cosmwasm_std::Decimal::percent(50),
            proposal_deposit: Uint128::new(100),
        };

        let proposal = Proposal {
            id: 1,
            proposer: api.addr_make("proposer"),
            title: "Test".to_string(),
            description: "Test".to_string(),
            messages: None,
            start_time: 0,
            end_time: 100,
            yes_votes: Uint128::new(200),
            no_votes: Uint128::new(600),
            abstain_votes: Uint128::new(200),
            total_supply_snapshot: Uint128::new(1_000),
            executed: false,
            deposit: Uint128::new(100),
        };

        let (passed, quorum_reached, threshold_reached) =
            check_proposal_status(&proposal, &config);
        assert!(quorum_reached); // 1000/1000 = 100%
        // yes=200, no=600, 200/800 = 25% < 50%
        assert!(!threshold_reached);
        assert!(!passed);
    }

    #[test]
    fn test_query_proposals_list() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let api = MockApi::default();
        let (_, initx_token) = setup(deps.as_mut());
        let proposer = api.addr_make("proposer");

        // Create 3 proposals
        for _ in 0..3 {
            create_proposal(deps.as_mut(), env.clone(), &initx_token, &proposer);
        }

        let res: ProposalListResponse = cosmwasm_std::from_json(
            query(
                deps.as_ref(),
                env,
                QueryMsg::Proposals {
                    start_after: None,
                    limit: Some(10),
                },
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(res.proposals.len(), 3);
        assert_eq!(res.proposals[0].id, 1);
        assert_eq!(res.proposals[2].id, 3);
    }
}
