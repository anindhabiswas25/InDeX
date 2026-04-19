"use client";

import { useState, useEffect, useCallback } from "react";
import TokenInput from "@/components/TokenInput";
import StatsCard from "@/components/StatsCard";
import { useBridge } from "@/hooks/useBridge";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
const toMicro = (human: string) => (parseFloat(human) * 1e6).toFixed(0);

export default function BridgePage() {
  const { address, getL1Balance, getL2Balance, bridgeToL2 } = useBridge();
  const [amount, setAmount] = useState("");
  const [l1Bal, setL1Bal] = useState<string>("...");
  const [l2Bal, setL2Bal] = useState<string>("...");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const fetchBalances = useCallback(async () => {
    if (!address) return;
    getL1Balance(address).then(setL1Bal).catch(() => setL1Bal("0"));
    getL2Balance(address).then(setL2Bal).catch(() => setL2Bal("0"));
  }, [address, getL1Balance, getL2Balance]);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  useEffect(() => {
    if (!polling || !address) return;
    const interval = setInterval(async () => {
      const newBal = await getL2Balance(address).catch(() => "0");
      setL2Bal(newBal);
      if (newBal !== l2Bal && l2Bal !== "..." && l2Bal !== "0") setPolling(false);
    }, 5000);
    const timeout = setTimeout(() => setPolling(false), 180000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [polling, address, getL2Balance, l2Bal]);

  const handleBridge = async () => {
    if (!amount || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await bridgeToL2(toMicro(amount));
      setTxHash(res?.transactionHash || "success");
      setAmount(""); setPolling(true);
    } catch (e: any) { setError(e.message || "Bridge transaction failed"); }
    setLoading(false);
  };

  return (
    <div className="max-w-md mx-auto px-4 py-8 space-y-4 animate-reveal">
      <div>
        <h1 className="text-xl font-bold text-white">Bridge INIT</h1>
        <p className="text-[13px] text-[#71717A] mt-0.5">L1 → wasm-1 via OPinit bridge</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatsCard label="L1 Balance" value={l1Bal === "..." ? "..." : fmt(l1Bal)} sub="Initia L1" />
        <StatsCard label="L2 Balance" value={l2Bal === "..." ? "..." : fmt(l2Bal)} sub="wasm-1" />
      </div>

      {txHash && (
        <div className="alert-success space-y-1">
          <p className="text-xs">Bridge tx submitted!</p>
          <p className="text-[10px] opacity-70 break-all font-mono">{txHash}</p>
          {polling && <p className="text-[11px] text-[#eab308] animate-pulse">Waiting for L2 arrival (~1-2 min)...</p>}
        </div>
      )}
      {error && <div className="alert-error text-xs">{error}</div>}

      <div className="space-y-3">
        <div className="glass-card p-3 flex items-center justify-between text-xs">
          <span className="text-[#71717A]">From</span>
          <span className="text-[#A1A1AA] font-mono text-[11px]">Initia L1</span>
        </div>

        <TokenInput label="Amount" token="INIT" value={amount} onChange={setAmount} balance={l1Bal === "..." ? undefined : fmt(l1Bal)} />

        <div className="flex justify-center">
          <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[#71717A] text-sm backdrop-blur-sm">↓</div>
        </div>

        <div className="glass-card p-3">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-[#71717A]">To</span>
            <span className="text-[#A1A1AA] font-mono text-[11px]">wasm-1</span>
          </div>
          <p className="text-sm font-semibold text-white font-mono">
            {amount ? `${parseFloat(amount).toFixed(2)} INIT` : "0.00 INIT"}
          </p>
        </div>

        <button onClick={handleBridge} disabled={loading || !amount || !address || parseFloat(amount) <= 0} className="w-full py-2.5 btn-primary">
          {loading ? "Bridging..." : !address ? "Connect Wallet" : "Bridge to wasm-1"}
        </button>
      </div>

      {/* ── How It Works ── */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Bridge Works</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          Transfer INIT from Initia L1 to wasm-1 L2 via OPinit bridge (ID: 1457). Funds arrive in ~1-2 minutes. Required before using any DeFi features on InDex.
        </p>
      </div>
    </div>
  );
}
