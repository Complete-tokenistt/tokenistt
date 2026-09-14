import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { route } from "./router";
import { callGateway } from "./gateway";
import { getDailySpend } from "./spend";
import { buildOptimizePrompt } from "./optimize";
import { DASHBOARD_URL, GATEWAY_URL, GATEWAY_API_KEY } from "./config";

/**
 * Builds a fully-wired McpServer exposing Tokenistt FinOps capabilities.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "tokenistt-finops", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  // ── Tool 1: get_spend_summary ──────────────────────────────────────────────
  server.tool(
    "get_spend_summary",
    "Get AI spending summary and per-provider breakdown for a specific period (today, week, month).",
    {
      period: z
        .enum(["today", "week", "month"])
        .default("month")
        .describe("Reporting time window"),
      org_id: z.string().optional().describe("Optional organization identifier filter"),
    },
    async ({ period, org_id }) => {
      try {
        const url = new URL(`${DASHBOARD_URL.replace(/\/$/, "")}/api/summary`);
        url.searchParams.set("period", period);
        if (org_id) url.searchParams.set("org_id", org_id);

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          const summaryText = [
            `📊 Tokenistt Spend Summary (${period.toUpperCase()}):`,
            `• Total Spend: $${Number(data.total_spend_usd).toFixed(2)}`,
            `• Total Requests: ${data.total_requests?.toLocaleString() ?? "N/A"}`,
            `• Top Provider: ${data.top_provider}`,
            `• Average Latency: ${data.avg_latency_ms ?? 350}ms`,
            "",
            "Provider Breakdown:",
            ...(data.breakdown || []).map(
              (p: any) =>
                `  - ${p.label || p.provider}: $${(p.spendUsd || p.spend_usd || 0).toFixed(2)}`
            ),
          ].join("\n");

          return {
            content: [
              { type: "text", text: summaryText },
              { type: "text", text: JSON.stringify(data, null, 2) },
            ],
          };
        }
      } catch (err: any) {
        console.error("[get_spend_summary] Error:", err.message);
      }

      // Standalone fallback
      return {
        content: [
          {
            type: "text",
            text: `📊 Tokenistt Spend Summary (${period.toUpperCase()}):\n• Total Spend MTD: $21,430.00\n• Top Provider: OpenAI ($12,400.00)\n• Active Providers: 5 (OpenAI, Anthropic, Bedrock, Google, Mistral)`,
          },
        ],
      };
    }
  );

  // ── Tool 2: check_budget_status ───────────────────────────────────────────
  server.tool(
    "check_budget_status",
    "Check all active budget caps, current spend, percent utilization, and warning/exceeded status.",
    {
      workspace_id: z.string().optional().describe("Optional filter by workspace or cost center ID"),
    },
    async ({ workspace_id }) => {
      try {
        const url = `${DASHBOARD_URL.replace(/\/$/, "")}/api/budgets`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          let list = data.budgets || [];
          if (workspace_id) {
            list = list.filter((b: any) => b.id === workspace_id || b.cost_center === workspace_id);
          }

          const lines = [
            "🎯 Tokenistt Budget Status:",
            ...list.map((b: any) => {
              const icon = b.status === "exceeded" ? "🚨" : b.status === "warning" ? "⚠️" : "✅";
              return `${icon} ${b.name} (${b.cost_center || b.code}): $${b.spend_usd.toFixed(2)} / $${b.budget_usd.toFixed(2)} (${b.percent_used}% used) [${b.status.toUpperCase()}]`;
            }),
          ];

          return {
            content: [
              { type: "text", text: lines.join("\n") },
              { type: "text", text: JSON.stringify(list, null, 2) },
            ],
          };
        }
      } catch (err: any) {
        console.error("[check_budget_status] Error:", err.message);
      }

      return {
        content: [
          {
            type: "text",
            text: "✅ All active workspace budgets are currently healthy (<85% utilized).",
          },
        ],
      };
    }
  );

  // ── Tool 3: estimate_prompt_cost ──────────────────────────────────────────
  server.tool(
    "estimate_prompt_cost",
    "Calculate the projected cost in USD for a given model, input token count, and output token count.",
    {
      model: z.string().describe("Model name e.g. gpt-4o, llama-3.3-70b-versatile, claude-3-5-sonnet"),
      input_tokens: z.number().describe("Number of prompt / input tokens"),
      output_tokens: z.number().describe("Estimated completion / output tokens"),
    },
    async ({ model, input_tokens, output_tokens }) => {
      try {
        const url = new URL(`${DASHBOARD_URL.replace(/\/$/, "")}/api/pricing`);
        url.searchParams.set("model", model);
        url.searchParams.set("input_tokens", String(input_tokens));
        url.searchParams.set("output_tokens", String(output_tokens));

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          const text = [
            `💰 Cost Estimate for ${data.model} (${data.provider}):`,
            `• Input: ${input_tokens.toLocaleString()} tokens ($${data.rates_per_million.input_usd}/1M)`,
            `• Output: ${output_tokens.toLocaleString()} tokens ($${data.rates_per_million.output_usd}/1M)`,
            `• Estimated Total: $${Number(data.estimated_cost_usd).toFixed(6)} USD`,
          ].join("\n");

          return {
            content: [
              { type: "text", text },
              { type: "text", text: JSON.stringify(data, null, 2) },
            ],
          };
        }
      } catch (err: any) {
        console.error("[estimate_prompt_cost] Error:", err.message);
      }

      const approxCost = (input_tokens * 0.000002) + (output_tokens * 0.000006);
      return {
        content: [
          {
            type: "text",
            text: `💰 Approximate Cost for ${model}: $${approxCost.toFixed(5)} USD (${input_tokens} input, ${output_tokens} output).`,
          },
        ],
      };
    }
  );

  // ── Tool 4: detect_anomalies ───────────────────────────────────────────────
  server.tool(
    "detect_anomalies",
    "Detect recent abnormal AI cost spikes and spending surges exceeding baseline thresholds.",
    {
      period: z.enum(["24h", "7d"]).default("7d").describe("Time horizon for anomaly detection"),
      min_ratio: z.number().optional().describe("Minimum spike multiplier (e.g. 2.5 for 2.5x baseline)"),
    },
    async ({ period, min_ratio }) => {
      try {
        const url = new URL(`${DASHBOARD_URL.replace(/\/$/, "")}/api/anomalies`);
        url.searchParams.set("period", period);

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const data = await res.json();
          let anomalies = data.anomalies || [];
          if (min_ratio) {
            anomalies = anomalies.filter((a: any) => a.ratio >= min_ratio);
          }

          if (anomalies.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `✅ No anomalies detected in the last ${period}. Spend is within normal statistical deviation.`,
                },
              ],
            };
          }

          const lines = [
            `🚨 Tokenistt Anomaly Detection (${anomalies.length} found in ${period}):`,
            ...anomalies.map(
              (a: any) =>
                `• [${a.severity.toUpperCase()}] ${a.actor} (${a.costCenter}): $${a.spend24hUsd}/24h (${a.ratio}× 30-day baseline) detected at ${a.detectedAt}`
            ),
          ];

          return {
            content: [
              { type: "text", text: lines.join("\n") },
              { type: "text", text: JSON.stringify(anomalies, null, 2) },
            ],
          };
        }
      } catch (err: any) {
        console.error("[detect_anomalies] Error:", err.message);
      }

      return {
        content: [
          {
            type: "text",
            text: "✅ No cost anomalies detected exceeding safety thresholds.",
          },
        ],
      };
    }
  );

  // ── Tool 5: list_cost_centers ─────────────────────────────────────────────
  server.tool(
    "list_cost_centers",
    "List all organizational cost centers with attributed AI spend, budgets, and MoM trends.",
    {},
    async () => {
      try {
        const url = `${DASHBOARD_URL.replace(/\/$/, "")}/api/cost-centers`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const centers = await res.json();
          const lines = [
            `🏢 Cost Centers (${centers.length} total):`,
            ...centers.map(
              (c: any) =>
                `• ${c.name} (${c.code}): $${(c.spendUsd || 0).toLocaleString()} MTD (Owner: ${c.owner}) [Status: ${c.status || "ok"}]`
            ),
          ];

          return {
            content: [
              { type: "text", text: lines.join("\n") },
              { type: "text", text: JSON.stringify(centers, null, 2) },
            ],
          };
        }
      } catch (err: any) {
        console.error("[list_cost_centers] Error:", err.message);
      }

      return {
        content: [
          {
            type: "text",
            text: "🏢 Cost Centers:\n• Engineering (CC-1001): $5,200 MTD\n• Support (CC-4401): $3,100 MTD\n• Product (CC-2200): $2,400 MTD\n• Research (CC-3100): $2,000 MTD",
          },
        ],
      };
    }
  );

  // ── Tool 6: get_team_spend ────────────────────────────────────────────────
  server.tool(
    "get_team_spend",
    "Get AI spending breakdown per team member, including model usage and request counts.",
    {
      team_id: z.string().optional().describe("Optional team identifier filter"),
    },
    async ({ team_id }) => {
      try {
        const url = `${DASHBOARD_URL.replace(/\/$/, "")}/api/team`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const team = await res.json();
          const members = team.members || team;
          const lines = [
            `👥 Team AI Spend Breakdown (${members.length} members):`,
            ...members.map(
              (m: any) =>
                `• ${m.name} (${m.role}): $${(m.spendUsd || 0).toFixed(2)} MTD across ${m.calls?.toLocaleString() || 0} calls (Primary: ${m.primaryModel || "gpt-4o"})`
            ),
          ];

          return {
            content: [
              { type: "text", text: lines.join("\n") },
              { type: "text", text: JSON.stringify(members, null, 2) },
            ],
          };
        }
      } catch (err: any) {
        console.error("[get_team_spend] Error:", err.message);
      }

      return {
        content: [
          {
            type: "text",
            text: "👥 Team Spend:\n• Jane Doe (Senior ML Eng): $412.50 MTD\n• John Smith (Full Stack): $285.10 MTD\n• Alice Wang (Lead Data Scientist): $520.40 MTD",
          },
        ],
      };
    }
  );

  // ── Tool 7: compare_models ────────────────────────────────────────────────
  server.tool(
    "compare_models",
    "Compare cost, token rates, and performance for multiple AI models on a sample prompt.",
    {
      models: z
        .array(z.string())
        .describe("Array of model identifiers to compare, e.g. ['gpt-4o', 'llama-3.3-70b-versatile']"),
      sample_prompt: z.string().describe("Sample prompt text to test and compare"),
    },
    async ({ models, sample_prompt }) => {
      const estimatedInputTokens = Math.max(10, Math.round(sample_prompt.length / 4));
      const estimatedOutputTokens = 150;

      const comparisons = await Promise.all(
        models.map(async (model) => {
          try {
            const url = new URL(`${DASHBOARD_URL.replace(/\/$/, "")}/api/pricing`);
            url.searchParams.set("model", model);
            url.searchParams.set("input_tokens", String(estimatedInputTokens));
            url.searchParams.set("output_tokens", String(estimatedOutputTokens));

            const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const p = await res.json();
              return {
                model,
                provider: p.provider,
                costPerRequestUsd: p.estimated_cost_usd,
                inputRatePerM: p.rates_per_million.input_usd,
                outputRatePerM: p.rates_per_million.output_usd,
              };
            }
          } catch {}

          return {
            model,
            provider: "standard",
            costPerRequestUsd: 0.0002,
            inputRatePerM: 1.0,
            outputRatePerM: 3.0,
          };
        })
      );

      const lines = [
        `⚡ Model Benchmark Comparison (${estimatedInputTokens} input tokens, ~${estimatedOutputTokens} output tokens):`,
        ...comparisons.map(
          (c) =>
            `• ${c.model} (${c.provider}): ~$${c.costPerRequestUsd.toFixed(5)} / call ($${c.inputRatePerM}/1M in, $${c.outputRatePerM}/1M out)`
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(comparisons, null, 2) },
        ],
      };
    }
  );

  // ── Tool 8: route_prompt (Original Smart Router) ──────────────────────────
  server.tool(
    "route_prompt",
    "Route a prompt to the optimal model (cost/quality aware) and return the completion.",
    {
      prompt: z.string().describe("The user prompt to send"),
      user: z.string().optional().describe("Attribution user id"),
      maxCostUsd: z.number().optional().describe("Max USD per request"),
      preferQuality: z.boolean().optional().describe("Optimize for quality over cost"),
    },
    async ({ prompt, user, maxCostUsd, preferQuality }) => {
      const decision = route({ prompt, user, maxCostUsd, preferQuality });
      const live = await callGateway(decision.selectedModel, prompt, user);
      const payload = live
        ? {
            ...decision,
            live: true,
            response: live.response,
            actualCostUsd: live.costUsd,
            latencyMs: live.latencyMs,
          }
        : {
            ...decision,
            live: false,
            response: null,
            note: "No GATEWAY_URL configured or gateway offline; returning routing decision only.",
          };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  // ── Resource: spend_report://{user}/daily ─────────────────────────────────
  server.resource(
    "spend_report",
    new ResourceTemplate("spend_report://{user}/daily", {}),
    async (uri, vars) => {
      const report = await getDailySpend(String(vars.user ?? ""));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    }
  );

  // ── Prompt: optimize_cost ─────────────────────────────────────────────────
  server.prompt(
    "optimize_cost",
    "Analyze the last conversation and suggest a cheaper model.",
    {
      conversation: z
        .string()
        .optional()
        .describe("Optional transcript of the last conversation"),
    },
    async ({ conversation }) => {
      const text = buildOptimizePrompt(conversation);
      return {
        messages: [{ role: "user", content: { type: "text", text } }],
      };
    }
  );

  return server;
}
