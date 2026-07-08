import { getShadowAi } from "@/lib/mock-data";
import { loadIngestedShadowAi } from "@/lib/ingest";
import Section from "@/components/Section";
import ShadowAiTable from "@/components/ShadowAiTable";
import StatCard from "@/components/StatCard";
import { fmtUsd } from "@/lib/format";

// Re-render per request so freshly ingested scanner findings show up.
export const dynamic = "force-dynamic";

export default function ShadowAiPage() {
  const ingested = loadIngestedShadowAi();
  const data = [...ingested, ...getShadowAi()];
  const total = data.reduce((s, e) => s + e.amountUsd, 0);
  const unreviewed = data.filter((e) => e.status === "unreviewed").length;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Detected spend" value={fmtUsd(total)} accent="amber" />
        <StatCard label="Events" value={String(data.length)} accent="brand" />
        <StatCard label="Unreviewed" value={String(unreviewed)} accent="red" />
      </div>

      <Section
        title="Shadow AI — unauthorized usage"
        description="Surfaced from corporate cards, browser extensions, and expense integrations outside the Tokenistt gateway"
      >
        <ShadowAiTable data={data} />
      </Section>
    </div>
  );
}
