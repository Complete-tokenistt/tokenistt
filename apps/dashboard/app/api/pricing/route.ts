import { NextResponse } from "next/server";

// Standard model pricing per 1M tokens in USD
const PRICING_CATALOG: Record<string, { input: number; output: number; provider: string }> = {
  "gpt-4o": { input: 2.5, output: 10.0, provider: "openai" },
  "gpt-4o-mini": { input: 0.15, output: 0.6, provider: "openai" },
  "o1": { input: 15.0, output: 60.0, provider: "openai" },
  "o1-mini": { input: 3.0, output: 12.0, provider: "openai" },
  "o3-mini": { input: 1.1, output: 4.4, provider: "openai" },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0, provider: "anthropic" },
  "claude-3-5-haiku": { input: 0.8, output: 4.0, provider: "anthropic" },
  "claude-3-opus": { input: 15.0, output: 75.0, provider: "anthropic" },
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79, provider: "groq" },
  "llama3-8b-8192": { input: 0.05, output: 0.08, provider: "groq" },
  "mistral-small-latest": { input: 0.2, output: 0.6, provider: "mistral" },
  "meta-llama/Llama-3-8b-chat-hf": { input: 0.2, output: 0.2, provider: "together" },
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const model = url.searchParams.get("model");
  const inputTokens = parseInt(url.searchParams.get("input_tokens") || "0", 10);
  const outputTokens = parseInt(url.searchParams.get("output_tokens") || "0", 10);

  if (model) {
    const normalized = model.replace(/^(openai|anthropic|groq|together|bedrock):/, "");
    const tier = PRICING_CATALOG[normalized] || { input: 1.0, output: 3.0, provider: "unknown" };

    const inputCostUsd = (inputTokens / 1_000_000) * tier.input;
    const outputCostUsd = (outputTokens / 1_000_000) * tier.output;
    const totalCostUsd = inputCostUsd + outputCostUsd;

    return NextResponse.json({
      model: normalized,
      provider: tier.provider,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      rates_per_million: {
        input_usd: tier.input,
        output_usd: tier.output,
      },
      estimated_cost_usd: totalCostUsd,
    });
  }

  return NextResponse.json({
    models: Object.entries(PRICING_CATALOG).map(([m, p]) => ({
      model: m,
      provider: p.provider,
      input_per_million_usd: p.input,
      output_per_million_usd: p.output,
    })),
  });
}

