import { PricingTier } from '../types/index.js';

// Pricing map (per 1M tokens in USD)
export const PRICING: Record<string, PricingTier> = {
  // OpenAI Models
  'openai:gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'openai:gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  'openai:o1': { input: 15.00, output: 60.00, cachedInput: 7.50 },
  'openai:o1-mini': { input: 3.00, output: 12.00, cachedInput: 1.50 },
  'openai:o3-mini': { input: 1.10, output: 4.40, cachedInput: 0.55 },
  'openai:gpt-4': { input: 30.00, output: 60.00 },
  'openai:gpt-4-32k': { input: 60.00, output: 120.00 },
  'openai:gpt-4-turbo': { input: 10.00, output: 30.00 },
  'openai:gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'openai:gpt-3.5-turbo-16k': { input: 1.00, output: 2.00 },
  
  // Anthropic Models
  'anthropic:claude-3-5-sonnet': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'anthropic:claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'anthropic:claude-3-5-haiku': { input: 0.80, output: 4.00, cachedInput: 0.08 },
  'anthropic:claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, cachedInput: 0.08 },
  'anthropic:claude-3-opus': { input: 15.00, output: 75.00 },
  'anthropic:claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'anthropic:claude-3-sonnet': { input: 3.00, output: 15.00 },
  'anthropic:claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
  'anthropic:claude-3-haiku': { input: 0.25, output: 1.25 },
  'anthropic:claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  'anthropic:claude-2.1': { input: 8.00, output: 24.00 },
  'anthropic:claude-2.0': { input: 8.00, output: 24.00 },
  'anthropic:claude-instant': { input: 0.80, output: 2.40 },
  
  // AWS Bedrock Models (base pricing, AWS markup added separately)
  'bedrock:claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'bedrock:claude-3-sonnet': { input: 3.00, output: 15.00 },
  'bedrock:claude-3-haiku': { input: 0.25, output: 1.25 },
  'bedrock:claude-3-opus': { input: 15.00, output: 75.00 },
  'bedrock:claude-2.1': { input: 8.00, output: 24.00 },
  'bedrock:claude-2': { input: 8.00, output: 24.00 },
  'bedrock:claude-instant': { input: 0.80, output: 2.40 },
  'bedrock:ai21-j2-mid': { input: 0.60, output: 2.40 },
  'bedrock:ai21-j2-ultra': { input: 1.20, output: 4.80 },
  'bedrock:meta-llama-3-70b': { input: 2.65, output: 3.50 },
  'bedrock:meta-llama-3-8b': { input: 0.22, output: 0.22 },
  'bedrock:mistral-7b': { input: 0.20, output: 0.20 },
  'bedrock:mistral-large': { input: 4.00, output: 12.00 },
  
  // Azure OpenAI (same as OpenAI pricing)
  'azure:gpt-4o': { input: 2.50, output: 10.00 },
  'azure:gpt-4o-mini': { input: 0.15, output: 0.60 },
  'azure:gpt-4': { input: 30.00, output: 60.00 },
  'azure:gpt-4-32k': { input: 60.00, output: 120.00 },
  'azure:gpt-4-turbo': { input: 10.00, output: 30.00 },
  'azure:gpt-35-turbo': { input: 0.50, output: 1.50 },
  'azure:gpt-35-turbo-16k': { input: 1.00, output: 2.00 },
};

// AWS Bedrock additional costs (EC2/Bedrock API costs per token)
const BEDROCK_AWS_MARKUP = {
  input: 0.000008,  // per token
  output: 0.000024, // per token
};

export interface CostCalculationResult {
  cost: number;
  inputCost: number;
  outputCost: number;
  cachedInputCost: number;
  cacheCreationCost: number;
  reasoningCost: number;
  isKnown: boolean;
  costStatus: 'ok' | 'COST_UNAVAILABLE';
}

/**
 * Resolves pricing tier with direct lookup and intelligent prefix/family matching.
 */
