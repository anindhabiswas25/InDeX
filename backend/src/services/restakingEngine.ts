/**
 * Restaking Engine — Position tracker + step-by-step leverage simulation.
 * Queries live on-chain positions and calculates effective leverage, health factor, net APR.
 */
import { config } from "../config";
import { queryContract } from "../chain";
import { borrowers as borrowersCollection } from "../mongo";
import { getExchangeRate } from "./oracleUpdater";

function log(msg: string) { console.log(`[restaking] ${msg}`); }

interface PositionResponse {
  collateral: string;
  debt: string;
  max_borrow: string;
  health_factor: string;
}

export interface RestakingStep {
  step: number;
  action: string; // "stake" | "deposit_collateral" | "borrow"
  amount: number;
  cumulativeStaked: number;
  cumulativeBorrowed: number;
  healthFactor: number;
}

export interface RestakingSimulation {
  principal: number;
  loops: number;
  steps: RestakingStep[];
  totalStaked: number;
  totalBorrowed: number;
  effectiveLeverage: number;
  netApr: number;
  finalHealthFactor: number;
}

export interface RestakingPosition {
  address: string;
  collateral: string;
  debt: string;
  healthFactor: number;
  effectiveLeverage: number;
  netApr: number;
  liquidationPrice: number;
  exchangeRate: number;
}

const COLLATERAL_FACTOR = 0.7;
const LIQUIDATION_THRESHOLD = 0.8;
const STAKING_APR = 0.06; // estimated
const BORROW_APR = 0.05;

/**
 * Simulate a restaking loop with step-by-step detail and health factor at each step.
 */
export function simulateRestaking(principal: number, loops: number): RestakingSimulation {
  if (loops < 1 || loops > 20) throw new Error("Loops must be 1-20");
  if (principal <= 0) throw new Error("Principal must be positive");

  const steps: RestakingStep[] = [];
  let totalStaked = 0;
  let totalBorrowed = 0;
  let currentAmount = principal;
  let stepNum = 0;

  for (let i = 0; i < loops; i++) {
    // Step 1: Stake INIT → get INITx
    stepNum++;
    totalStaked += currentAmount;
    steps.push({
      step: stepNum,
      action: "stake",
      amount: parseFloat(currentAmount.toFixed(4)),
      cumulativeStaked: parseFloat(totalStaked.toFixed(4)),
      cumulativeBorrowed: parseFloat(totalBorrowed.toFixed(4)),
      healthFactor: totalBorrowed > 0 ? (totalStaked * LIQUIDATION_THRESHOLD) / totalBorrowed : Infinity,
    });

    // Step 2: Deposit INITx as collateral (implicit — same as staked amount at 1:1)
    stepNum++;
    steps.push({
      step: stepNum,
      action: "deposit_collateral",
      amount: parseFloat(currentAmount.toFixed(4)),
      cumulativeStaked: parseFloat(totalStaked.toFixed(4)),
      cumulativeBorrowed: parseFloat(totalBorrowed.toFixed(4)),
      healthFactor: totalBorrowed > 0 ? (totalStaked * LIQUIDATION_THRESHOLD) / totalBorrowed : Infinity,
    });

    // Step 3: Borrow INIT
    const borrowed = currentAmount * COLLATERAL_FACTOR;
    totalBorrowed += borrowed;
    stepNum++;
    steps.push({
      step: stepNum,
      action: "borrow",
      amount: parseFloat(borrowed.toFixed(4)),
      cumulativeStaked: parseFloat(totalStaked.toFixed(4)),
      cumulativeBorrowed: parseFloat(totalBorrowed.toFixed(4)),
      healthFactor: (totalStaked * LIQUIDATION_THRESHOLD) / totalBorrowed,
    });

    currentAmount = borrowed;
  }

  const effectiveLeverage = totalStaked / principal;
  const grossYield = totalStaked * STAKING_APR;
  const borrowCost = totalBorrowed * BORROW_APR;
  const netApr = ((grossYield - borrowCost) / principal) * 100;
  const finalHealthFactor = totalBorrowed > 0 ? (totalStaked * LIQUIDATION_THRESHOLD) / totalBorrowed : Infinity;

  return {
    principal,
    loops,
    steps,
    totalStaked: parseFloat(totalStaked.toFixed(4)),
    totalBorrowed: parseFloat(totalBorrowed.toFixed(4)),
    effectiveLeverage: parseFloat(effectiveLeverage.toFixed(4)),
    netApr: parseFloat(netApr.toFixed(4)),
    finalHealthFactor: parseFloat(finalHealthFactor.toFixed(4)),
  };
}

/**
 * Get a user's actual on-chain restaking position.
 */
export async function getPosition(address: string): Promise<RestakingPosition | null> {
  try {
    const [pos, exchangeRate] = await Promise.all([
      queryContract<PositionResponse>(config.lendingAddress, { position: { address } }),
      getExchangeRate(),
    ]);

    const collateral = Number(pos.collateral);
    const debt = Number(pos.debt);
    const healthFactor = Number(pos.health_factor) / 1e18;

    if (collateral === 0 && debt === 0) return null;

    // Effective leverage = collateral_value / (collateral_value - debt)
    const collateralValue = collateral * exchangeRate;
    const netValue = collateralValue - debt;
    const effectiveLeverage = netValue > 0 ? collateralValue / netValue : Infinity;

    // Net APR
    const grossYield = collateralValue * STAKING_APR;
    const borrowCost = debt * BORROW_APR;
    const netApr = netValue > 0 ? ((grossYield - borrowCost) / netValue) * 100 : 0;

    // Liquidation price (exchange rate at which HF = 1)
    // HF = (collateral * price * LT) / debt = 1 → price = debt / (collateral * LT)
    const liquidationPrice = collateral > 0 && debt > 0
      ? debt / (collateral * LIQUIDATION_THRESHOLD)
      : 0;

    return {
      address,
      collateral: pos.collateral,
      debt: pos.debt,
      healthFactor,
      effectiveLeverage: parseFloat(effectiveLeverage.toFixed(4)),
      netApr: parseFloat(netApr.toFixed(4)),
      liquidationPrice: parseFloat(liquidationPrice.toFixed(6)),
      exchangeRate,
    };
  } catch (err: any) {
    log(`No position for ${address}: ${err.message}`);
    return null;
  }
}
