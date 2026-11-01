"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Kpi } from "@/components/Kpi";
import { LogoBadge, StatusPill } from "@/components/StatusBadges";
import { fmtUsd } from "@/lib/format";

export default function OverviewPage() {
  const [summaryData, setSummaryData] = useState<any>(null);
  const [anomaliesData, setAnomaliesData] = useState<any[]>([]);
  const [costCenters, setCostCenters] = useState<any[]>([]);
  const [shadowAi, setShadowAi] = useState<any[]>([]);
  const [budgets, setBudgets] = useState<any[]>([]);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      fetch("/api/summary?period=month").then((res) => (res.ok ? res.json() : null)),
      fetch("/api/anomalies?period=7d").then((res) => (res.ok ? res.json() : null)),
      fetch("/api/cost-centers").then((res) => (res.ok ? res.json() : null)),
      fetch("/api/shadow-ai").then((res) => (res.ok ? res.json() : null)),
      fetch("/api/budgets").then((res) => (res.ok ? res.json() : null)),
    ])
      .then(([sum, anom, cc, sai, bg]) => {
        if (mounted) {
          if (sum) setSummaryData(sum);
          if (anom?.anomalies) setAnomaliesData(anom.anomalies);
          if (Array.isArray(cc)) setCostCenters(cc);
          if (Array.isArray(sai)) setShadowAi(sai);
          if (bg?.budgets) setBudgets(bg.budgets);
        }
      })
      .catch((err) => {
        console.warn("Could not load dashboard overview metrics:", err);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const totalSpendUsd = summaryData?.total_spend_usd ?? 0;

  const budgetUsd =
    budgets.length > 0
      ? budgets.reduce((acc, b) => acc + (Number(b.budget_usd ?? b.cap_usd) || 0), 0)
      : 0;

  const budgetUsedPct = budgetUsd > 0 ? (totalSpendUsd / budgetUsd) * 100 : 0;
  const budgetTone = budgetUsedPct >= 100 ? "breached" : budgetUsedPct >= 85 ? "warning" : null;

  const anomalyCount = anomaliesData.length;
  const anomaliesToRender = anomaliesData;

  const shadowAiSpendUsd = shadowAi.reduce((acc, s) => acc + (s.amountUsd || 0), 0);
  const shadowAiCount = shadowAi.length;

  // Cost centers
  const costCentersToRender = costCenters.map((c) => ({
    name: c.name,
    code: c.code,
    spendUsd: c.spendUsd,
    sharePct: totalSpendUsd > 0 ? (c.spendUsd / totalSpendUsd) * 100 : 0,
  }));

  // Providers breakdown
  const providersToRender = (summaryData?.breakdown || []).map((b: any) => {
    const sharePct = totalSpendUsd > 0 ? ((b.spend_usd ?? 0) / totalSpendUsd) * 100 : 0;
    const pName = b.provider || "OpenAI";
    return {
      provider: pName.toLowerCase(),
      label: pName.charAt(0).toUpperCase() + pName.slice(1),
      spendUsd: b.spend_usd ?? 0,
      sharePct,
      color:
        pName.toLowerCase() === "openai"
          ? "#10a37f"
          : pName.toLowerCase() === "anthropic"
          ? "#d97706"
          : "#6366f1",
    };
  });

  return (
    <div>
      {budgetTone && (
        <div className="dash-section">
          <div
            className="dash-alert-banner"
            style={
              budgetTone === "breached"
                ? { background: "oklch(0.577 0.245 27 / 0.10)", borderColor: "oklch(0.577 0.245 27 / 0.35)" }
                : undefined
            }
          >
            <span
              className="mono dash-alert-tag"
              style={
                budgetTone === "breached"
                  ? { color: "var(--red)", borderColor: "oklch(0.577 0.245 27 / 0.45)" }
                  : undefined
              }
            >
              {budgetTone === "breached" ? "BREACHED" : "WARNING"}
            </span>
            <span style={{ fontSize: 14.5, color: "var(--fg-1)" }}>
              Workspace is at <strong>{budgetUsedPct.toFixed(1)}%</strong> of its {fmtUsd(budgetUsd)} monthly cap
            </span>
            <Link href="/budgets" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }}>
              Review →
            </Link>
          </div>
        </div>
      )}

      <div className="card dash-kpi-grid" style={{ marginBottom: 24 }}>
        <Kpi
          label="Spend MTD"
          value={
            <>
              <span className="violet">$</span>
              {totalSpendUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </>
          }
          sub={`${summaryData?.total_requests ?? 0} requests this month`}
          accent
        />
        <Kpi
          label="Budget utilization"
          value={`${budgetUsedPct.toFixed(1)}%`}
          sub={budgetUsd > 0 ? `${fmtUsd(totalSpendUsd)} / ${fmtUsd(budgetUsd)} cap` : "no budget set — add one under Budgets"}
        />
        <Kpi label="Anomaly alerts" value={String(anomalyCount)} sub=">3× 30-day average" />
        <Kpi
          label="Shadow AI exposure"
          value={fmtUsd(shadowAiSpendUsd)}
          sub={`${shadowAiCount} unreviewed events`}
          style={{ borderRight: "none" }}
        />
      </div>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">TOP COST CENTERS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>
              Share of {fmtUsd(totalSpendUsd)} MTD spend
            </div>
          </div>
          <Link href="/cost-centers" className="btn btn-ghost btn-sm">
            View all →
          </Link>
        </div>
        <div className="card" style={{ padding: 20 }}>
          {costCentersToRender.length === 0 ? (
            <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--fg-3)" }}>
              <div style={{ fontSize: 14.5, color: "var(--fg-2)", marginBottom: 6 }}>No cost center activity recorded yet</div>
              <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 480, margin: "0 auto 14px" }}>
                Tag incoming gateway requests with the <code className="mono" style={{ color: "var(--violet)" }}>x-cost-center</code> header to attribute spend across teams.
              </p>
              <Link href="/onboarding" className="btn btn-ghost btn-sm mono">
                Quickstart Guide →
              </Link>
            </div>
          ) : (
            costCentersToRender.map((c) => (
              <div key={c.code} style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 6 }}>
                  <span style={{ color: "var(--fg)" }}>
                    {c.name} <span className="mono" style={{ fontSize: 12, color: "var(--fg-4)" }}>{c.code}</span>
                  </span>
                  <span className="mono" style={{ color: "var(--fg-2)" }}>
                    {fmtUsd(c.spendUsd)} · {c.sharePct.toFixed(1)}%
                  </span>
                </div>
                <div style={{ height: 6, background: "var(--bg-2)", borderRadius: 1, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(100, c.sharePct)}%`, height: "100%", background: "var(--violet)" }} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">ANOMALY ALERTS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Spend spikes vs 30-day baseline</div>
          </div>
        </div>
        <div className="card" style={{ overflow: "hidden" }}>
          {anomaliesToRender.length === 0 ? (
            <div style={{ padding: "20px 24px", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "#22c55e", fontSize: 18 }}>✓</span>
              <div>
                <div style={{ fontSize: 14, color: "var(--fg)" }}>All systems nominal — No spend spikes or abnormal token patterns detected</div>
                <div style={{ fontSize: 12.5, color: "var(--fg-4)", marginTop: 2 }}>The statistical anomaly engine continuously monitors 30-day rolling baselines.</div>
              </div>
            </div>
          ) : (
            anomaliesToRender.map((a, i) => (
              <div
                key={a.id || i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  padding: "13px 18px",
                  borderBottom: i < anomaliesToRender.length - 1 ? "1px solid var(--line-soft)" : "none",
                }}
              >
                <StatusPill status={a.severity === "high" ? "breached" : "warning"} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: "var(--fg)" }}>{a.actor}</span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--fg-4)", marginLeft: 8 }}>
                    {a.costCenter}
                  </span>
                </div>
                <span className="mono" style={{ fontSize: 12.5, color: "var(--red)" }}>
                  {(a.ratio ?? 2.5).toFixed(1)}× · {fmtUsd(a.spend24hUsd ?? a.amount ?? 0)}/24h
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">CONNECTED PROVIDERS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>
              {fmtUsd(totalSpendUsd)} spent this cycle across {providersToRender.length} providers
            </div>
          </div>
          <Link href="/providers" className="btn btn-ghost btn-sm">
            Manage providers →
          </Link>
        </div>
        {providersToRender.length === 0 ? (
          <div className="card" style={{ padding: "24px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 14.5, color: "var(--fg-2)", marginBottom: 6 }}>No provider activity recorded this cycle</div>
            <p style={{ fontSize: 13, color: "var(--fg-4)", maxWidth: 500, margin: "0 auto 14px" }}>
              Connect your provider API keys and make calls using your Tokenistt virtual key to see live telemetry.
            </p>
            <Link href="/providers" className="btn btn-violet btn-sm">
              + Connect Provider Keys
            </Link>
          </div>
        ) : (
          <div className="dash-provider-strip">
            {providersToRender.map((p: any) => (
              <div key={p.provider} className="dash-provider-chip">
                <LogoBadge letter={p.label.charAt(0)} color={p.color} size={28} radius={7} />
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13.5,
                      color: "var(--fg)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {p.label}
                  </div>
                  <span className="mono" style={{ fontSize: 12, color: "var(--fg-3)" }}>
                    {p.sharePct.toFixed(1)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="dash-section">
        <div className="dash-section-head">
          <div>
            <div className="mono dash-section-label">QUICK ACTIONS</div>
            <div style={{ fontSize: 15, color: "var(--fg-2)", marginTop: 2 }}>Common next steps for your workspace</div>
          </div>
        </div>
        <div className="dash-quick-grid">
          <Link href="/onboarding" className="card dash-quick-card">
            <div className="mono dash-quick-num">01</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Connect your first provider</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>
              Route Anthropic, OpenAI, or Bedrock traffic through the gateway.
            </p>
          </Link>
          <Link href="/budgets" className="card dash-quick-card">
            <div className="mono dash-quick-num">02</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Set a team budget cap</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>
              Alert or auto-throttle before a team overspends.
            </p>
          </Link>
          <Link href="/governance" className="card dash-quick-card">
            <div className="mono dash-quick-num">03</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Write a governance policy</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>
              Control which models a team can call, and enforce guardrails.
            </p>
          </Link>
          <Link href="/settings" className="card dash-quick-card">
            <div className="mono dash-quick-num">04</div>
            <div style={{ fontSize: 15.5, color: "var(--fg)", marginTop: 8 }}>Secure your credentials</div>
            <p style={{ fontSize: 13.5, color: "var(--fg-3)", marginTop: 6, lineHeight: 1.5 }}>
              Encrypt and manage the root API keys the gateway uses.
            </p>
          </Link>
        </div>
      </section>
    </div>
  );
}
