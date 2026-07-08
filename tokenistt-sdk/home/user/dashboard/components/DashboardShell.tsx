"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavItem = { href: string; label: string; icon: ReactNode };

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
  >
    <path d={d} />
  </svg>
);

const NAV: NavItem[] = [
  { href: "/", label: "Executive Summary", icon: <Icon d="M3 12l9-9 9 9M5 10v10h14V10" /> },
  { href: "/providers", label: "Provider Breakdown", icon: <Icon d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4" /> },
  { href: "/cost-centers", label: "Cost Centers", icon: <Icon d="M4 6h16M4 12h16M4 18h16" /> },
  { href: "/reconciliation", label: "Invoice Reconciliation", icon: <Icon d="M9 12h6M9 16h6M9 8h6M5 4h14v16H5z" /> },
  { href: "/shadow-ai", label: "Shadow AI", icon: <Icon d="M12 3l8 4v6c0 5-3.5 7.5-8 8-4.5-.5-8-3-8-8V7z" /> },
  { href: "/team", label: "Team Manager", icon: <Icon d="M16 11a4 4 0 1 0-8 0M12 7a3 3 0 1 0 0 0M3 21v-1a6 6 0 0 1 6-6h6a6 6 0 0 1 6 6v1" /> },
  { href: "/benchmark", label: "Benchmarking", icon: <Icon d="M4 20V10M10 20V4M16 20v-7M22 20H2" /> },
];

export default function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            T
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Tokenistt</div>
            <div className="text-xs text-slate-400">CFO Dashboard</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  active
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <span className={active ? "text-brand-600" : "text-slate-400"}>
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-200 px-5 py-4 text-xs text-slate-400">
          Phase 4 · FinOps UI
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold leading-tight">Consolidated AI Spend</h1>
            <p className="text-xs text-slate-400">
              All providers · all cost centers · one view
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-600 ring-1 ring-emerald-200">
              Live
            </span>
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium">July 2026</div>
              <div className="text-xs text-slate-400">Reporting period</div>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-x-hidden px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
