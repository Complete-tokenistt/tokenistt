import { GATEWAY_URL, GATEWAY_API_KEY } from "./config";

export interface GatewayCallResult {
  response: string;
  costUsd: number;
  latencyMs: number;
}

// Sends the prompt to the selected model via the Tokenistt gateway
// (OpenAI-compatible endpoint). Returns null if no gateway is configured or the
// call fails — the MCP tool then returns the routing decision alone.
export async function callGateway(
  model: string,
  prompt: string,
  user?: string,
): Promise<GatewayCallResult | null> {
  if (!GATEWAY_URL) return null;
  const t0 = Date.now();
  try {
    const res = await fetch(`${GATEWAY_URL.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        user,
        costCenter: "mcp",
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    const text: string = j?.choices?.[0]?.message?.content ?? "";
    const costUsd: number = j?.usage?.cost ?? 0;
    return { response: text, costUsd, latencyMs: Date.now() - t0 };
  } catch {
    return null;
  }
}
