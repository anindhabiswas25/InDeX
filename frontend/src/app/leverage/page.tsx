"use client";

import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

interface LoopDetail {
  loop: number;
  deposited: number;
  borrowed: number;
  cumulativeStaked: number;
  cumulativeBorrowed: number;
}

interface SimResult {
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

interface OptimalResult {
  optimalLoops: number;
  netYieldPct: number;
  leverageMultiplier: number;
  annualReturn: number;
  totalStaked: number;
  totalBorrowed: number;
}

export default function LeveragePage() {
  const [principal, setPrincipal] = useState("1000");
  const [loops, setLoops] = useState("5");
  const [collateralFactor, setCollateralFactor] = useState("70");
  const [stakingAPR, setStakingAPR] = useState("6");
  const [borrowAPR, setBorrowAPR] = useState("4");

  const [result, setResult] = useState<SimResult | null>(null);
  const [optimal, setOptimal] = useState<OptimalResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSimulate = async () => {
    setLoading(true); setError(null); setOptimal(null);
    try {
      const res = await fetch(`${API_URL}/api/leverage/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principal: parseFloat(principal),
          loops: parseInt(loops),
          collateralFactor: parseFloat(collateralFactor) / 100,
          stakingAPR: parseFloat(stakingAPR) / 100,
          borrowAPR: parseFloat(borrowAPR) / 100,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Simulation failed");
      }
      setResult(await res.json());
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  const handleOptimal = async () => {
    setLoading(true); setError(null);
    try {
      const cf = parseFloat(collateralFactor) / 100;
      const sa = parseFloat(stakingAPR) / 100;
      const ba = parseFloat(borrowAPR) / 100;
      const res = await fetch(`${API_URL}/api/leverage/optimal?stakingAPR=${sa}&borrowAPR=${ba}&collateralFactor=${cf}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Optimal calculation failed");
      }
      const data: OptimalResult = await res.json();
      setOptimal(data);
      // Also run simulate with the optimal loops
      setLoops(String(data.optimalLoops));
      const simRes = await fetch(`${API_URL}/api/leverage/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principal: parseFloat(principal),
          loops: data.optimalLoops,
          collateralFactor: cf,
          stakingAPR: sa,
          borrowAPR: ba,
        }),
      });
      if (simRes.ok) setResult(await simRes.json());
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6 animate-reveal">
      <div>
        <h1 className="text-xl font-bold text-white">Leverage Simulator</h1>
        <p className="text-[13px] text-[#71717A] mt-1">Simulate recursive collateral looping to calculate effective leverage and projected yield.</p>
      </div>

      {error && <div className="alert-error text-xs">{error}</div>}

      {/* Optimal Strategy Banner */}
      {optimal && (
        <div className="glass-card-premium p-4 animate-fade">
          <div className="flex items-center gap-2 mb-3">
            <span className="badge-success">Optimal Strategy</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <p className="text-[11px] text-[#71717A] uppercase tracking-wider">Optimal Loops</p>
              <p className="text-lg font-bold text-white font-mono">{optimal.optimalLoops}</p>
            </div>
            <div>
              <p className="text-[11px] text-[#71717A] uppercase tracking-wider">Net Yield</p>
              <p className="text-lg font-bold text-[#22c55e] font-mono">{optimal.netYieldPct.toFixed(2)}%</p>
            </div>
            <div>
              <p className="text-[11px] text-[#71717A] uppercase tracking-wider">Leverage</p>
              <p className="text-lg font-bold text-white font-mono">{optimal.leverageMultiplier.toFixed(2)}x</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Input Parameters */}
        <div className="glass-card p-5 space-y-4">
          <p className="text-[13px] font-semibold text-white">Parameters</p>

          {[
            { label: "Principal (INIT)", value: principal, setter: setPrincipal, placeholder: "1000" },
            { label: "Number of Loops", value: loops, setter: setLoops, placeholder: "5" },
            { label: "Collateral Factor (%)", value: collateralFactor, setter: setCollateralFactor, placeholder: "70" },
            { label: "Staking APR (%)", value: stakingAPR, setter: setStakingAPR, placeholder: "6" },
            { label: "Borrow APR (%)", value: borrowAPR, setter: setBorrowAPR, placeholder: "4" },
          ].map(({ label, value, setter, placeholder }) => (
            <div key={label}>
              <label className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider block mb-1.5">{label}</label>
              <input
                type="number"
                value={value}
                onChange={(e) => setter(e.target.value)}
                placeholder={placeholder}
                className="input-dark w-full px-3 py-2.5 text-sm font-mono"
              />
            </div>
          ))}

          <div className="flex gap-2 pt-1">
            <button onClick={handleSimulate} disabled={loading} className="flex-1 btn-primary py-2.5 text-sm">
              {loading ? "Calculating..." : "Simulate"}
            </button>
            <button onClick={handleOptimal} disabled={loading} className="flex-1 btn-secondary py-2.5 text-sm">
              Find Optimal
            </button>
          </div>
        </div>

        {/* Right: Results */}
        <div className="space-y-4">
          <div className="glass-card-premium p-5">
            <p className="text-[13px] font-semibold text-white mb-4">Results</p>
            {result ? (
              <div className="space-y-3">
                {[
                  ["Effective Leverage", `${result.effectiveLeverage.toFixed(2)}x`, "white"],
                  ["Net Yield", `${result.netYieldPct.toFixed(2)}%`, result.netYieldPct >= 0 ? "#22c55e" : "#ef4444"],
                  ["Annual Return", `${result.annualReturn.toFixed(2)} INIT`, result.annualReturn >= 0 ? "#22c55e" : "#ef4444"],
                  ["Total Staked", `${result.totalStaked.toFixed(2)} INIT`, "white"],
                  ["Total Borrowed", `${result.totalBorrowed.toFixed(2)} INIT`, "#eab308"],
                  ["Net Position", `${result.netPosition.toFixed(2)} INIT`, "white"],
                  ["Gross Yield", `${result.grossYield.toFixed(2)} INIT`, "#A1A1AA"],
                  ["Borrow Cost", `${result.borrowCost.toFixed(2)} INIT`, "#A1A1AA"],
                  ["Max Leverage", `${result.maxLeverage.toFixed(2)}x`, "#71717A"],
                ].map(([label, val, color]) => (
                  <div key={label} className="flex justify-between items-center">
                    <span className="text-[13px] text-[#71717A]">{label}</span>
                    <span className="text-[13px] font-semibold font-mono" style={{ color: color as string }}>{val}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-[#52525B] text-center py-8">Run a simulation to see results</p>
            )}
          </div>

          {/* Per-loop breakdown */}
          {result && result.loops.length > 0 && (
            <div className="glass-card p-4">
              <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Loop Breakdown</p>
              <div className="space-y-1.5">
                <div className="grid grid-cols-4 gap-2 text-[10px] text-[#52525B] uppercase tracking-wider pb-1 border-b border-white/5">
                  <span>Loop</span><span>Deposited</span><span>Borrowed</span><span>Cumulative</span>
                </div>
                {result.loops.map((l) => (
                  <div key={l.loop} className="grid grid-cols-4 gap-2 text-[11px] font-mono">
                    <span className="text-[#71717A]">#{l.loop}</span>
                    <span className="text-white">{l.deposited.toFixed(1)}</span>
                    <span className="text-[#eab308]">{l.borrowed.toFixed(1)}</span>
                    <span className="text-[#A1A1AA]">{l.cumulativeStaked.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* How Leverage Works */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Leverage Works</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          Simulates recursive collateral looping: deposit → borrow → re-stake repeatedly. Each loop amplifies your position but with diminishing returns. Net yield = staking gains minus borrow costs. Use "Find Optimal" to calculate the best loop count.
        </p>
      </div>
    </div>
  );
}
