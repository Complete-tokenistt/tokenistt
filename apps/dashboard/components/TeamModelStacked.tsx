"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TeamMember } from "@/lib/types";
import { fmtUsd, MODEL_COLORS, MODEL_LABELS } from "@/lib/format";

// Stacked bar: per-member model spend — directly shows who uses expensive
// GPT-4 vs cheap Haiku.
export default function TeamModelStacked({
  members,
}: {
  members: TeamMember[];
}) {
  const modelKeys = Array.from(
    new Set(members.flatMap((m) => m.models.map((x) => x.model))),
  );

  const data = members.map((m) => {
    const row: Record<string, string | number> = { name: m.name };
    for (const k of modelKeys) {
      const mm = m.models.find((x) => x.model === k);
      row[k] = mm ? mm.spendUsd : 0;
    }
    return row;
  });

  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} />
          <YAxis
            tickFormatter={(v: number) => `$${v}`}
            tick={{ fontSize: 12 }}
            width={48}
          />
          <Tooltip
            formatter={(value: any) => fmtUsd(Number(value))}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid #e2e8f0",
              fontSize: 12,
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {modelKeys.map((k) => (
            <Bar
              key={k}
              dataKey={k}
              stackId="m"
              fill={MODEL_COLORS[k] ?? "#94a3b8"}
              name={MODEL_LABELS[k] ?? k}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
