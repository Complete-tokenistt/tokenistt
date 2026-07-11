import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { route } from "./router.js";
import { callGateway } from "./gateway.js";
import { getDailySpend } from "./spend.js";
import { buildOptimizePrompt } from "./optimize.js";

// Builds a fully-wired McpServer (tools + resources + prompts). A fresh server
// is created per connection for SSE (stateful per session); for stdio a single
// instance is used.
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "tokenistt-finops", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // ---- Tool: route_prompt ----
  server.tool(
    "route_prompt",
    "Route a prompt to the optimal model (cost/quality aware) and return the completion.",
    {
      prompt: z.string().describe("The user prompt to send"),
      user: z.string().optional().describe("Attribution user id"),
      maxCostUsd: z.number().optional().describe("Max USD per request"),
      preferQuality: z.boolean().optional().describe("Optimize for quality over cost"),
    } as any,
    async ({ prompt, user, maxCostUsd, preferQuality }: any) => {
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
            note: "No GATEWAY_URL configured; returning routing decision only.",
          };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );

  // ---- Resource: spend_report://{user}/daily ----
  server.resource(
    "spend_report",
    new ResourceTemplate("spend_report://{user}/daily", {} as any),
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
    },
  );

  // ---- Prompt: optimize_cost ----
  server.prompt(
    "optimize_cost",
    "Analyze the last conversation and suggest a cheaper model.",
    {
      conversation: z
        .string()
        .optional()
        .describe("Optional transcript of the last conversation"),
    } as any,
    async ({ conversation }: any) => {
      const text = buildOptimizePrompt(conversation);
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    },
  );

  return server;
}
