"use client";

import { useState, useEffect, useCallback } from "react";
import TokenInput from "@/components/TokenInput";
import { useContracts } from "@/hooks/useContracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
const toMicro = (human: string) => (parseFloat(human) * 1e6).toFixed(0);

export default function SwapPage() {
  const { address, swap, getInitBalance, getInitxBalance } = useContracts();
  const [fromToken, setFromToken] = useState<"INIT" | "INITx">("INIT");
  const [amount, setAmount] = useState("");
  const [initReserve, setInitReserve] = useState("0");
  const [initxReserve, setInitxReserve] = useState("0");
  const [initBal, setInitBal] = useState<string | null>(null);
  const [initxBal, setInitxBal] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    swap.getPool().then((r: any) => {
      setInitReserve(r.init_reserve || r.native_reserve || "0");
      setInitxReserve(r.initx_reserve || r.cw20_reserve || "0");
    }).catch(() => {});
    if (address) {
      getInitBalance(address).then(setInitBal).catch(() => {});
      getInitxBalance(address).then(setInitxBal).catch(() => {});
    }
  }, [address, swap, getInitBalance, getInitxBalance]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toToken = fromToken === "INIT" ? "INITx" : "INIT";
  const rate = fromToken === "INIT"
    ? (Number(initxReserve) / Number(initReserve) || 0)
    : (Number(initReserve) / Number(initxReserve) || 0);

  const flip = () => { setFromToken(fromToken === "INIT" ? "INITx" : "INIT"); setAmount(""); };
  const fromBalance = fromToken === "INIT" ? initBal : initxBal;

  const handleSwap = async () => {
    if (!amount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const micro = toMicro(amount);
      const res: any = fromToken === "INIT"
        ? await swap.swapInitForInitx(micro)
        : await swap.swapInitxForInit(micro);
      setTxHash(res?.transactionHash || "success");
      setAmount(""); fetchData();
    } catch (e: any) { setError(e.message || "Swap failed"); }
    setLoading(false);
  };

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-4 animate-reveal">
      <h1 className="text-xl font-bold text-white">Swap</h1>
      <p className="text-[13px] text-[#71717A]">Trade between INIT and INITx instantly.</p>

      {txHash && <div className="alert-success text-xs">Success: <span className="font-mono text-[11px]">{txHash.slice(0, 16)}...</span></div>}
      {error && <div className="alert-error text-xs">{error}</div>}

      <div className="space-y-2 relative">
        <TokenInput label="From" token={fromToken} value={amount} onChange={setAmount} balance={fromBalance ? fmt(fromBalance) : undefined} />

        <div className="flex justify-center -my-0.5 relative z-10">
          <button onClick={flip} className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[#71717A] hover:text-white text-sm transition-colors backdrop-blur-sm">↕</button>
        </div>

        <TokenInput label="To" token={toToken} value={amount ? (parseFloat(amount) * rate).toFixed(4) : ""} onChange={() => {}} disabled />
      </div>

      <div className="glass-card p-3 text-xs space-y-1.5">
        {[
          ["Rate", `1 ${fromToken} = ${rate.toFixed(4)} ${toToken}`],
          ["Pool INIT", fmt(initReserve)],
          ["Pool INITx", fmt(initxReserve)],
        ].map(([label, val]) => (
          <div key={label} className="flex justify-between">
            <span className="text-[#71717A]">{label}</span>
            <span className="text-white font-mono text-[11px]">{val}</span>
          </div>
        ))}
      </div>

      <button onClick={handleSwap} disabled={loading || !amount || !address} className="w-full py-2.5 btn-primary">
        {loading ? "Processing..." : "Swap"}
      </button>

      {/* How It Works */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Swaps Work</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          AMM pool uses constant product (x * y = k). A fee on each swap is harvested by the keeper and fed into the staking pool, increasing the INITx exchange rate.
        </p>
      </div>
    </div>
  );
}
