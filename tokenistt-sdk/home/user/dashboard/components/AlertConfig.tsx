"use client";

import { useState } from "react";
import type { AlertChannel, TeamAlert } from "@/lib/types";
import { fmtUsd } from "@/lib/format";

// Manager-editable alert rules. Local state in this scaffold; in production
// these would persist to the gateway / notification service.
export default function AlertConfig({
  alerts,
  dailySpendUsd,
}: {
  alerts: TeamAlert[];
  dailySpendUsd: number;
}) {
  const [rows, setRows] = useState<TeamAlert[]>(alerts);

  const toggle = (id: string) =>
    setRows((prev) =>
      prev.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
    );
  const setThreshold = (id: string, v: number) =>
    setRows((prev) =>
      prev.map((a) => (a.id === id ? { ...a, threshold: v } : a)),
    );
  const setChannel = (id: string, c: AlertChannel) =>
    setRows((prev) =>
      prev.map((a) => (a.id === id ? { ...a, channel: c } : a)),
    );

  return (
    <div className="space-y-3">
      {rows.map((a) => (
        <div key={a.id} className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-start justify-between gap-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={() => toggle(a.id)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-sm text-slate-700">{a.label}</span>
            </label>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                a.enabled
                  ? "bg-emerald-50 text-emerald-600 ring-emerald-200"
                  : "bg-slate-100 text-slate-400 ring-slate-200"
              }`}
            >
              {a.enabled ? "active" : "off"}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-6 text-xs text-slate-500">
            {a.metric === "team_spend_per_day" && (
              <span>
                Current:{" "}
                <span className="font-medium text-slate-700">
                  {fmtUsd(dailySpendUsd)}/day
                </span>{" "}
                · triggers above{" "}
                <span className="font-medium text-slate-700">
                  {fmtUsd(a.threshold)}/day
                </span>
              </span>
            )}
            {a.metric === "member_budget_pct" && (
              <span>
                Triggers above <span className="font-medium">{a.threshold}%</span>{" "}
                of a member&apos;s budget
              </span>
            )}
            {a.metric === "weekly_summary" && (
              <span>Delivered weekly to the manager</span>
            )}

            <label className="flex items-center gap-1">
              Channel:
              <select
                value={a.channel}
                onChange={(e) => setChannel(a.id, e.target.value as AlertChannel)}
                className="rounded border border-slate-200 px-1 py-0.5 text-xs"
              >
                <option value="email">Email</option>
                <option value="slack">Slack</option>
              </select>
            </label>

            {(a.metric === "team_spend_per_day" ||
              a.metric === "member_budget_pct") && (
              <label className="flex items-center gap-1">
                Threshold:
                <input
                  type="number"
                  value={a.threshold}
                  min={0}
                  onChange={(e) => setThreshold(a.id, Number(e.target.value))}
                  className="w-20 rounded border border-slate-200 px-1 py-0.5 text-xs tabular-nums"
                />
              </label>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
