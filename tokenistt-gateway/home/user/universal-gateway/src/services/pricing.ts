import { PricingTier } from '../types/index.js';

// Pricing map (per 1M tokens)
export const PRICING: Record<string, PricingTier> = {
  // OpenAI Models
  'openai:gpt-4': { input: 30.00, output: 60.00 },
  'openai:gpt-4-32k': { input: 60.00, output: 120.00 },
  'openai:gpt-4-turbo': { input: 10.00, output: 30.00 },
  'openai:gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'openai:gpt-3.5-turbo-16k': { input: 1.00, output: 2.00 },
  
  // Anthropic Models
  'anthropic:claude-3-opus': { input: 15.00, output: 75.00 },
  'anthropic:claude-3-sonnet': { input: 3.00, output: 15.00 },
  'anthropic:claude-3-haiku': { input: 0.25, output: 1.25 },
  'anthropic:claude-2.1': { input: 8.00, output: 24.00 },
  'anthropic:claude-2.0': { input: 8.00, output: 24.00 },
  'anthropic:claude-instant': { input: 0.80, output: 2.40 },
  
  // AWS Bedrock Models (base pricing, AWS markup added separately)
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

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const key = `${provider}:${model.toLowerCase()}`;
  const pricing = PRICING[key];
  
  if (!pricing) {
    // Default fallback pricing
    console.warn(`No pricing found for ${key}, using default`);
    return calculateDefaultCost(inputTokens, outputTokens);
  }
  
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  
  let totalCost = inputCost + outputCost;
  
  // Add AWS Bedrock markup if applicable
  if (provider === 'bedrock') {
    const awsMarkupInput = inputTokens * BEDROCK_AWS_MARKUP.input;
    const awsMarkupOutput = outputTokens * BEDROCK_AWS_MARKUP.output;
    totalCost += awsMarkupInput + awsMarkupOutput;
  }
  
  return Math.round(totalCost * 1_000_000) / 1_000_000; // Round to 6 decimal places
}

function calculateDefaultCost(inputTokens: number, outputTokens: number): number {
  // Default: assume $1/M input and $3/M output
  const inputCost = (inputTokens / 1_000_000) * 1.00;
  const outputCost = (outputTokens / 1_000_000) * 3.00;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

export function getAvailableModels(): Record<string, string[]> {
  return {
    anthropic: [
      'claude-3-opus',
      'claude-3-sonnet',
      'claude-3-haiku',
      'claude-2.1',
      'claude-2.0',
      'claude-instant',
    ],
    bedrock: [
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
      'gpt-4',
      'gpt-4-32k',
      'gpt-4-turbo',
      'gpt-35-turbo',
      'gpt-35-turbo-16k',
    ],
    openai: [
      'gpt-4',
      'gpt-4-32k',
      'gpt-4-turbo',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k',
    ],
  };
}
