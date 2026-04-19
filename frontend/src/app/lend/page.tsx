"use client";

import { useState, useEffect, useCallback } from "react";
import TokenInput from "@/components/TokenInput";
import StatsCard from "@/components/StatsCard";
import { useContracts } from "@/hooks/useContracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
const toMicro = (human: string) => (parseFloat(human) * 1e6).toFixed(0);

export default function LendPage() {
  const { address, lending, getInitBalance, getInitxBalance } = useContracts();
  const [tab, setTab] = useState<"deposit" | "borrow" | "repay">("deposit");
  const [amount, setAmount] = useState("");
  const [collateral, setCollateral] = useState("0");
  const [borrowed, setBorrowed] = useState("0");
  const [healthFactor, setHealthFactor] = useState<string>("—");
  const [initBal, setInitBal] = useState<string | null>(null);
  const [initxBal, setInitxBal] = useState<string | null>(null);
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    lending.getConfig().then((r: any) => setConfig(r)).catch(() => {});
    if (address) {
      getInitBalance(address).then(setInitBal).catch(() => {});
      getInitxBalance(address).then(setInitxBal).catch(() => {});
      lending.getPosition(address).then((r: any) => {
        setCollateral(r.collateral || r.collateral_amount || "0");
        setBorrowed(r.debt || r.borrowed || r.debt_amount || "0");
      }).catch(() => {});
      lending.getHealthFactor(address).then((r: any) => {
        setHealthFactor(r.health_factor || r.factor || String(r));
      }).catch(() => setHealthFactor("—"));
    }
  }, [address, lending, getInitBalance, getInitxBalance]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleExecute = async () => {
    if (!amount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const micro = toMicro(amount);
      let res: any;
      if (tab === "deposit") res = await lending.depositCollateral(micro);
      else if (tab === "borrow") res = await lending.borrow(micro);
      else res = await lending.repay(micro);
      setTxHash(res?.transactionHash || "success");
      setAmount(""); fetchData();
    } catch (e: any) { setError(e.message || "Transaction failed"); }
    setLoading(false);
  };

  const maxLtv = config?.max_ltv || config?.max_loan_to_value || "...";
  const liqThreshold = config?.liquidation_threshold || "...";

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-4 animate-reveal">
      <h1 className="text-xl font-bold text-white">Lend & Borrow</h1>
      <p className="text-[13px] text-[#71717A]">Deposit INITx as collateral and borrow INIT.</p>

      {txHash && <div className="alert-success text-xs">Success: <span className="font-mono text-[11px]">{txHash.slice(0, 16)}...</span></div>}
      {error && <div className="alert-error text-xs">{error}</div>}

      <div className="grid grid-cols-3 gap-2">
        <StatsCard label="Collateral" value={fmt(collateral)} sub="INITx" />
        <StatsCard label="Borrowed" value={fmt(borrowed)} sub="INIT" />
        <StatsCard label="Health" value={healthFactor} />
      </div>

      <div className="glass-card p-3 text-xs space-y-1.5">
        {[
          ["Max LTV", maxLtv],
          ["Liq. Threshold", liqThreshold],
        ].map(([label, val]) => (
          <div key={label} className="flex justify-between">
            <span className="text-[#71717A]">{label}</span>
            <span className="text-white font-mono text-[11px]">{val}</span>
          </div>
        ))}
      </div>

      <div className="tab-group">
        {(["deposit", "borrow", "repay"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setAmount(""); setTxHash(null); setError(null); }} className={`tab-item capitalize ${tab === t ? "active" : ""}`}>
            {t}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <TokenInput
          label={tab === "deposit" ? "Deposit INITx" : tab === "borrow" ? "Borrow INIT" : "Repay INIT"}
          token={tab === "deposit" ? "INITx" : "INIT"}
          value={amount}
          onChange={setAmount}
          balance={tab === "deposit" ? (initxBal ? fmt(initxBal) : undefined) : (initBal ? fmt(initBal) : undefined)}
        />
        <button onClick={handleExecute} disabled={loading || !amount || !address} className="w-full py-2.5 btn-primary capitalize">
          {loading ? "Processing..." : tab}
        </button>
      </div>

      {/* ── How It Works ── */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Lending Works</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          Deposit INITx as collateral to borrow INIT. 10% of borrower interest becomes protocol revenue, harvested by the keeper to grow the exchange rate. Health factor below 1.0 means liquidation risk.
        </p>
      </div>
    </div>
  );
}
