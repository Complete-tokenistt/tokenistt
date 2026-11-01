import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest, unauthorizedResponse } from "@/lib/auth";

const GATEWAY = (process.env.GATEWAY_URL || process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:3000").replace(/\/+$/, "");

// A cheap, well-known model per provider for the "send a test request" step.
const TEST_MODEL: Record<string, string> = {
  mock: "mock:echo",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku",
  groq: "groq:llama-3.3-70b-versatile",
  gemini: "gemini-2.0-flash",
  together: "together:meta-llama/Llama-3.3-70B-Instruct-Turbo",
};

/** GET → which providers the gateway can currently reach, and a suggested test model for each. */
export async function GET(req: NextRequest) {
  if (!getSessionFromRequest(req)) return unauthorizedResponse();
  try {
    const res = await fetch(`${GATEWAY}/v1/providers`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    const providers = (body.providers ?? [])
      .filter((p: any) => p.available && TEST_MODEL[p.name])
      .map((p: any) => ({ provider: p.name, model: TEST_MODEL[p.name] }));
    // The URL a developer's tools should use (differs from GATEWAY_URL, which is the in-network address).
    return NextResponse.json({ providers, gateway_url: process.env.PUBLIC_GATEWAY_URL || "http://localhost:3000" });
  } catch {
    return NextResponse.json({ error: { message: `Gateway unreachable at ${GATEWAY}.` } }, { status: 502 });
  }
}

/** POST { virtualKey, model, prompt? } → sends one real request through the gateway and reports what it measured. */
export async function POST(req: NextRequest) {
  if (!getSessionFromRequest(req)) return unauthorizedResponse();
  const { virtualKey, model, prompt } = await req.json().catch(() => ({}));
  if (typeof virtualKey !== "string" || !virtualKey.startsWith("tktt_") || virtualKey.includes("...")) {
    return NextResponse.json({ success: false, error: "Paste a full Tokenistt API key (it is shown only once, when created)." }, { status: 400 });
  }
  if (typeof model !== "string" || !model) {
    return NextResponse.json({ success: false, error: "model is required" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${virtualKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: typeof prompt === "string" && prompt ? prompt : "Say hello in five words." }],
        max_tokens: 40,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: data?.error?.message ?? `Gateway returned HTTP ${res.status}`, status: res.status },
        { status: res.status }
      );
    }
    return NextResponse.json({
      success: true,
      model: data.model ?? model,
      provider: res.headers.get("x-tokenistt-provider"),
      content: data.choices?.[0]?.message?.content ?? "",
      prompt_tokens: data.usage?.prompt_tokens ?? null,
      completion_tokens: data.usage?.completion_tokens ?? null,
      cost_usd: res.headers.has("x-tokenistt-cost") ? Number(res.headers.get("x-tokenistt-cost")) : null,
      cost_status: res.headers.get("x-tokenistt-cost-status"),
      latency_ms: Date.now() - started,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: `Gateway unreachable at ${GATEWAY} (${e.message}).` }, { status: 502 });
  }
}
