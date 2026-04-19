"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useContracts } from "@/hooks/useContracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);

function AnimatedStat({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="text-center">
      <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-white font-mono">{value}</p>
      {suffix && <p className="text-[11px] text-[#52525B] mt-0.5">{suffix}</p>}
    </div>
  );
}

const features = [
  { num: "01", title: "Liquid Staking", desc: "Stake INIT and receive INITx — a liquid staking token that accrues real yield from protocol fees." },
  { num: "02", title: "Real Yield", desc: "Protocol revenue from lending fees and LP swap fees is harvested and distributed to INITx holders." },
  { num: "03", title: "DeFi Composability", desc: "Use INITx across swaps, liquidity pools, lending, and governance — all within InDex." },
  { num: "04", title: "Decentralized Governance", desc: "INITx holders can create and vote on proposals that shape the protocol's future." },
  { num: "05", title: "Instant Liquidity", desc: "Swap between INIT and INITx instantly through the integrated liquidity pool." },
];

const defiCards = [
  { title: "Swap", desc: "Trade INIT and INITx with low slippage through the AMM pool.", href: "/swap", icon: "↔" },
  { title: "Liquidity", desc: "Provide INIT/INITx liquidity and earn swap fees from every trade.", href: "/liquidity", icon: "◎" },
  { title: "Lending", desc: "Deposit INITx as collateral and borrow INIT against your position.", href: "/lend", icon: "⬡" },
  { title: "Governance", desc: "Vote on proposals and shape the future of the InDex protocol.", href: "/governance", icon: "⬢" },
];

