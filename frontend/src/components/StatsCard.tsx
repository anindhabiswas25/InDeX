interface StatsCardProps {
  label: string;
  value: string;
  sub?: string;
}

export default function StatsCard({ label, value, sub }: StatsCardProps) {
  return (
    <div className="glass-card p-4">
      <p className="stat-label mb-1.5">{label}</p>
      <p className="text-base font-semibold text-white font-mono truncate" title={value}>{value}</p>
      {sub && <p className="text-[11px] text-[#52525B] mt-1 truncate-text">{sub}</p>}
    </div>
  );
}
