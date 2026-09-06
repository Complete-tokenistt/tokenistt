import { getCostCenters } from "@/lib/mock-data";
import Section from "@/components/Section";
import CostCenterTable from "@/components/CostCenterTable";
import { fmtUsd } from "@/lib/format";

export default function CostCentersPage() {
  const data = getCostCenters();
  const total = data.reduce((s, c) => s + c.spendUsd, 0);
  const growing = data.filter((c) => c.momGrowthPct > 0).length;

  return (
    <div className="space-y-6">
      <Section
        title="Cost Center Drill-down"
        description="Month-to-date spend with month-over-month growth"
        action={
          <div className="flex gap-4 text-xs mono" style={{ color: "var(--fg-4)" }}>
            <span>
              Total:{" "}
              <span className="font-semibold tabular-nums" style={{ color: "var(--fg)" }}>
                {fmtUsd(total)}
              </span>
            </span>
            <span>
              Growing:{" "}
              <span className="font-semibold tabular-nums" style={{ color: "var(--fg-2)" }}>
                {growing}/{data.length}
              </span>
            </span>
          </div>
        }
      >
        <CostCenterTable data={data} />
      </Section>
    </div>
  );
}
