import type { ComponentType, SVGProps } from "react";
import {
  IconGrid, IconList, IconBell, IconShield, IconGavel, IconPlug, IconShuffle,
  IconTag, IconDatabase, IconReceipt, IconRuler, IconPuzzle, IconTrendingUp,
  IconTarget, IconColumns, IconChart, IconFlask, IconPresentation, IconUsers, IconGear,
} from "@/components/icons";

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export type NavItem = { href: string; label: string; icon: Icon };
export type NavGroup = { label: string; items: NavItem[] };

// href -> existing, DB/API-backed page (governance, providers, cost-centers,
// reconciliation, shadow-ai, team, benchmark, settings, overview) is left
// completely untouched — this file only adds navigation to it.
// The rest are net-new sections ported from the source dashboard preview,
// running on local mock data (see lib/dashboard-mock-data.ts) same as they
// did in the source — no new backend was built for them.
const ALL_NAV_GROUPS: NavGroup[] = [
  {
    label: "Monitor",
    items: [
      { href: "/", label: "Overview", icon: IconGrid },
      { href: "/usage", label: "Usage", icon: IconList },
      { href: "/requests", label: "Request history", icon: IconList },
      { href: "/alerts", label: "Alerts", icon: IconBell },
      { href: "/shadow-ai", label: "Shadow AI", icon: IconBell },
    ],
  },
  {
    label: "Control",
    items: [
      { href: "/budgets", label: "Budgets", icon: IconShield },
      { href: "/governance", label: "Governance & Policies", icon: IconGavel },
      { href: "/providers", label: "Providers & Keys", icon: IconPlug },
      { href: "/routing", label: "Routing", icon: IconShuffle },
      { href: "/approvals", label: "Approvals", icon: IconGavel },
      { href: "/connectors", label: "Connectors", icon: IconPlug },
      { href: "/audit", label: "Audit log", icon: IconReceipt },
    ],
  },
  {
    label: "Value",
    items: [
      { href: "/cost-attribution", label: "Cost Attribution", icon: IconTag },
      { href: "/cost-centers", label: "Cost Centers", icon: IconDatabase },
      { href: "/chargebacks", label: "Chargebacks", icon: IconReceipt },
      { href: "/unit-economics", label: "Unit Economics", icon: IconRuler },
      { href: "/reconciliation", label: "Reconciliation", icon: IconPuzzle },
    ],
  },
  {
    label: "Plan",
    items: [
      { href: "/forecasting", label: "Forecasting", icon: IconTrendingUp },
      { href: "/roi", label: "ROI Dashboard", icon: IconTarget },
      { href: "/model-comparison", label: "Model Comparison", icon: IconColumns },
      { href: "/benchmark", label: "Benchmarking", icon: IconChart },
      { href: "/simulator", label: "Simulator", icon: IconFlask },
      { href: "/board-reports", label: "Board Reports", icon: IconPresentation },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/team", label: "Team", icon: IconUsers },
      { href: "/settings", label: "Settings", icon: IconGear },
    ],
  },
];

// Pages outside the core cost-visibility / governance / routing scope stay in the
// codebase but are hidden from navigation unless NEXT_PUBLIC_EXPERIMENTAL=1.
const EXPERIMENTAL_HREFS = new Set(["/roi", "/board-reports", "/benchmark", "/simulator"]);
const SHOW_EXPERIMENTAL = process.env.NEXT_PUBLIC_EXPERIMENTAL === "1";

export const NAV_GROUPS: NavGroup[] = ALL_NAV_GROUPS
  .map((g) => ({ ...g, items: g.items.filter((i) => SHOW_EXPERIMENTAL || !EXPERIMENTAL_HREFS.has(i.href)) }))
  .filter((g) => g.items.length > 0);

export const SECTION_META: Record<string, { title: string; kicker: string; desc: string }> = {
  "/": { title: "Overview", kicker: "Monitor", desc: "Is everything okay? Spend, budget health, and alerts at a glance." },
  "/usage": { title: "Usage", kicker: "Monitor", desc: "Every request — filterable, sortable, exportable. The drill-down when Overview raises a question." },
  "/requests": { title: "Request history", kicker: "Monitor", desc: "Every request through the gateway, with cost, tokens, latency and outcome." },
  "/alerts": { title: "Alerts", kicker: "Monitor", desc: "Budget warnings and breaches, and where they were sent." },
  "/shadow-ai": { title: "Shadow AI", kicker: "Monitor", desc: "Unauthorized usage detected via expense & card integrations." },
  "/budgets": { title: "Budgets", kicker: "Control", desc: "Set limits, see status, get warned before they're blown." },
  "/governance": { title: "Governance & Policies", kicker: "Control", desc: "Control what's allowed to run, and prove it after the fact." },
  "/providers": { title: "Providers & Keys", kicker: "Control", desc: "Connect and manage every AI provider this workspace uses, and the keys behind them." },
  "/approvals": { title: "Approvals", kicker: "Control", desc: "Requests held by policy until someone signs off." },
  "/connectors": { title: "Connectors", kicker: "Control", desc: "Link GitHub, Jira, Slack, Linear, Analytics, Salesforce and CI/CD to attribute spend to real work." },
  "/audit": { title: "Audit log", kicker: "Control", desc: "Immutable record of admin actions and automated decisions." },
  "/routing": { title: "Routing", kicker: "Control", desc: "Configure how requests get directed across models and providers." },
  "/cost-attribution": { title: "Cost Attribution", kicker: "Value", desc: "Connect spend to the product features and initiatives actually driving it." },
  "/cost-centers": { title: "Cost Centers", kicker: "Value", desc: "Spend broken down by cost center, month over month." },
  "/chargebacks": { title: "Chargebacks", kicker: "Value", desc: "Turn spend into an internal billing / allocation artifact." },
  "/unit-economics": { title: "Unit Economics", kicker: "Value", desc: "What does this actually cost per outcome?" },
  "/reconciliation": { title: "Invoice Reconciliation", kicker: "Value", desc: "Match provider invoices against calculated gateway spend." },
  "/forecasting": { title: "Forecasting", kicker: "Plan", desc: "Project what's coming, not just report what happened." },
  "/roi": { title: "ROI Dashboard", kicker: "Plan", desc: "Is a given AI initiative actually worth what it costs?" },
  "/model-comparison": { title: "Model Comparison", kicker: "Plan", desc: "Should we be using a different model or provider for this task?" },
  "/benchmark": { title: "Benchmarking", kicker: "Plan", desc: "Score models and providers against your own eval set." },
  "/simulator": { title: "Simulator", kicker: "Plan", desc: "What would happen if we changed something?" },
  "/board-reports": { title: "Board Reports", kicker: "Plan", desc: "Package the workspace into something presentable outside the engineering org." },
  "/team": { title: "Team", kicker: "Workspace", desc: "Members, roles, and per-member spend." },
  "/settings": { title: "Settings", kicker: "Workspace", desc: "Everything about how this workspace is configured." },
  "/onboarding": { title: "Get started", kicker: "Setup", desc: "From zero to your first real request." },
};