export function resolvePricing(provider: string, model: string): PricingTier | null {
  const normProvider = provider.toLowerCase();
  let normModel = model.toLowerCase();

  // Strip provider prefix if passed in model (e.g. "openai:gpt-4o")
  if (normModel.startsWith(`${normProvider}:`)) {
    normModel = normModel.slice(normProvider.length + 1);
  }

  // 1. Exact match
  const directKey = `${normProvider}:${normModel}`;
  if (PRICING[directKey]) {
    return PRICING[directKey];
  }

  // 2. Prefix / Versioned model matching
  const candidates = Object.keys(PRICING).filter(k => k.startsWith(`${normProvider}:`));
  for (const candidate of candidates) {
    const candidateModel = candidate.slice(normProvider.length + 1);
    if (normModel.startsWith(candidateModel) || candidateModel.startsWith(normModel)) {
      return PRICING[candidate];
    }
  }

  return null;
}

export function calculateCostWithStatus(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0,
  cacheCreationTokens = 0,
  reasoningTokens = 0,
  customPricing?: PricingTier | null
): CostCalculationResult {
  const pricing = customPricing || resolvePricing(provider, model);

  if (!pricing) {
    console.warn(`[Pricing] No pricing found for ${provider}:${model.toLowerCase()} — COST_UNAVAILABLE. Cost set to $0.00 (token counts preserved).`);
    // NEVER invent or guess a price. Cost MUST be exactly $0.00.
    // Token counts are kept for analytics purposes only.
    return {
      cost: 0,
      inputCost: 0,
      outputCost: 0,
      cachedInputCost: 0,
      cacheCreationCost: 0,
      reasoningCost: 0,
      isKnown: false,
      costStatus: 'COST_UNAVAILABLE',
    };
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cachedInputCost = pricing.cachedInput 
    ? (cachedTokens / 1_000_000) * pricing.cachedInput 
    : 0;
  const cacheCreationCost = pricing.cacheWrite
    ? (cacheCreationTokens / 1_000_000) * pricing.cacheWrite
    : 0;
  const reasoningCost = pricing.reasoning
    ? (reasoningTokens / 1_000_000) * pricing.reasoning
    : 0;

  let totalCost = inputCost + outputCost + cachedInputCost + cacheCreationCost + reasoningCost;

  // Add AWS Bedrock markup if applicable
  if (provider.toLowerCase() === 'bedrock') {
    const awsMarkupInput = inputTokens * BEDROCK_AWS_MARKUP.input;
    const awsMarkupOutput = outputTokens * BEDROCK_AWS_MARKUP.output;
    totalCost += awsMarkupInput + awsMarkupOutput;
  }

  const rounded = Math.round(totalCost * 1_000_000) / 1_000_000;
  return {
    cost: rounded,
    inputCost: Math.round(inputCost * 1_000_000) / 1_000_000,
    outputCost: Math.round(outputCost * 1_000_000) / 1_000_000,
    cachedInputCost: Math.round(cachedInputCost * 1_000_000) / 1_000_000,
    cacheCreationCost: Math.round(cacheCreationCost * 1_000_000) / 1_000_000,
    reasoningCost: Math.round(reasoningCost * 1_000_000) / 1_000_000,
    isKnown: true,
    costStatus: 'ok',
  };
}

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number {
  return calculateCostWithStatus(provider, model, inputTokens, outputTokens, cachedTokens).cost;
}

// NOTE: calculateDefaultCost() has been intentionally removed.
// Unknown models MUST return cost = $0.00 (COST_UNAVAILABLE).
// Inventing fallback prices violates the FinOps non-negotiable rule: "Tokenistt must never invent a price."

export function getAvailableModels(): Record<string, string[]> {
  return {
    anthropic: [
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'claude-3-opus',
      'claude-3-sonnet',
      'claude-3-haiku',
      'claude-2.1',
      'claude-2.0',
      'claude-instant',
    ],
    bedrock: [
      'claude-3-5-sonnet',
      'claude-3-sonnet',
      'claude-3-haiku',
      'claude-3-opus',
      'claude-2.1',
      'claude-2',
      'claude-instant',
      'ai21.j2-mid',
      'ai21.j2-ultra',
      'meta.llama3-70b-instruct',
      'meta.llama3-8b-instruct',
      'mistral-7b-instruct',
      'mistral-large-2402',
    ],
    azure: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4',
      'gpt-4-32k',
      'gpt-4-turbo',
      'gpt-35-turbo',
      'gpt-35-turbo-16k',
    ],
    openai: [
      'gpt-4o',
      'gpt-4o-mini',
      'o1',
      'o1-mini',
      'o3-mini',
      'gpt-4',
      'gpt-4-32k',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k',
    ],
  };
}
