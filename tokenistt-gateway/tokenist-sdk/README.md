# @tokenist/sdk

Drop-in OpenAI SDK replacement with built-in FinOps support - budget tracking, cost attribution, and multi-provider routing.

## Features

- **100% OpenAI API Compatible**: Same interface as `openai@4.x`
- **Auto-Retry**: Exponential backoff with configurable retries
- **Cost Tracking**: Built-in callbacks for usage and cost monitoring
- **Budget Warnings**: Get alerts when approaching budget limits
- **Attribution**: Track usage by user and cost center
- **Multi-Provider**: Routes through Universal Gateway to Anthropic, AWS Bedrock, Azure

## Installation

```bash
npm install @tokenist/sdk
```

## Quick Start

```typescript
import { Tokenist } from '@tokenist/sdk';

const client = new Tokenist({
  apiKey: 'tktt_live_acme_jane_abc123def456',
  baseURL: 'http://localhost:3000/v1',
});

const response = await client.chat.completions.create({
  model: 'claude-3-sonnet',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(response.choices[0].message.content);
console.log(`Cost: $${response.actual_cost}`);
console.log(`Provider: ${response.provider}`);
```

## Advanced Usage

### Cost Tracking

```typescript
const client = new Tokenist({
  apiKey: 'your-virtual-key',
  onUsage: (usage) => {
    console.log(`Tokens: ${usage.totalTokens}`);
  },
  onCost: (cost) => {
    console.log(`Cost: $${cost.cost.toFixed(6)}`);
  },
});

await client.chat.completions.create({
  model: 'claude-3-sonnet',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

### Budget Warnings

```typescript
const client = new Tokenist({
  apiKey: 'your-virtual-key',
  onBudgetWarning: (warning) => {
    console.warn(`⚠️ Budget Warning for ${warning.userId}`);
    console.warn(`   ${warning.percentageUsed.toFixed(1)}% used`);
    console.warn(`   Remaining: $${warning.budgetRemaining.toFixed(2)}`);
  },
});

// Set budget limits for tracking
client.setBudgetLimit('user_john', 50.00);
```

### User Attribution

```typescript
// Set default attribution for all requests
const client = new Tokenist({
  apiKey: 'your-virtual-key',
  defaultUser: 'alice@company.com',
  defaultCostCenter: 'engineering',
});

// Or override per-request
await client.chat.completions.create({
  model: 'claude-3-sonnet',
  messages: [{ role: 'user', content: 'Hello' }],
  user: 'bob@company.com',           // Override default user
  cost_center: 'marketing',         // Override default cost center
  cost_estimate: 0.005,             // Pre-estimate cost
});
```

### Error Handling

```typescript
import { 
  Tokenist, 
  BudgetExceededError, 
  RateLimitError, 
  AuthenticationError 
} from '@tokenist/sdk';

const client = new Tokenist({
  apiKey: 'your-virtual-key',
  maxRetries: 3,
});

try {
  const response = await client.chat.completions.create({
    model: 'claude-3-sonnet',
    messages: [{ role: 'user', content: 'Hello' }],
  });
} catch (error) {
  if (error instanceof BudgetExceededError) {
    console.error(`Budget exceeded: $${error.used} / $${error.limit}`);
  } else if (error instanceof RateLimitError) {
    console.error('Rate limited, retry later');
  } else if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else {
    console.error('Unknown error:', error);
  }
}
```

## API Reference

### Tokenist Client

```typescript
const client = new Tokenist({
  apiKey: string;              // Required: Your virtual key
  baseURL?: string;            // Gateway URL (default: http://localhost:3000/v1)
  timeout?: number;            // Request timeout in ms (default: 120000)
  maxRetries?: number;         // Max retry attempts (default: 3)
  retryDelay?: number;         // Initial retry delay in ms (default: 1000)
  
  // Callbacks
  onUsage?: (usage: UsageCallback) => void;
  onCost?: (cost: CostCallback) => void;
  onBudgetWarning?: (warning: BudgetWarning) => void;
  onError?: (error: Error) => void;
  
  // Default attribution
  defaultUser?: string;
  defaultCostCenter?: string;
});
```

### Chat Completions

```typescript
await client.chat.completions.create({
  model: string;                    // Required
  messages: ChatCompletionMessage[]; // Required
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  
  // Tokenist extensions
  user?: string;            // User attribution
  cost_center?: string;      // Cost center override
  cost_estimate?: number;    // Pre-estimate cost
  tools?: ChatCompletionTool[];
  tool_choice?: ChatCompletionToolChoiceOption;
});
```

### Response

```typescript
{
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
  
  // Tokenist extensions
  provider?: string;         // 'anthropic' | 'bedrock' | 'azure'
  actual_cost?: number;     // Actual cost in dollars
  latency_ms?: number;      // Request latency
  model_used?: string;      // Actual model used
  _attribution?: {           // Attribution data
    userId: string;
    costCenter: string;
    workspace: string;
    cost: number;
  };
}
```

## Error Types

| Error | Status | Description |
|-------|--------|-------------|
| `BudgetExceededError` | 429 | Request exceeds remaining budget |
| `RateLimitError` | 429 | Too many requests |
| `AuthenticationError` | 401 | Invalid API key |
| `NotFoundError` | 404 | Resource not found |
| `APIError` | 4xx/5xx | Generic API error |

## Configuration

### With Environment Variables

```typescript
const client = new Tokenist({
  apiKey: process.env.TOKENIST_API_KEY,
  baseURL: process.env.TOKENIST_BASE_URL || 'http://localhost:3000/v1',
});
```

### Retry Configuration

```typescript
const client = new Tokenist({
  apiKey: 'your-key',
  maxRetries: 5,      // Increase retries
  retryDelay: 2000,  // Start with 2 seconds
});
```

## License

MIT
