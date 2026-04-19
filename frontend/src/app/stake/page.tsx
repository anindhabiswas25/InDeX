"use client";

import { useState, useEffect, useCallback } from "react";
import TokenInput from "@/components/TokenInput";
import StatsCard from "@/components/StatsCard";
import { useContracts } from "@/hooks/useContracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
const toMicro = (human: string) => (parseFloat(human) * 1e6).toFixed(0);

export default function StakePage() {
  const { address, staking, getInitBalance, getInitxBalance } = useContracts();
  const [tab, setTab] = useState<"stake" | "withdraw">("stake");
  const [amount, setAmount] = useState("");
  const [exchangeRate, setExchangeRate] = useState<string>("...");
  const [initBal, setInitBal] = useState<string>("...");
  const [initxBal, setInitxBal] = useState<string>("...");
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    staking.getExchangeRate().then((r: any) => {
      setExchangeRate(r.rate || r.exchange_rate || String(r));
    }).catch(() => {});
    if (address) {
      getInitBalance(address).then(setInitBal).catch(() => {});
      getInitxBalance(address).then(setInitxBal).catch(() => {});
      staking.getWithdrawals(address).then((r: any) => setWithdrawals(r.withdrawals || r || [])).catch(() => {});
    }
  }, [address, staking, getInitBalance, getInitxBalance]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const rawRate = parseFloat(exchangeRate) || 1000000;
  const rateNum = rawRate >= 100 ? rawRate / 1e6 : parseFloat(exchangeRate) || 1;
  const rateDisplay = rateNum.toFixed(4);

  const handleStake = async () => {
    if (!amount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await staking.deposit(toMicro(amount));
      setTxHash(res?.transactionHash || "success");
      setAmount(""); fetchData();
    } catch (e: any) { setError(e.message || "Transaction failed"); }
    setLoading(false);
  };

  const handleRequestWithdrawal = async () => {
    if (!amount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await staking.requestWithdrawal(toMicro(amount));
      setTxHash(res?.transactionHash || "success");
      setAmount(""); fetchData();
    } catch (e: any) { setError(e.message || "Transaction failed"); }
    setLoading(false);
  };

  const handleClaim = async (id: number) => {
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await staking.claimWithdrawal(id);
      setTxHash(res?.transactionHash || "success"); fetchData();
    } catch (e: any) { setError(e.message || "Claim failed"); }
    setLoading(false);
  };

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-4 animate-reveal">
      <h1 className="text-xl font-bold text-white">Stake INIT</h1>
      <p className="text-[13px] text-[#71717A]">Stake INIT to receive INITx and earn real yield.</p>

      <div className="grid grid-cols-3 gap-2">
        <StatsCard label="Rate" value={exchangeRate === "..." ? "..." : rateDisplay} />
        <StatsCard label="INIT" value={initBal === "..." ? "..." : fmt(initBal)} />
        <StatsCard label="INITx" value={initxBal === "..." ? "..." : fmt(initxBal)} />
      </div>

      {txHash && <div className="alert-success text-xs">Success: <span className="font-mono text-[11px]">{txHash.slice(0, 16)}...</span></div>}
      {error && <div className="alert-error text-xs">{error}</div>}

      <div className="tab-group">
        {(["stake", "withdraw"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setAmount(""); setTxHash(null); setError(null); }} className={`tab-item ${tab === t ? "active" : ""}`}>
            {t === "stake" ? "Stake" : "Withdraw"}
          </button>
        ))}
      </div>

      {tab === "stake" ? (
        <div className="space-y-3">
          <TokenInput label="You stake" token="INIT" value={amount} onChange={setAmount} balance={initBal === "..." ? undefined : fmt(initBal)} />
          <TokenInput label="You receive" token="INITx" value={amount ? (parseFloat(amount) / rateNum).toFixed(4) : ""} onChange={() => {}} disabled />
          <button onClick={handleStake} disabled={loading || !amount || !address} className="w-full py-2.5 btn-primary">
            {loading ? "Processing..." : "Stake INIT"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <TokenInput label="You unstake" token="INITx" value={amount} onChange={setAmount} balance={initxBal === "..." ? undefined : fmt(initxBal)} />
          <TokenInput label="You receive" token="INIT" value={amount ? (parseFloat(amount) * rateNum).toFixed(4) : ""} onChange={() => {}} disabled />
          <button onClick={handleRequestWithdrawal} disabled={loading || !amount || !address} className="w-full py-2.5 btn-primary">
            {loading ? "Processing..." : "Request Withdrawal"}
          </button>

          <div className="glass-card p-3">
            <p className="stat-label mb-2">Pending Withdrawals</p>
            {withdrawals.length === 0 ? (
              <p className="text-xs text-[#71717A]">None</p>
            ) : (
              <div className="space-y-1.5">
                {withdrawals.map((w: any) => (
                  <div key={w.id} className="flex items-center justify-between text-xs">
                    <span className="text-[#A1A1AA] font-mono">#{w.id} — {fmt(w.amount || w.init_amount || "0")} INIT</span>
                    <button onClick={() => handleClaim(w.id)} disabled={loading} className="text-white text-[11px] hover:opacity-70 disabled:opacity-30">Claim</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* How It Works */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Staking Works</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          Stake INIT to get INITx — a yield-bearing token. The keeper harvests protocol fees every 10 min, growing the exchange rate. Your INITx stays the same but its INIT value increases over time.
        </p>
      </div>
    </div>
  );
}
