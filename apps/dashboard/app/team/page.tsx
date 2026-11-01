"use client";

import { useEffect, useState } from "react";
import Section from "@/components/Section";
import StatCard from "@/components/StatCard";
import TeamMemberTable from "@/components/TeamMemberTable";
import TeamModelStacked from "@/components/TeamModelStacked";
import AlertConfig from "@/components/AlertConfig";
import Badge from "@/components/Badge";
import {
  fmtUsd,
  MODEL_COLORS,
  MODEL_LABELS,
  TIER_TONE,
  TIER_LABEL,
} from "@/lib/format";

export default function TeamPage() {
  const [liveTeam, setLiveTeam] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let mounted = true;

    fetch("/api/team")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!mounted) return;
        if (data) setLiveTeam(data);
        else setLoadError(true);
      })
      .catch((err) => {
        console.warn("Could not load /api/team:", err);
        if (mounted) setLoadError(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return <div className="card" style={{ padding: "48px 20px", textAlign: "center", color: "var(--fg-4)", fontSize: 13.5 }}>Loading team…</div>;
  }
  if (loadError || !liveTeam) {
    return <div className="card" style={{ padding: "48px 20px", textAlign: "center", color: "var(--red)", fontSize: 13.5 }}>Couldn&apos;t load team data.</div>;
  }

  const t = liveTeam;

  const members = t.members || [];
  const alerts = t.alerts || [];
  const modelUsage = t.modelUsage || [];

  const overCount = members.filter(
    (m: any) => (m.spendUsd / (m.budgetUsd || 1)) * 100 >= (t.budgetWarnPct || 90),
  ).length;

  const activeAlerts = alerts.filter((a: any) => a.enabled).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--fg)" }}>{t.teamName} team</h2>
        <p className="text-xs mono" style={{ color: "var(--fg-4)" }}>
          Manager: {t.managerName} · {t.period}
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Team spend (MTD)"
          value={fmtUsd(t.teamSpendUsd || 0)}
          sub={`${(t.teamBudgetUsedPct || 0).toFixed(0)}% of ${fmtUsd(t.teamBudgetUsd || 0)} budget`}
          accent={
            (t.teamBudgetUsedPct || 0) >= 100
              ? "red"
              : (t.teamBudgetUsedPct || 0) >= 85
                ? "amber"
                : "emerald"
          }
        />
        <StatCard
          label="Daily spend"
          value={fmtUsd(t.dailySpendUsd || 0)}
          sub="Alert threshold at $100/day"
          accent={(t.dailySpendUsd || 0) > 100 ? "red" : "emerald"}
        />
        <StatCard
          label="Members"
          value={String(members.length)}
          sub={`${overCount} near/over budget`}
          accent="brand"
        />
        <StatCard
          label="Active alerts"
          value={String(activeAlerts)}
          sub={`${alerts.length} configured`}
          accent="amber"
        />
      </div>

      {/* Members + Alerts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Section
          title="Team Members"
          description="Individual spend & budget"
          className="lg:col-span-2"
          action={
            <span className="text-xs mono" style={{ color: "var(--fg-4)" }}>
              {members.length} people
            </span>
          }
        >
          <TeamMemberTable data={members} />
        </Section>

        <Section
          title="Alerts"
          description="Notify me when…"
          action={
            <span className="text-xs mono" style={{ color: "var(--fg-4)" }}>
              {activeAlerts} active
            </span>
          }
        >
          <AlertConfig alerts={alerts} dailySpendUsd={t.dailySpendUsd || 0} />
        </Section>
      </div>

      {/* Model usage breakdown */}
      <Section
        title="Model Usage Breakdown"
        description="Cost breakdown across frontier, standard, and lightweight models"
      >
        <TeamModelStacked members={members} />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {modelUsage.length === 0 ? (
            <div className="col-span-4 p-4 text-center text-xs mono text-[var(--fg-4)]">
              No model usage logged for this team yet.
            </div>
          ) : (
            modelUsage.map((m: any) => (
              <div
                key={m.model}
                className="card p-3"
                style={{
                  background: "var(--bg-2)",
                  borderColor: "var(--line-soft)",
                  borderLeft: `4px solid ${MODEL_COLORS[m.model] || "var(--violet)"}`,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium" style={{ color: "var(--fg)" }}>
                    {MODEL_LABELS[m.model] ?? m.label}
                  </span>
                  <Badge tone={TIER_TONE[m.tier as keyof typeof TIER_TONE] || "neutral"}>
                    {TIER_LABEL[m.tier as keyof typeof TIER_LABEL] || m.tier}
                  </Badge>
                </div>
                <div className="mt-1 text-lg font-semibold mono tabular-nums" style={{ color: "var(--fg)" }}>
                  {fmtUsd(m.spendUsd || 0)}
                </div>
                <div className="text-xs mono" style={{ color: "var(--fg-4)" }}>
                  {(m.sharePct ?? 0).toFixed(1)}% of team
                </div>
              </div>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}
