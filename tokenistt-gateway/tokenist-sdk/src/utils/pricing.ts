// Provider-specific pricing (per 1M tokens)
// This is used when the API doesn't return actual_cost

export const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI Models
  'gpt-4': { input: 30.00, output: 60.00 },
  'gpt-4-32k': { input: 60.00, output: 120.00 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'gpt-3.5-turbo-16k': { input: 1.00, output: 2.00 },
  
  // Anthropic Models
  'claude-3-opus': { input: 15.00, output: 75.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-2.1': { input: 8.00, output: 24.00 },
  'claude-2.0': { input: 8.00, output: 24.00 },
  'claude-instant': { input: 0.80, output: 2.40 },
  
  // Default
  'default': { input: 3.00, output: 15.00 },
};

export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const modelKey = model.toLowerCase();
  const pricing = PRICING[modelKey] || PRICING['default'];
  
  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

export function estimateCost(
  model: string,
  maxTokens: number = 1000,
  inputEstimate: number = 500
): number {
  const modelKey = model.toLowerCase();
  const pricing = PRICING[modelKey] || PRICING['default'];
  
  const inputCost = (inputEstimate / 1_000_000) * pricing.input;
  const outputCost = (maxTokens / 1_000_000) * pricing.output;
  
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