export default function Dashboard() {
  const { address, staking, swap, lending, liquidity, getInitBalance, getInitxBalance } = useContracts();

  const [exchangeRate, setExchangeRate] = useState<string>("...");
  const [totalStaked, setTotalStaked] = useState<string>("...");
  const [initxSupply, setInitxSupply] = useState<string>("...");
  const [poolInitReserve, setPoolInitReserve] = useState<string>("...");
  const [poolInitxReserve, setPoolInitxReserve] = useState<string>("...");
  const [lendingTvl, setLendingTvl] = useState<string>("...");
  const [totalLpShares, setTotalLpShares] = useState<string>("...");

  useEffect(() => {
    staking.getExchangeRate().then((r: any) => {
      const raw = r.rate || r.exchange_rate || String(r);
      const num = parseFloat(raw);
      const scaled = num >= 100 ? num / 1e6 : num;
      setExchangeRate(scaled.toFixed(4));
    }).catch(() => setExchangeRate("N/A"));
    staking.getPoolState().then((r: any) => {
      setTotalStaked(r.total_init_staked || r.total_staked || "0");
      setInitxSupply(r.total_initx_supply || r.total_supply || "0");
    }).catch(() => {});
    swap.getPool().then((r: any) => {
      setPoolInitReserve(r.init_reserve || r.native_reserve || "0");
      setPoolInitxReserve(r.initx_reserve || r.cw20_reserve || "0");
      setTotalLpShares(r.total_lp_shares || r.total_shares || "0");
    }).catch(() => {});
    lending.getPoolState().then((r: any) => {
      setLendingTvl(r.total_supply || r.total_supplied || r.total_deposits || "0");
    }).catch(() => {});
  }, [staking, swap, lending]);

  return (
    <div className="animate-reveal">
      {/* ── Hero Section ── */}
      <section className="hero-gradient border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h1 className="text-4xl sm:text-5xl font-bold text-white leading-tight tracking-tight">
                Liquid Staking<br />for Initia
              </h1>
              <p className="text-[#71717A] text-lg mt-4 max-w-lg leading-relaxed">
                Stake INIT, receive INITx, and unlock DeFi composability across swaps, lending, and governance — all powered by real yield.
              </p>
              <div className="flex gap-3 mt-8">
                <Link href="/stake" className="btn-primary inline-flex items-center gap-2 text-sm px-6 py-3">
                  Stake INIT
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </Link>
                <Link href="/swap" className="btn-secondary inline-flex items-center text-sm px-6 py-3">
                  Swap Tokens
                </Link>
              </div>
            </div>
            <div className="hidden lg:flex justify-end">
              <div className="glass-card-premium p-6 w-80">
                <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-4">Live Stats</p>
                <div className="space-y-4">
                  {[
                    ["Total INIT Staked", totalStaked === "..." ? "..." : fmt(totalStaked), "INIT"],
                    ["Exchange Rate", exchangeRate, "INITx/INIT"],
                    ["Lending TVL", lendingTvl === "..." ? "..." : fmt(lendingTvl), "INIT"],
                  ].map(([label, val, unit]) => (
                    <div key={label} className="flex justify-between items-center">
                      <span className="text-[13px] text-[#71717A]">{label}</span>
                      <span className="text-[13px] font-semibold text-white font-mono">{val} <span className="text-[11px] text-[#52525B] font-normal">{unit}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats Strip ── */}
      <section className="border-b border-white/5 glow-top">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
            <AnimatedStat label="Total INIT Staked" value={totalStaked === "..." ? "..." : fmt(totalStaked)} suffix="INIT" />
            <AnimatedStat label="Exchange Rate" value={exchangeRate} suffix="INITx → INIT" />
            <AnimatedStat label="LP Pool TVL" value={poolInitReserve === "..." ? "..." : fmt(poolInitReserve)} suffix="INIT reserve" />
            <AnimatedStat label="Lending TVL" value={lendingTvl === "..." ? "..." : fmt(lendingTvl)} suffix="INIT supplied" />
          </div>
        </div>
      </section>

      {/* ── What is InDex ── */}
      <section>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="max-w-2xl">
            <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">About</p>
            <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">What is InDex?</h2>
            <p className="text-[#71717A] mt-4 leading-relaxed">
              InDex is a liquid staking protocol built on Initia. When you stake INIT, you receive INITx — a yield-bearing liquid staking token.
              Unlike simulated yield models, InDex generates real yield from lending protocol fees and LP swap fees, harvested automatically
              by the keeper bot every hour.
            </p>
          </div>
        </div>
      </section>

      {/* ── Protocol Features ── */}
      <section className="border-y border-white/5 glow-top">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Features</p>
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-10">How it works</h2>
          <div className="space-y-0">
            {features.map((f) => (
              <div key={f.num} className="flex gap-6 py-6 border-b border-white/5 last:border-0">
                <span className="feature-number shrink-0 w-16">{f.num}</span>
                <div>
                  <h3 className="text-lg font-semibold text-white">{f.title}</h3>
                  <p className="text-[#71717A] text-sm mt-1 leading-relaxed max-w-lg">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── DeFi Ecosystem ── */}
      <section>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Ecosystem</p>
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-8">DeFi with INITx</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {defiCards.map((card) => (
              <Link key={card.href} href={card.href} className="glass-card p-5 group transition-all">
                <div className="text-2xl mb-3 opacity-50 group-hover:opacity-80 transition-opacity">{card.icon}</div>
                <h3 className="text-[15px] font-semibold text-white">{card.title}</h3>
                <p className="text-[13px] text-[#71717A] mt-1 leading-relaxed">{card.desc}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* ── Protocol Statistics ── */}
      <section className="border-y border-white/5 glow-top">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-3">Statistics</p>
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-8">Protocol Numbers</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {[
              ["Total INIT Staked", totalStaked === "..." ? "..." : fmt(totalStaked), "INIT"],
              ["INITx Supply", initxSupply === "..." ? "..." : fmt(initxSupply), "INITx"],
              ["Exchange Rate", exchangeRate, "INITx/INIT"],
              ["LP INIT Reserve", poolInitReserve === "..." ? "..." : fmt(poolInitReserve), "INIT"],
              ["LP INITx Reserve", poolInitxReserve === "..." ? "..." : fmt(poolInitxReserve), "INITx"],
              ["LP Total Shares", totalLpShares === "..." ? "..." : fmt(totalLpShares), "shares"],
              ["Lending TVL", lendingTvl === "..." ? "..." : fmt(lendingTvl), "INIT"],
            ].map(([label, val, unit]) => (
              <div key={label} className="glass-card p-4">
                <p className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider mb-1.5">{label}</p>
                <p className="text-lg font-bold text-white font-mono">{val}</p>
                <p className="text-[11px] text-[#3F3F46] mt-0.5">{unit}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA Section ── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-white/[0.02] to-transparent" />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center relative">
          <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">Start earning real yield today</h2>
          <p className="text-[#71717A] mt-3 max-w-md mx-auto">
            Stake your INIT, receive INITx, and put your assets to work across the InDex ecosystem.
          </p>
          <div className="flex justify-center gap-3 mt-8">
            <Link href="/stake" className="btn-primary inline-flex items-center gap-2 text-sm px-6 py-3">
              Stake Now
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
              </svg>
            </Link>
            <Link href="/portfolio" className="btn-secondary inline-flex items-center text-sm px-6 py-3">
              View Portfolio
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="32" height="32" rx="8" fill="white"/>
                <path d="M8 8h4v16H8V8zm12 0h4v16h-4V8zM14 14h4v4h-4v-4z" fill="#09090B"/>
              </svg>
              <span className="text-[13px] font-semibold text-white">InDex Protocol</span>
            </div>
            <p className="text-[12px] text-[#3F3F46]">Built on Initia</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
