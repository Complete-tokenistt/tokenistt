import { Tokenist } from './index.js';

async function basicExample() {
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
  
  console.log('Response:', response.choices[0].message.content);
  console.log('Cost:', `$${response.actual_cost?.toFixed(6)}`);
  console.log('Provider:', response.provider);
}

async function usageCallbackExample() {
  const client = new Tokenist({
    apiKey: 'tktt_live_acme_jane_abc123def456',
    onUsage: (usage) => {
      console.log(`Tokens: ${usage.totalTokens} (${usage.promptTokens} in, ${usage.completionTokens} out)`);
    },
    onCost: (cost) => {
      console.log(`Cost: $${cost.cost.toFixed(6)}`);
    },
  });
  
  await client.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'What is 2+2?' }],
  });
}

async function budgetWarningExample() {
  const client = new Tokenist({
    apiKey: 'tktt_live_acme_john_xyz789uvw012',
    onBudgetWarning: (warning) => {
      console.warn(`Budget Warning: ${warning.userId}`);
      console.warn(`   Used: $${warning.budgetUsed.toFixed(2)} / $${warning.budgetLimit.toFixed(2)}`);
      console.warn(`   Remaining: $${warning.budgetRemaining.toFixed(2)} (${warning.percentageUsed.toFixed(1)}%)`);
    },
  });
  
  client.setBudgetLimit('user_john', 50.00);
  
  await client.chat.completions.create({
    model: 'claude-3-sonnet',
    messages: [{ role: 'user', content: 'Generate a long response...' }],
    max_tokens: 2000,
  });
}

async function attributionExample() {
  const client = new Tokenist({
    apiKey: 'tktt_live_globex_alice_qrs456tuv789',
    defaultUser: 'alice@globex.com',
    defaultCostCenter: 'research',
  });
  
  const response = await client.chat.completions.create({
    model: 'claude-3-opus',
    messages: [{ role: 'user', content: 'Analyze this data...' }],
    cost_center: 'data-science',
  });
  
  console.log('Attribution:', response._attribution);
}

const examples: Record<string, () => Promise<void>> = {
  basic: basicExample,
  usage: usageCallbackExample,
  budget: budgetWarningExample,
  attribution: attributionExample,
};

const exampleName = process.argv[2] || 'basic';
const example = examples[exampleName];

if (example) {
  console.log(`Running example: ${exampleName}`);
  example().catch(console.error);
} else {
  console.log('Available examples:', Object.keys(examples).join(', '));
}
