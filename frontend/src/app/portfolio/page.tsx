"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useContracts } from "@/hooks/useContracts";
import { contracts, chainConfig } from "@/config/contracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);

function Skeleton() {
  return <span className="inline-block w-20 h-4 bg-white/10 rounded animate-pulse" />;
}

export default function PortfolioPage() {
  const { address, getInitBalance, getInitxBalance, query } = useContracts();

  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const fetchCount = useRef(0);

  // Protocol state (no wallet needed)
  const [exchangeRate, setExchangeRate] = useState<number | null>(null);
  const [poolInit, setPoolInit] = useState("0");
  const [poolInitx, setPoolInitx] = useState("0");
  const [totalLpShares, setTotalLpShares] = useState("0");
  const [proposals, setProposals] = useState<any[]>([]);

  // Wallet state
  const [initBal, setInitBal] = useState<string | null>(null);
  const [initxBal, setInitxBal] = useState<string | null>(null);
  const [lpShares, setLpShares] = useState<string | null>(null);
  const [lendCollateral, setLendCollateral] = useState<string | null>(null);
  const [lendDebt, setLendDebt] = useState<string | null>(null);
  const [healthFactor, setHealthFactor] = useState<string | null>(null);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);

  async function fetchAll(addr: string | undefined) {
    const id = ++fetchCount.current;
    setLoading(true);
    setFetchError(null);

    try {
      // ── Protocol-level queries (always run) ──
      const [rateRes, poolRes, propRes] = await Promise.allSettled([
        query("staking", { exchange_rate: {} }),
        query("swap", { pool_state: {} }),
        query("governance", { proposals: { start_after: null, limit: null } }),
      ]);

      if (id !== fetchCount.current) return;

      if (rateRes.status === "fulfilled") {
        const r = rateRes.value as any;
        const raw = r.rate || r.exchange_rate || String(r);
        const num = parseFloat(raw);
        setExchangeRate(num >= 100 ? num / 1e6 : num);
      }
      if (poolRes.status === "fulfilled") {
        const r = poolRes.value as any;
        setPoolInit(r.init_reserve || r.native_reserve || "0");
        setPoolInitx(r.initx_reserve || r.cw20_reserve || "0");
        setTotalLpShares(r.total_lp_shares || r.total_shares || "0");
      }
      if (propRes.status === "fulfilled") {
        const r = propRes.value as any;
        setProposals(r.proposals || r || []);
      }

      if (!addr) {
        setInitBal(null); setInitxBal(null); setLpShares(null);
        setLendCollateral(null); setLendDebt(null); setHealthFactor(null);
        setWithdrawals([]);
        return;
      }

      // ── Wallet-dependent queries ──
      const [iBal, ixBal, lpB, pos, hf, wds] = await Promise.allSettled([
        getInitBalance(addr),
        getInitxBalance(addr),
        query("liquidity", { lp_balance: { address: addr } }),
        query("lending", { position: { address: addr } }),
        query("lending", { health_factor: { address: addr } }),
        query("staking", { withdrawals: { user: addr } }),
      ]);

      if (id !== fetchCount.current) return;

      setInitBal(iBal.status === "fulfilled" ? (iBal.value as string) : "0");
      setInitxBal(ixBal.status === "fulfilled" ? (ixBal.value as string) : "0");

      if (lpB.status === "fulfilled") {
        const r = lpB.value as any;
        // contract returns { shares, init_value, initx_value }
        setLpShares(r.shares || r.balance || r.lp_balance || "0");
      } else { setLpShares("0"); }

      if (pos.status === "fulfilled") {
        const r = pos.value as any;
        setLendCollateral(r.collateral || r.collateral_amount || "0");
        setLendDebt(r.debt || r.borrowed || r.debt_amount || "0");
      } else { setLendCollateral("0"); setLendDebt("0"); }

      if (hf.status === "fulfilled") {
        const r = hf.value as any;
        setHealthFactor(r.health_factor || r.factor || String(r));
      } else { setHealthFactor(null); }

      if (wds.status === "fulfilled") {
        const r = wds.value as any;
        setWithdrawals(r.withdrawals || r || []);
      } else { setWithdrawals([]); }

    } catch (e: any) {
      if (id === fetchCount.current) setFetchError("RPC error — click Refresh to retry.");
    } finally {
      if (id === fetchCount.current) setLoading(false);
    }
  }

  // Fetch on mount and whenever address changes
  useEffect(() => {
    fetchAll(address);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Auto-refresh every 30s
  useEffect(() => {
    const t = setInterval(() => fetchAll(address), 30_000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const rate = exchangeRate ?? 1;
  const initxValue = initxBal ? (Number(initxBal) / 1e6 * rate).toFixed(2) : null;
  const lpPct = Number(totalLpShares) > 0 && lpShares
    ? ((Number(lpShares) / Number(totalLpShares)) * 100).toFixed(2) : "0.00";
  const lpInitVal = Number(totalLpShares) > 0 && lpShares
    ? (Number(lpShares) / Number(totalLpShares) * Number(poolInit) / 1e6).toFixed(2) : "0.00";
  const lpInitxVal = Number(totalLpShares) > 0 && lpShares
    ? (Number(lpShares) / Number(totalLpShares) * Number(poolInitx) / 1e6).toFixed(2) : "0.00";

  if (!address) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-2xl font-bold text-white">Portfolio</h1>
        <p className="text-[#71717A] mt-2">Connect your wallet to view your portfolio.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 animate-reveal">

      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Portfolio</h1>
          <p className="text-[13px] text-[#52525B] mt-1 font-mono truncate max-w-xs">{address}</p>
        </div>
        <button
          onClick={() => fetchAll(address)}
          disabled={loading}
          className="text-[12px] text-[#52525B] hover:text-white transition-colors disabled:opacity-40"
        >
          {loading ? "Loading..." : "↻ Refresh"}
        </button>
      </div>

      {fetchError && <div className="alert-warning text-xs mb-6">{fetchError}</div>}

      {/* ── Token Balances ── */}
      <section className="mb-8">
        <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Token Balances</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass-card-premium p-5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] text-[#71717A]">INIT</span>
              <Link href="/stake" className="text-[11px] text-[#52525B] hover:text-white transition-colors">Stake →</Link>
            </div>
            <p className="text-2xl font-bold text-white font-mono">{initBal !== null ? fmt(initBal) : <Skeleton />}</p>
            <p className="text-[11px] text-[#3F3F46] mt-1">Native token</p>
          </div>
          <div className="glass-card-premium p-5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] text-[#71717A]">INITx</span>
              <Link href="/swap" className="text-[11px] text-[#52525B] hover:text-white transition-colors">Swap →</Link>
            </div>
            <p className="text-2xl font-bold text-white font-mono">{initxBal !== null ? fmt(initxBal) : <Skeleton />}</p>
            <p className="text-[11px] text-[#3F3F46] mt-1">{initxValue ? `≈ ${initxValue} INIT` : "Liquid staking token"}</p>
          </div>
          <div className="glass-card-premium p-5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[13px] text-[#71717A]">LP Shares</span>
              <Link href="/liquidity" className="text-[11px] text-[#52525B] hover:text-white transition-colors">Manage →</Link>
            </div>
            <p className="text-2xl font-bold text-white font-mono">{lpShares !== null ? fmt(lpShares) : <Skeleton />}</p>
            <p className="text-[11px] text-[#3F3F46] mt-1">{lpPct}% of pool</p>
          </div>
        </div>
      </section>

      {/* ── LP Position ── */}
      {lpShares !== null && Number(lpShares) > 0 && (
        <section className="mb-8">
          <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">LP Position Value</p>
          <div className="glass-card p-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: "Your INIT", val: lpInitVal },
                { label: "Your INITx", val: lpInitxVal },
                { label: "Pool Share", val: `${lpPct}%` },
                { label: "LP Tokens", val: fmt(lpShares) },
              ].map(({ label, val }) => (
                <div key={label}>
                  <p className="text-[11px] text-[#71717A] uppercase tracking-wider mb-1">{label}</p>
                  <p className="text-lg font-semibold text-white font-mono">{val}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Lending Position ── */}
      <section className="mb-8">
        <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Lending Position</p>
        <div className="glass-card p-5">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div>
              <p className="text-[11px] text-[#71717A] uppercase tracking-wider mb-1">Collateral</p>
              <p className="text-lg font-semibold text-white font-mono">{lendCollateral !== null ? fmt(lendCollateral) : <Skeleton />}</p>
              <p className="text-[11px] text-[#3F3F46]">INITx</p>
            </div>
            <div>
              <p className="text-[11px] text-[#71717A] uppercase tracking-wider mb-1">Borrowed</p>
              <p className="text-lg font-semibold text-white font-mono">{lendDebt !== null ? fmt(lendDebt) : <Skeleton />}</p>
              <p className="text-[11px] text-[#3F3F46]">INIT</p>
            </div>
            <div>
              <p className="text-[11px] text-[#71717A] uppercase tracking-wider mb-1">Health Factor</p>
              <p className={`text-lg font-semibold font-mono ${
                !healthFactor ? "text-white" :
                parseFloat(healthFactor) < 1.5 ? "text-[#ef4444]" :
                parseFloat(healthFactor) < 3   ? "text-[#eab308]" :
                                                  "text-[#22c55e]"
              }`}>
                {healthFactor ?? (lendDebt !== null ? "—" : <Skeleton />)}
              </p>
            </div>
          </div>
          {(Number(lendCollateral) > 0 || Number(lendDebt) > 0) && (
            <div className="mt-4 pt-4 border-t border-white/5">
              <Link href="/lend" className="text-[13px] font-medium text-white hover:opacity-70 transition-opacity">
                Manage Position →
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ── Pending Withdrawals ── */}
      {withdrawals.length > 0 && (
        <section className="mb-8">
          <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Pending Withdrawals</p>
          <div className="glass-card p-5 space-y-2">
            {withdrawals.map((w: any) => (
              <div key={w.id} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                <span className="text-[13px] text-[#A1A1AA] font-mono">#{w.id} — {fmt(w.amount || w.init_amount || "0")} INIT</span>
                <Link href="/stake" className="text-[11px] text-[#52525B] hover:text-white transition-colors">Claim →</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Governance ── */}
      <section className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider">Governance</p>
          <Link href="/governance" className="text-[11px] text-[#52525B] hover:text-white transition-colors">View All →</Link>
        </div>
        <div className="glass-card p-5">
          <p className="text-[13px] text-[#71717A]">
            {proposals.length === 0
              ? "No active proposals"
              : `${proposals.length} proposal${proposals.length > 1 ? "s" : ""} found`}
          </p>
          <p className="text-[11px] text-[#3F3F46] mt-1">INITx holders can vote on protocol governance proposals.</p>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section className="mb-8">
        <div className="glass-card p-4">
          <p className="text-[13px] font-semibold text-white mb-2">How Yield Accrues</p>
          <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
            The keeper harvests lending + swap fees every 10 min, sending INIT to the staking pool. This grows the exchange rate — your INITx balance stays the same but its INIT value increases. Real yield, not inflation.
          </p>
        </div>
      </section>
    </div>
  );
}
