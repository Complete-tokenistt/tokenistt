import Link from "next/link";
import { getSummary, getAnomalies } from "@/lib/mock-data";
import StatCard from "@/components/StatCard";
import ProgressBar from "@/components/ProgressBar";
import Section from "@/components/Section";
import AnomalyList from "@/components/AnomalyList";
import { fmtUsd, fmtPct, fmtUsdCompact } from "@/lib/format";

export default function SummaryPage() {
  const s = getSummary();
  const anomalies = getAnomalies();

  const budgetTone =
    s.budgetUsedPct >= 100 ? "red" : s.budgetUsedPct >= 85 ? "amber" : "emerald";
  const maxCc = Math.max(...s.topCostCenters.map((c) => c.spendUsd), 1);

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Spend this month"
          value={fmtUsd(s.totalSpendUsd)}
          sub={`${fmtPct(s.momGrowthPct)} vs last month`}
          accent={s.momGrowthPct > 0 ? "amber" : "emerald"}
        />
        <StatCard
          label="Budget used"
          value={`${s.budgetUsedPct.toFixed(1)}%`}
          sub={`${fmtUsd(s.budgetUsd)} monthly budget`}
          accent={budgetTone}
        />
        <StatCard
          label="Anomaly alerts"
          value={String(s.anomalyCount)}
          sub=">3× 30-day average"
          accent="red"
        />
        <StatCard
          label="Shadow AI exposure"
          value={fmtUsd(s.shadowAiSpendUsd)}
          sub={`${s.shadowAiCount} unreviewed events`}
          accent="amber"
        />
      </div>

      {/* Top cost centers + anomalies */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Section
          title="Top Cost Centers"
          description={`Share of ${fmtUsdCompact(s.totalSpendUsd)} MTD spend`}
          action={
            <Link
              href="/cost-centers"
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              View all →
            </Link>
          }
          className="lg:col-span-2"
        >
          <ul className="space-y-4">
            {s.topCostCenters.map((c) => (
              <li key={c.code}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-800">
                    {c.name}{" "}
                    <span className="text-xs font-normal text-slate-400">
                      {c.code}
                    </span>
                  </span>
                  <span className="tabular-nums text-slate-600">
                    {fmtUsd(c.spendUsd)} · {c.sharePct.toFixed(1)}%
                  </span>
                </div>
                <ProgressBar
                  valuePct={(c.spendUsd / maxCc) * 100}
                  tone="brand"
                />
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Anomaly Alerts"
          description="Spend spikes vs 30-day baseline"
          action={
            <Link
              href="/cost-centers"
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              Details →
            </Link>
          }
        >
          <AnomalyList anomalies={anomalies} />
        </Section>
      </div>

      {/* Shadow AI banner */}
      <Section
        title="Shadow AI"
        description="Unauthorized usage detected via expense & card integrations"
        action={
          <Link
            href="/shadow-ai"
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
          >
            Investigate →
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
          <div>
            <span className="text-slate-400">Detected spend: </span>
            <span className="font-semibold text-amber-600">
              {fmtUsd(s.shadowAiSpendUsd)}
            </span>
          </div>
          <div>
            <span className="text-slate-400">Events: </span>
            <span className="font-semibold">{s.shadowAiCount}</span>
          </div>
          <div className="text-slate-500">
            Includes corporate-card charges, browser-extension usage, and
            unsanctioned subscriptions outside the Tokenistt gateway.
          </div>
        </div>
      </Section>
    </div>
  );
}
