// Ported from tokenistt marketing-site dashboard preview (Logos.jsx) —
// brand SVG marks (simple-icons raw imports) were dropped since that needs a
// Vite-only ?raw loader; LogoBadge always falls back to the letterform badge.

const STATUS_MAP: Record<string, { c: string; l: string }> = {
  connected: { c: "var(--green)", l: "connected" },
  active: { c: "var(--green)", l: "active" },
  available: { c: "var(--fg-3)", l: "available" },
  planned: { c: "var(--amber)", l: "planned" },
  paused: { c: "var(--fg-4)", l: "paused" },
  breached: { c: "var(--red)", l: "breached" },
  warning: { c: "var(--amber)", l: "warning" },
  ok: { c: "var(--green)", l: "ok" },
  invited: { c: "var(--amber)", l: "invited" },
  allowed: { c: "var(--green)", l: "allowed" },
  denied: { c: "var(--red)", l: "denied" },
  "rate-limited": { c: "var(--amber)", l: "rate-limited" },
  revoked: { c: "var(--fg-4)", l: "revoked" },
  live: { c: "var(--green)", l: "live" },
  degraded: { c: "var(--amber)", l: "degraded" },
  stale: { c: "var(--red)", l: "stale" },
  "not connected": { c: "var(--fg-4)", l: "not connected" },
  "at risk": { c: "var(--red)", l: "at risk" },
};
const GLOW_STATUSES = ["connected", "active", "ok", "allowed", "live"];

export function StatusPill({ status }: { status: string }) {
  const m = STATUS_MAP[status] || { c: "var(--fg-3)", l: status };
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: m.c }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: m.c, boxShadow: GLOW_STATUSES.includes(status) ? `0 0 6px ${m.c}` : "none" }} />
      {m.l}
    </span>
  );
}

export function LogoBadge({ letter, color, size = 36, radius = 9 }: { letter: string; color: string; size?: number; radius?: number }) {
  const fg = readableFg(color);
  return (
    <div
      className="mono"
      style={{
        width: size, height: size, minWidth: size, borderRadius: radius, background: color,
        display: "grid", placeItems: "center", color: fg, fontWeight: 600,
        fontSize: size * 0.4, letterSpacing: "-0.02em",
        boxShadow: "inset 0 0 0 1px oklch(1 0 0 / 0.08)",
      }}
    >
      {letter}
    </div>
  );
}

function readableFg(hex: string) {
  const c = hex.replace("#", "");
  if (c.length !== 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma > 0.6 ? "#0a0a0a" : "#ffffff";
}

export function ConfidenceBadge({ level, source }: { level: string; source: string }) {
  const isMeasured = level === "measured";
  const color = isMeasured ? "var(--green)" : "var(--amber)";
  return (
    <span
      className="mono"
      title={source}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color, border: `1px solid ${color}`, borderRadius: 999, padding: "2px 8px 2px 7px" }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 3, background: color }} />
      {isMeasured ? "measured" : "estimated"}
    </span>
  );
}

export function FreshnessBadge({ status = "live", lastSync }: { status?: string; lastSync?: string | null }) {
  const map: Record<string, { c: string; l: string }> = {
    live: { c: "var(--green)", l: "live" },
    degraded: { c: "var(--amber)", l: "degraded source" },
    stale: { c: "var(--red)", l: "stale" },
  };
  const m = map[status] || map.live;
  return (
    <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: m.c }}>
      <span style={{ width: 5, height: 5, borderRadius: 3, background: m.c }} />
      {lastSync ? `as of ${lastSync}` : m.l}
      {status !== "live" && <span style={{ color: "var(--fg-4)" }}>· {m.l}</span>}
    </span>
  );
}
