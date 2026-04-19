"use client";

interface TokenInputProps {
  label: string;
  token: string;
  value: string;
  onChange: (v: string) => void;
  balance?: string;
  disabled?: boolean;
}

export default function TokenInput({ label, token, value, onChange, balance, disabled }: TokenInputProps) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-[#71717A] uppercase tracking-wider">{label}</span>
        {balance && (
          <button
            onClick={() => onChange(balance)}
            className="text-[11px] text-[#71717A] hover:text-[#A1A1AA] transition-colors"
          >
            Bal: <span className="font-mono">{balance}</span> {token}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          placeholder="0.00"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 min-w-0 bg-transparent text-lg font-semibold text-white outline-none placeholder:text-[#27272A] disabled:text-[#52525B] font-mono"
        />
        <span className="text-xs font-medium text-[#A1A1AA] bg-white/5 px-2.5 py-1 rounded-lg shrink-0 border border-white/6">
          {token}
        </span>
      </div>
    </div>
  );
}
