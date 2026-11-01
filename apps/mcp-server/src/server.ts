import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dash, listModels, findModel, estimateUsd, text, fail } from "./api";
import { GATEWAY_URL, GATEWAY_API_KEY } from "./config";

const usd = (n: number, d = 2) => `$${Number(n).toFixed(d)}`;

/**
 * Tokenistt MCP server. Every tool reads live data from your running Tokenistt stack; when the stack
 * is unreachable the tool returns an error — it never substitutes made-up numbers.
 */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "tokenistt", version: "1.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  server.tool(
    "get_spend_summary",
    "AI spend, request count and per-provider breakdown for this month.",
    {},
    async () => {
      try {
        const d = await dash("/api/summary", { period: "month" });
        return text(
          [
            "Tokenistt spend summary (this month)",
            `• Total spend: ${usd(d.total_spend_usd, 4)}`,
            `• Requests: ${(d.total_requests ?? 0).toLocaleString()}`,
            `• Avg latency: ${d.avg_latency_ms ?? 0} ms`,
            `• Top provider: ${d.top_provider}`,
            ...(d.breakdown ?? []).map((p: any) => `  - ${p.provider}: ${usd(p.spend_usd ?? 0, 4)}`),
          ].join("\n"),
          d
        );
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "check_budget_status",
    "Budgets with current spend, percent used and status.",
    { name_contains: z.string().optional().describe("Optional filter on budget name") },
    async ({ name_contains }) => {
      try {
        const d = await dash("/api/budgets");
        let list: any[] = d.budgets ?? [];
        if (name_contains) list = list.filter((b) => String(b.name).toLowerCase().includes(name_contains.toLowerCase()));
        if (list.length === 0) return text("No budgets are configured. Add one in the dashboard under Budgets.");
        return text(
          ["Budget status", ...list.map((b) => `• ${b.name}: ${usd(b.spend_usd ?? 0)} / ${usd(b.budget_usd ?? b.cap_usd ?? 0)} (${b.percent_used ?? 0}% used) [${String(b.status ?? "").toUpperCase()}]`)].join("\n"),
          list
        );
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "estimate_prompt_cost",
    "Projected USD cost for a model and token counts, from the live price catalog.",
    {
      model: z.string().describe("e.g. gpt-4o or anthropic:claude-3-5-sonnet"),
      input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
    },
    async ({ model, input_tokens, output_tokens }) => {
      try {
        const m = findModel(await listModels(), model);
        const cost = m ? estimateUsd(m, input_tokens, output_tokens) : null;
        if (!m || cost == null) return fail(`No price on record for "${model}". Tokenistt does not guess prices; add it to the catalog first.`);
        return text(
          [`Cost estimate for ${m.provider}:${m.model}`, `• Input: ${input_tokens.toLocaleString()} tokens @ $${m.input_per_1m}/1M`, `• Output: ${output_tokens.toLocaleString()} tokens @ $${m.output_per_1m}/1M`, `• Estimated total: ${usd(cost, 6)}`].join("\n"),
          { provider: m.provider, model: m.model, input_tokens, output_tokens, estimated_cost_usd: cost }
        );
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "detect_anomalies",
    "Recent cost spikes against each actor's baseline.",
    { period: z.enum(["24h", "7d"]).default("7d"), min_ratio: z.number().optional() },
    async ({ period, min_ratio }) => {
      try {
        const d = await dash("/api/anomalies", { period });
        let list: any[] = d.anomalies ?? [];
        if (min_ratio) list = list.filter((a) => a.ratio >= min_ratio);
        if (list.length === 0) return text(`No anomalies in the last ${period}.`);
        return text(
          [`${list.length} anomal${list.length === 1 ? "y" : "ies"} in the last ${period}`, ...list.map((a) => `• [${String(a.severity).toUpperCase()}] ${a.actor} (${a.costCenter}): ${usd(a.spend24hUsd)}/24h, ${a.ratio}× baseline`)].join("\n"),
          list
        );
      } catch (e) { return fail(e); }
    }
  );

  server.tool("list_cost_centers", "Cost centers with attributed spend this month.", {}, async () => {
    try {
      const list: any[] = await dash("/api/cost-centers");
      if (!Array.isArray(list) || list.length === 0) return text("No cost centers found yet.");
      return text(
        [`Cost centers (${list.length})`, ...list.map((c) => `• ${c.name} (${c.code}): ${usd(c.spendUsd ?? 0)} MTD`)].join("\n"),
        list
      );
    } catch (e) { return fail(e); }
  });

  server.tool("get_team_spend", "Spend per team member this month.", {}, async () => {
    try {
      const d = await dash("/api/team");
      const members: any[] = d.members ?? [];
      if (members.length === 0) return text("No team activity recorded yet.");
      return text(
        [`Team spend (${members.length} members)`, ...members.map((m) => `• ${m.name} (${m.role}): ${usd(m.spendUsd ?? 0)} across ${(m.calls ?? 0).toLocaleString()} calls`)].join("\n"),
        members
      );
    } catch (e) { return fail(e); }
  });

  server.tool(
    "compare_models",
    "Compare price (catalog) and observed latency/cost (your last 30 days) for several models.",
    {
      models: z.array(z.string()).min(1).describe("e.g. ['gpt-4o', 'gpt-4o-mini']"),
      input_tokens: z.number().int().min(0).default(1000),
      output_tokens: z.number().int().min(0).default(300),
    },
    async ({ models, input_tokens, output_tokens }) => {
      try {
        const catalog = await listModels();
        const rows = models.map((name) => {
          const m = findModel(catalog, name);
          return m
            ? { model: `${m.provider}:${m.model}`, est_cost_usd: estimateUsd(m, input_tokens, output_tokens), observed_avg_cost_usd: m.avg_cost_usd, observed_avg_latency_ms: m.avg_latency_ms, observed_error_rate: m.error_rate, requests_30d: m.requests }
            : { model: name, est_cost_usd: null as number | null, observed_avg_latency_ms: null as number | null, error: "not in catalog" };
        });
        const lines = rows.map((r) => `• ${r.model}: ${r.est_cost_usd == null ? "price unknown" : usd(r.est_cost_usd, 6)}/req${r.observed_avg_latency_ms != null ? `, ${Math.round(r.observed_avg_latency_ms)} ms avg observed` : ""}`);
        return text([`Model comparison (${input_tokens} in / ${output_tokens} out tokens)`, ...lines].join("\n"), rows);
      } catch (e) { return fail(e); }
    }
  );

  server.tool(
    "route_prompt",
    "Send a prompt through the Tokenistt gateway using the cheapest priced model that fits your limit. Requires TOKENISTT_API_KEY.",
    {
      prompt: z.string(),
      models: z.array(z.string()).optional().describe("Candidate models; defaults to every priced model"),
      max_cost_usd: z.number().positive().optional().describe("Skip models whose estimated cost exceeds this"),
      user: z.string().optional().describe("Attribution id"),
    },
    async ({ prompt, models, max_cost_usd, user }) => {
      try {
        if (!GATEWAY_API_KEY) return fail("route_prompt needs TOKENISTT_API_KEY (a Tokenistt virtual key) in the MCP server environment.");
        const catalog = await listModels();
        const inTok = Math.max(1, Math.round(prompt.length / 4));
        const pool = (models?.length ? models.map((n) => findModel(catalog, n)) : catalog)
          .filter((m): m is NonNullable<typeof m> => !!m && estimateUsd(m, inTok, 300) != null)
          .filter((m) => max_cost_usd == null || estimateUsd(m, inTok, 300)! <= max_cost_usd)
          .sort((a, b) => estimateUsd(a, inTok, 300)! - estimateUsd(b, inTok, 300)!);
        if (pool.length === 0) return fail("No priced model satisfies those constraints.");
        const pick = pool[0];
        const t0 = Date.now();
        const res = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_API_KEY}` },
          body: JSON.stringify({ model: `${pick.provider}:${pick.model}`, messages: [{ role: "user", content: prompt }], user }),
          signal: AbortSignal.timeout(60_000),
        });
        const body: any = await res.json().catch(() => ({}));
        if (!res.ok) return fail(`Gateway returned HTTP ${res.status}: ${body?.error?.message ?? "request failed"}`);
        return text(body?.choices?.[0]?.message?.content ?? "", {
          routed_to: `${pick.provider}:${pick.model}`,
          estimated_cost_usd: estimateUsd(pick, inTok, 300),
          actual_cost_usd: body.actual_cost ?? null,
          latency_ms: Date.now() - t0,
        });
      } catch (e) { return fail(e); }
    }
  );

  server.resource(
    "spend_report",
    new ResourceTemplate("spend_report://{user}/daily", { list: undefined }),
    async (uri, vars) => {
      const user = String(vars.user ?? "");
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const d = await dash("/api/gateway/requests", { actor: user, since: since.toISOString(), limit: "500" });
      const rows: any[] = d.data ?? [];
      const report = {
        user,
        since: since.toISOString(),
        requests: rows.length,
        spend_usd: Number(rows.reduce((n, r) => n + Number(r.cost_usd), 0).toFixed(6)),
        truncated: d.next_before != null,
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report, null, 2) }] };
    }
  );

  server.prompt(
    "optimize_cost",
    "Review a conversation and recommend cheaper models, grounded in your live price catalog.",
    { conversation: z.string().optional() },
    async ({ conversation }) => {
      let catalogLines = "(price catalog unavailable)";
      try {
        catalogLines = (await listModels())
          .filter((m) => m.input_per_1m != null)
          .sort((a, b) => a.input_per_1m! - b.input_per_1m!)
          .map((m) => `- ${m.provider}:${m.model} ($${m.input_per_1m}/1M in, $${m.output_per_1m}/1M out)`)
          .join("\n");
      } catch { /* the prompt is still useful without it */ }
      const body = `You are a FinOps assistant. Available models and prices, cheapest first:\n${catalogLines}\n\nReview the conversation below. Flag turns that used an expensive model for work a cheaper one could do, and suggest specific swaps with the estimated saving. Say when you cannot judge quality.`;
      return { messages: [{ role: "user", content: { type: "text", text: conversation ? `${body}\n\n--- CONVERSATION ---\n${conversation}` : body } }] };
    }
  );

  return server;
}
