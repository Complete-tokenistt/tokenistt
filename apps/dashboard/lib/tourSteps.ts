import { NAV_GROUPS } from "./navConfig";
import type { TourStep } from "@/components/Tour";

const GROUP_COPY: Record<string, string> = {
  Monitor: 'Start here every day. Overview answers "is everything okay?" at a glance. Usage is the drill-down for when it raises a question — every request, filterable and exportable to CSV.',
  Control: "Where you set the rules: budget caps with soft/hard enforcement, governance policies with a full audit trail, which providers are connected, and how traffic routes between models.",
  Value: "Connects raw spend to what actually drove it — cost by product feature, chargebacks to cost centers, and cost per outcome (per conversation, per ticket, etc).",
  Plan: "Forward-looking: forecasts, ROI per initiative, side-by-side model comparisons, what-if scenarios, and reports built for people outside engineering.",
  Workspace: "Members and roles, and everything about how this workspace is configured.",
};

export function buildTourSteps(): TourStep[] {
  const steps: TourStep[] = [
    {
      target: null,
      title: "Welcome to Tokenistt",
      body: "Quick tour of the dashboard — where things live and why. Takes about a minute. Skip anytime.",
    },
    {
      target: '[data-tour="tour-crumb"]',
      title: "Where you are",
      body: "Your workspace name and the current page.",
    },
    {
      target: '[data-tour="tour-search"]',
      title: "Search",
      body: "Jump to requests, keys, or teams by name once your workspace has real data.",
    },
    {
      target: '[data-tour="tour-getstarted"]',
      title: "Get started",
      body: "The setup flow: connect a provider, grab your Tokenistt API key, and send your first real request.",
    },
    {
      target: '[data-tour="tour-theme"]',
      title: "Light / dark",
      body: "Toggles just the dashboard theme. Your choice is remembered next time you visit.",
    },
  ];

  NAV_GROUPS.forEach((g) => {
    steps.push({
      target: `[data-tour="tour-group-${g.label}"]`,
      title: g.label,
      body: `${GROUP_COPY[g.label] || ""} Pages: ${g.items.map((i) => i.label).join(" · ")}.`,
    });
  });

  steps.push({
    target: '[data-tour="tour-plancard"]',
    title: "You're set",
    body: "Governance, providers, cost centers, reconciliation, shadow AI, team, benchmark, and settings are live and DB-backed. The rest run on local preview data until wired up.",
  });

  return steps;
}
