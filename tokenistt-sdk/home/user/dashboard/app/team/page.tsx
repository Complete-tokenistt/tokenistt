import { getTeamView } from "@/lib/mock-data";
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

// Prompt 8 — Team Manager View (team-scoped only).
export default function TeamPage() {
  const t = getTeamView();

  const overCount = t.members.filter(
    (m) => (m.spendUsd / m.budgetUsd) * 100 >= t.budgetWarnPct,
  ).length;
  const activeAlerts = t.alerts.filter((a) => a.enabled).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: "var(--fg)" }}>{t.teamName} team</h2>
        <p className="text-xs mono" style={{ color: "var(--fg-4)" }}>
          Manager: {t.managerName} · {t.period} · team-scoped view
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Team spend (MTD)"
          value={fmtUsd(t.teamSpendUsd)}
          sub={`${t.teamBudgetUsedPct.toFixed(0)}% of ${fmtUsd(t.teamBudgetUsd)} budget`}
          accent={
            t.teamBudgetUsedPct >= 100
              ? "red"
              : t.teamBudgetUsedPct >= 85
                ? "amber"
                : "emerald"
          }
        />
        <StatCard
          label="Daily spend"
          value={fmtUsd(t.dailySpendUsd)}
          sub="Alert at $100/day"
          accent={t.dailySpendUsd > 100 ? "red" : "emerald"}
        />
        <StatCard
          label="Members"
          value={String(t.members.length)}
          sub={`${overCount} near/over budget`}
          accent="brand"
        />
        <StatCard
          label="Active alerts"
          value={String(activeAlerts)}
          sub={`${t.alerts.length} configured`}
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
              {t.members.length} people
            </span>
          }
        >
          <TeamMemberTable data={t.members} />
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
          <AlertConfig alerts={t.alerts} dailySpendUsd={t.dailySpendUsd} />
        </Section>
      </div>

      {/* Model usage breakdown */}
      <Section
        title="Model Usage Breakdown"
        description="Who is using expensive GPT-4 vs cheap Haiku"
      >
        <TeamModelStacked members={t.members} />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {t.modelUsage.map((m) => (
            <div
              key={m.model}
              className="card p-3"
              style={{
                background: "var(--bg-2)",
                borderColor: "var(--line-soft)",
                borderLeft: `4px solid ${MODEL_COLORS[m.model]}`,
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: "var(--fg)" }}>
                  {MODEL_LABELS[m.model] ?? m.label}
                </span>
                <Badge tone={TIER_TONE[m.tier]}>{TIER_LABEL[m.tier]}</Badge>
              </div>
              <div className="mt-1 text-lg font-semibold mono tabular-nums" style={{ color: "var(--fg)" }}>
                {fmtUsd(m.spendUsd)}
              </div>
              <div className="text-xs mono" style={{ color: "var(--fg-4)" }}>
                {m.sharePct.toFixed(1)}% of team
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
