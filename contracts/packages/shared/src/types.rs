use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};

/// Exchange rate with 6 decimal precision
#[cw_serde]
pub struct ExchangeRate {
    /// Rate scaled by 1_000_000 (1.0 = 1_000_000)
    pub rate: Uint128,
}

impl ExchangeRate {
    pub const PRECISION: u128 = 1_000_000;

    pub fn one() -> Self {
        ExchangeRate {
            rate: Uint128::new(Self::PRECISION),
        }
    }

    /// Convert INIT to INITx: initx = init_amount * precision / rate
    pub fn init_to_initx(&self, init_amount: Uint128) -> Uint128 {
        init_amount
            .checked_mul(Uint128::new(Self::PRECISION))
            .unwrap()
            .checked_div(self.rate)
            .unwrap()
    }

    /// Convert INITx to INIT: init = initx_amount * rate / precision
    pub fn initx_to_init(&self, initx_amount: Uint128) -> Uint128 {
        initx_amount
            .checked_mul(self.rate)
            .unwrap()
            .checked_div(Uint128::new(Self::PRECISION))
            .unwrap()
    }
}

/// Withdrawal request stored in queue
#[cw_serde]
pub struct WithdrawalRequest {
    pub user: Addr,
    pub init_amount: Uint128,
    pub ready_at: u64, // seconds timestamp
}
