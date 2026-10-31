const DASH_TONE: Record<string, string> = {
  critical: "var(--red)",
  "over-billed": "var(--red)",
  high: "var(--red)",
  unreviewed: "var(--red)",
  warning: "var(--amber)",
  "under-billed": "var(--amber)",
  medium: "var(--amber)",
  acknowledged: "var(--amber)",
  matched: "var(--green)",
  ok: "var(--green)",
  approved: "var(--green)",
  low: "var(--green)",
  missing: "var(--fg-4)",
};

export default function Badge({ children, tone }: { children: React.ReactNode; tone?: string }) {
  const key = (tone ?? String(children)).toLowerCase();
  const color = DASH_TONE[key] ?? "var(--fg-3)";
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
      {children}
    </span>
  );
}
