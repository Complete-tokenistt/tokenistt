"use client";

import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { ProviderBreakdownRow } from "@/lib/types";
import { fmtUsd } from "@/lib/format";

export default function ProviderPie({
  data,
}: {
  data: ProviderBreakdownRow[];
}) {
  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="spendUsd"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={95}
            paddingAngle={2}
            label={({ name, percent }: any) =>
              `${name} ${(percent * 100).toFixed(1)}%`
            }
            labelLine={false}
          >
            {data.map((d) => (
              <Cell key={d.provider} fill={d.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: any) => fmtUsd(Number(value))}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid #e2e8f0",
              fontSize: 12,
            }}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="circle"
            wrapperStyle={{ fontSize: 12 }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
