// Smoke test: boots the built server over stdio and calls every tool against a running stack.
//   npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env as Record<string, string> }));

  console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
  let failed = 0;
  const calls: [string, Record<string, unknown>][] = [
    ["get_spend_summary", {}],
    ["check_budget_status", {}],
    ["estimate_prompt_cost", { model: "gpt-4o", input_tokens: 1000, output_tokens: 500 }],
    ["detect_anomalies", {}],
    ["list_cost_centers", {}],
    ["get_team_spend", {}],
    ["compare_models", { models: ["gpt-4o", "gpt-4o-mini"] }],
  ];
  for (const [name, args] of calls) {
    const r: any = await client.callTool({ name, arguments: args });
    console.log(`${r.isError ? "FAIL" : "ok  "} ${name}: ${String(r.content?.[0]?.text).split("\n")[0]}`);
    if (r.isError) failed++;
  }
  await client.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
