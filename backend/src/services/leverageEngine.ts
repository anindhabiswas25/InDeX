/**
 * LeverageEngine — Simulates recursive collateral looping strategy.
 *
 * Strategy: deposit INITx collateral → borrow INIT → stake INIT for INITx
 *           → deposit again → repeat N loops.
 *
 * This is a pure math simulation — no on-chain transactions are executed.
 */

export interface SimulateInput {
  principal: number;       // Initial INIT amount
  loops: number;           // Number of recursive loops (1-20)
  collateralFactor: number; // e.g. 0.7 means 70% LTV
  stakingAPR: number;      // Annual staking yield as decimal (e.g. 0.06 = 6%)
  borrowAPR: number;       // Annual borrow cost as decimal (e.g. 0.04 = 4%)
}

export interface LoopDetail {
  loop: number;
  deposited: number;
  borrowed: number;
  cumulativeStaked: number;
  cumulativeBorrowed: number;
}

export interface SimulateResult {
  effectiveLeverage: number;
  netYieldPct: number;
  totalStaked: number;
  totalBorrowed: number;
  netPosition: number;
  annualReturn: number;
  grossYield: number;
  borrowCost: number;
  maxLeverage: number;
  loops: LoopDetail[];
}

export interface OptimalResult {
  optimalLoops: number;
  netYieldPct: number;
  leverageMultiplier: number;
  annualReturn: number;
  totalStaked: number;
  totalBorrowed: number;
}

export class LeverageEngine {
  /**
   * Simulate N loops of recursive collateral looping.
   *
   * Each loop:
   *   1. Deposit current INIT as collateral (stake → get INITx)
   *   2. Borrow: deposited * collateralFactor
   *   3. The borrowed INIT becomes the next loop's deposit
   */
  simulate(input: SimulateInput): SimulateResult {
    const { principal, loops, collateralFactor, stakingAPR, borrowAPR } = input;

    if (loops < 1 || loops > 20) throw new Error("Loops must be between 1 and 20");
    if (collateralFactor <= 0 || collateralFactor >= 1) throw new Error("Collateral factor must be between 0 and 1");
    if (principal <= 0) throw new Error("Principal must be positive");

    const maxLeverage = 1 / (1 - collateralFactor);
    const loopDetails: LoopDetail[] = [];

    let totalStaked = 0;
    let totalBorrowed = 0;
    let currentAmount = principal;

    for (let i = 1; i <= loops; i++) {
      // Deposit (stake) the current amount
      totalStaked += currentAmount;
      const borrowed = currentAmount * collateralFactor;
      totalBorrowed += borrowed;

      loopDetails.push({
        loop: i,
        deposited: parseFloat(currentAmount.toFixed(4)),
        borrowed: parseFloat(borrowed.toFixed(4)),
        cumulativeStaked: parseFloat(totalStaked.toFixed(4)),
        cumulativeBorrowed: parseFloat(totalBorrowed.toFixed(4)),
      });

      // The borrowed amount becomes next loop's deposit
      currentAmount = borrowed;
    }

    const effectiveLeverage = totalStaked / principal;
    const grossYield = totalStaked * stakingAPR;
    const borrowCost = totalBorrowed * borrowAPR;
    const annualReturn = grossYield - borrowCost;
    const netYieldPct = (annualReturn / principal) * 100;
    const netPosition = totalStaked - totalBorrowed;

    return {
      effectiveLeverage: parseFloat(effectiveLeverage.toFixed(4)),
      netYieldPct: parseFloat(netYieldPct.toFixed(4)),
      totalStaked: parseFloat(totalStaked.toFixed(4)),
      totalBorrowed: parseFloat(totalBorrowed.toFixed(4)),
      netPosition: parseFloat(netPosition.toFixed(4)),
      annualReturn: parseFloat(annualReturn.toFixed(4)),
      grossYield: parseFloat(grossYield.toFixed(4)),
      borrowCost: parseFloat(borrowCost.toFixed(4)),
      maxLeverage: parseFloat(maxLeverage.toFixed(4)),
      loops: loopDetails,
    };
  }

  /**
   * Find the optimal number of loops where marginal yield improvement
   * drops below a meaningful threshold (0.1% of principal = 1 INIT per 1000).
   */
  optimal(stakingAPR: number, borrowAPR: number, collateralFactor: number): OptimalResult {
    const testPrincipal = 1000;
    const threshold = testPrincipal * 0.001; // 1 INIT for 1000 principal

    let bestLoops = 1;
    let prevReturn = 0;

    for (let loops = 1; loops <= 20; loops++) {
      const result = this.simulate({
        principal: testPrincipal,
        loops,
        collateralFactor,
        stakingAPR,
        borrowAPR,
      });

      const marginalGain = result.annualReturn - prevReturn;

      if (loops > 1 && marginalGain < threshold) {
        break;
      }

      bestLoops = loops;
      prevReturn = result.annualReturn;
    }

    const finalResult = this.simulate({
      principal: testPrincipal,
      loops: bestLoops,
      collateralFactor,
      stakingAPR,
      borrowAPR,
    });

    return {
      optimalLoops: bestLoops,
      netYieldPct: finalResult.netYieldPct,
      leverageMultiplier: finalResult.effectiveLeverage,
      annualReturn: finalResult.annualReturn,
      totalStaked: finalResult.totalStaked,
      totalBorrowed: finalResult.totalBorrowed,
    };
  }
}
