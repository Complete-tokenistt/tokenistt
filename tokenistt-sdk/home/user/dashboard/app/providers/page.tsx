import { getProviderBreakdown } from "@/lib/mock-data";
import Section from "@/components/Section";
import ProviderPie from "@/components/ProviderPie";
import { fmtUsd, fmtUsdCompact } from "@/lib/format";

export default function ProvidersPage() {
  const data = getProviderBreakdown();
  const total = data.reduce((s, d) => s + d.spendUsd, 0);

  return (
    <div className="space-y-6">
      <Section
        title="Provider Breakdown"
        description="Consolidated spend by AI provider (month to date)"
      >
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ProviderPie data={data} />
          <div className="space-y-3 self-center">
            {data.map((d) => (
              <div
                key={d.provider}
                className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ background: d.color }}
                  />
                  <span className="text-sm font-medium text-slate-700">
                    {d.label}
                  </span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold tabular-nums">
                    {fmtUsd(d.spendUsd)}
                  </div>
                  <div className="text-xs text-slate-400">
                    {d.sharePct.toFixed(1)}%
                  </div>
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-slate-100 px-3 pt-3 text-sm">
              <span className="font-medium text-slate-500">Total</span>
              <span className="font-semibold tabular-nums">
                {fmtUsdCompact(total)}
              </span>
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
