import { CATALOG } from "./catalog";

// Builds the `optimize_cost` prompt: review a conversation and suggest a
// cheaper model, grounded in the current model catalog.
export function buildOptimizePrompt(conversation?: string): string {
  const cheap = [...CATALOG]
    .sort((a, b) => a.costPerRequest - b.costPerRequest)
    .map((m) => `${m.label} ($${m.costPerRequest.toFixed(4)}/req, quality ${m.quality}/10)`);

  const base = `You are a FinOps cost-optimization assistant for an AI gateway.
Available models (cheapest first):
- ${cheap.join("\n- ")}

Review the conversation below. Identify turns that used expensive models
(e.g. o1 / GPT-4o) for tasks a cheaper model (GPT-4o-mini / Haiku) could handle,
and recommend specific model swaps with estimated savings.`;

  return conversation
    ? `${base}\n\n--- CONVERSATION ---\n${conversation}`
    : `${base}\n\n(No conversation provided — analyze the user's recent gateway usage instead.)`;
}
