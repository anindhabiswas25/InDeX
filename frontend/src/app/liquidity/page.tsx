"use client";

import { useState, useEffect, useCallback } from "react";
import TokenInput from "@/components/TokenInput";
import { useContracts } from "@/hooks/useContracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
const toMicro = (human: string) => (parseFloat(human) * 1e6).toFixed(0);

export default function LiquidityPage() {
  const { address, liquidity, getInitBalance, getInitxBalance } = useContracts();
  const [tab, setTab] = useState<"add" | "remove">("add");
  const [initAmount, setInitAmount] = useState("");
  const [initxAmount, setInitxAmount] = useState("");
  const [lpAmount, setLpAmount] = useState("");
  const [initBal, setInitBal] = useState<string | null>(null);
  const [initxBal, setInitxBal] = useState<string | null>(null);
  const [lpBal, setLpBal] = useState("0");
  const [totalLpShares, setTotalLpShares] = useState("0");
  const [poolInit, setPoolInit] = useState("0");
  const [poolInitx, setPoolInitx] = useState("0");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    liquidity.getPool().then((r: any) => {
      setPoolInit(r.init_reserve || r.native_reserve || "0");
      setPoolInitx(r.initx_reserve || r.cw20_reserve || "0");
      setTotalLpShares(r.total_lp_shares || r.total_shares || "0");
    }).catch(() => {});
    if (address) {
      getInitBalance(address).then(setInitBal).catch(() => {});
      getInitxBalance(address).then(setInitxBal).catch(() => {});
      liquidity.getLpBalance(address).then((r: any) => setLpBal(r.balance || r.lp_balance || "0")).catch(() => {});
    }
  }, [address, liquidity, getInitBalance, getInitxBalance]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const userSharePct = Number(totalLpShares) > 0 ? ((Number(lpBal) / Number(totalLpShares)) * 100).toFixed(2) : "0.00";

  const handleAdd = async () => {
    if (!initAmount || !initxAmount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await liquidity.addLiquidity(toMicro(initAmount), toMicro(initxAmount));
      setTxHash(res?.transactionHash || "success");
      setInitAmount(""); setInitxAmount(""); fetchData();
    } catch (e: any) { setError(e.message || "Failed"); }
    setLoading(false);
  };

  const handleRemove = async () => {
    if (!lpAmount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await liquidity.removeLiquidity(toMicro(lpAmount));
      setTxHash(res?.transactionHash || "success");
      setLpAmount(""); fetchData();
    } catch (e: any) { setError(e.message || "Failed"); }
    setLoading(false);
  };

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-4 animate-reveal">
      <h1 className="text-xl font-bold text-white">Liquidity</h1>
      <p className="text-[13px] text-[#71717A]">Provide INIT/INITx liquidity and earn swap fees.</p>

      {txHash && <div className="alert-success text-xs">Success: <span className="font-mono text-[11px]">{txHash.slice(0, 16)}...</span></div>}
      {error && <div className="alert-error text-xs">{error}</div>}

      <div className="glass-card p-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            ["Pool INIT", fmt(poolInit)],
            ["Your Share", `${userSharePct}%`],
            ["Your LP", fmt(lpBal)],
          ].map(([label, val]) => (
            <div key={label}>
              <p className="stat-label mb-1">{label}</p>
              <p className="text-sm font-semibold text-white font-mono">{val}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="tab-group">
        {(["add", "remove"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setTxHash(null); setError(null); }} className={`tab-item ${tab === t ? "active" : ""}`}>
            {t === "add" ? "Add" : "Remove"}
          </button>
        ))}
      </div>

      {tab === "add" ? (
        <div className="space-y-3">
          <TokenInput label="INIT" token="INIT" value={initAmount} onChange={setInitAmount} balance={initBal ? fmt(initBal) : undefined} />
          <TokenInput label="INITx" token="INITx" value={initxAmount} onChange={setInitxAmount} balance={initxBal ? fmt(initxBal) : undefined} />
          <button onClick={handleAdd} disabled={loading || !initAmount || !initxAmount || !address} className="w-full py-2.5 btn-primary">
            {loading ? "Processing..." : "Add Liquidity"}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <TokenInput label="LP Tokens" token="LP" value={lpAmount} onChange={setLpAmount} balance={fmt(lpBal)} />
          <button onClick={handleRemove} disabled={loading || !lpAmount || !address} className="w-full py-2.5 btn-primary">
            {loading ? "Processing..." : "Remove Liquidity"}
          </button>
        </div>
      )}

      {/* How It Works */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Liquidity Works</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          Deposit INIT + INITx to receive LP tokens. Swap fees accumulate in the pool and are harvested by the keeper to boost the INITx exchange rate. Remove liquidity anytime to get your share back.
        </p>
      </div>
    </div>
  );
}
