"use client";

import { useState, useEffect, useCallback } from "react";
import { useContracts } from "@/hooks/useContracts";

const fmt = (micro: string | number) => (Number(micro) / 1e6).toFixed(2);
const toMicro = (human: string) => (parseFloat(human) * 1e6).toFixed(0);

export default function GovernancePage() {
  const { address, governance } = useContracts();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deposit, setDeposit] = useState("");
  const [proposals, setProposals] = useState<any[]>([]);
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    governance.getProposals().then((r: any) => setProposals(r.proposals || r || [])).catch(() => {});
    governance.getConfig().then((r: any) => setConfig(r)).catch(() => {});
  }, [governance]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const minDeposit = config?.min_deposit || config?.minimum_deposit || "0";

  const handleCreate = async () => {
    if (!title || !description || !address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const depositMicro = deposit ? toMicro(deposit) : minDeposit;
      const res: any = await governance.createProposal(depositMicro, title, description);
      setTxHash(res?.transactionHash || "success");
      setTitle(""); setDescription(""); setDeposit(""); setShowCreate(false);
      fetchData();
    } catch (e: any) { setError(e.message || "Failed"); }
    setLoading(false);
  };

  const handleVote = async (proposalId: number, vote: "yes" | "no" | "abstain") => {
    if (!address) return;
    setLoading(true); setError(null); setTxHash(null);
    try {
      const res: any = await governance.vote(proposalId, vote);
      setTxHash(res?.transactionHash || "success"); fetchData();
    } catch (e: any) { setError(e.message || "Vote failed"); }
    setLoading(false);
  };

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-4 animate-reveal">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Governance</h1>
          <p className="text-[13px] text-[#71717A] mt-0.5">Vote on proposals with your INITx.</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className={showCreate ? "btn-secondary text-xs px-3 py-1.5" : "btn-primary text-xs px-3 py-1.5"}>
          {showCreate ? "Cancel" : "New Proposal"}
        </button>
      </div>

      {txHash && <div className="alert-success text-xs">Success: <span className="font-mono text-[11px]">{txHash.slice(0, 16)}...</span></div>}
      {error && <div className="alert-error text-xs">{error}</div>}

      {showCreate && (
        <div className="glass-card p-4 space-y-3 animate-fade">
          <input placeholder="Proposal title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full input-dark px-3 py-2.5 text-xs" />
          <textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full input-dark px-3 py-2.5 text-xs resize-none" />
          <input type="number" placeholder={`INITx deposit (min: ${fmt(minDeposit)})`} value={deposit} onChange={(e) => setDeposit(e.target.value)} className="w-full input-dark px-3 py-2.5 text-xs" />
          <button onClick={handleCreate} disabled={loading || !title || !description || !address} className="w-full py-2.5 btn-primary">
            {loading ? "Processing..." : "Submit Proposal"}
          </button>
        </div>
      )}

      <div className="space-y-3">
        {proposals.length === 0 && (
          <div className="glass-card p-6 text-center">
            <p className="text-[#71717A] text-xs">No proposals found</p>
          </div>
        )}
        {proposals.map((p: any) => {
          const yesVotes = Number(p.yes_votes || p.votes_yes || 0);
          const noVotes = Number(p.no_votes || p.votes_no || 0);
          const abstainVotes = Number(p.abstain_votes || p.votes_abstain || 0);
          const total = yesVotes + noVotes + abstainVotes || 1;
          const yesPct = ((yesVotes / total) * 100).toFixed(0);
          const noPct = ((noVotes / total) * 100).toFixed(0);
          const abstainPct = ((abstainVotes / total) * 100).toFixed(0);
          const status = p.status || "Active";
          const isActive = status === "Active" || status === "active" || status === "Open" || status === "open";

          return (
            <div key={p.id} className="glass-card p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="min-w-0 flex-1 mr-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] text-[#71717A] font-mono">#{p.id}</span>
                    <span className={isActive ? "badge-success" : "badge-neutral"}>{status}</span>
                  </div>
                  <h3 className="text-sm font-medium text-white truncate">{p.title}</h3>
                  {p.description && <p className="text-[11px] text-[#71717A] mt-0.5 line-clamp-2">{p.description}</p>}
                </div>
              </div>

              <div className="mb-3">
                <div className="vote-bar flex">
                  <div className="bg-[#22c55e]" style={{ width: `${yesPct}%` }} />
                  <div className="bg-[#ef4444]" style={{ width: `${noPct}%` }} />
                  <div className="bg-[#52525B]" style={{ width: `${abstainPct}%` }} />
                </div>
                <div className="flex justify-between text-[10px] text-[#71717A] mt-1 font-mono">
                  <span>Yes {yesPct}%</span>
                  <span>No {noPct}%</span>
                  <span>Abstain {abstainPct}%</span>
                </div>
              </div>

              {isActive && (
                <div className="flex gap-1.5">
                  {([["Yes", "yes", "border-[#22c55e]/30 text-[#22c55e] hover:bg-[#22c55e]/10"],
                     ["No", "no", "border-[#ef4444]/30 text-[#ef4444] hover:bg-[#ef4444]/10"],
                     ["Abstain", "abstain", "border-white/8 text-[#71717A] hover:bg-white/5"]] as const).map(([label, val, cls]) => (
                    <button
                      key={val}
                      onClick={() => handleVote(p.id, val as "yes" | "no" | "abstain")}
                      disabled={loading || !address}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium border transition-all disabled:opacity-30 backdrop-blur-sm ${cls}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── How It Works ── */}
      <div className="glass-card p-4">
        <p className="text-[13px] font-semibold text-white mb-2">How Governance Works</p>
        <p className="text-[12px] text-[#A1A1AA] leading-relaxed">
          INITx holders create proposals and vote (Yes/No/Abstain). Voting power is proportional to your INITx balance. Proposals can change protocol parameters like fees and collateral factors.
        </p>
      </div>
    </div>
  );
}
