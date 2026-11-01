import type { KeyUsage, RequestRow } from './api';

/** Dollars with enough precision that tiny LLM costs don't all read "$0.00". */
export function usd(n: number): string {
  if (n === 0) return '$0.00';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export type Level = 'ok' | 'warn' | 'critical';

export function budgetLevel(u: KeyUsage, warnPercent: number): Level {
  const pct = u.budget?.percent_used;
  if (pct == null) return 'ok';
  return pct >= 100 ? 'critical' : pct >= warnPercent ? 'warn' : 'ok';
}

export function statusBarText(u: KeyUsage): string {
  const base = `$(pulse) ${usd(u.today.cost_usd)} today`;
  return u.budget ? `${base} · ${Math.round(u.budget.percent_used)}%` : base;
}

export function statusBarTooltip(u: KeyUsage): string {
  const lines = [
    `Tokenistt — key "${u.key.name}"`,
    `Today: ${usd(u.today.cost_usd)} · ${u.today.requests} requests`,
    `This month: ${usd(u.month.cost_usd)} · ${u.month.requests} requests${u.month.errors ? ` · ${u.month.errors} failed` : ''}`,
  ];
  if (u.budget) {
    lines.push(`Budget (${u.budget.period}): ${usd(u.budget.spent_usd)} of ${usd(u.budget.cap_usd)} — ${usd(u.budget.remaining_usd)} left`);
  } else {
    lines.push('No budget cap on this key');
  }
  lines.push(`Last request: ${ago(u.last_request_at)}`);
  return lines.join('\n');
}

export function requestLabel(r: RequestRow): string {
  return `${r.model} · ${usd(Number(r.cost_usd))}`;
}

export function requestDescription(r: RequestRow, now = Date.now()): string {
  const tokens = `${r.prompt_tokens}→${r.completion_tokens} tok`;
  const status = r.status === 'success' ? '' : ` · ${r.error_code ?? r.status}`;
  return `${tokens}${status} · ${ago(r.created_at, now)}`;
}

/** Settings a developer pastes into any OpenAI-compatible tool. */
export function connectionSnippet(gatewayUrl: string, apiKey: string | undefined): string {
  const base = gatewayUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return [
    `OPENAI_BASE_URL=${base}/v1`,
    `OPENAI_API_KEY=${apiKey ?? 'tktt_live_…  (create one under "API keys" in the dashboard)'}`,
  ].join('\n');
}
