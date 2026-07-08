/**
 * Run with:  ts-node examples/quickstart.ts
 * (or compile the SDK first: npm run build)
 */
import Tokenistt from '../src';

async function main() {
  const client = new Tokenistt({
    apiKey: process.env.TOKENISTT_API_KEY ?? 'tktt_live_default_user_12345',
    baseURL: process.env.TOKENISTT_BASE_URL ?? 'https://gateway.tokenistt.ai/v1',

    // attribution
    user: 'examples/quickstart',
    costCenter: 'demo',

    // cost tracking
    onUsage: (cost) => console.log(`  -> request cost: $${cost.toFixed(6)}`),

    // budget control
    budget: { softLimit: 1, hardLimit: 5 },
    throwOnBudgetExceeded: false,
  });

  client.on('usage', (e) =>
    console.log(`  -> cumulative: $${e.cumulativeCost.toFixed(6)} (${e.model})`),
  );
  client.on('budget:warning', (e) =>
    console.warn(`  !! budget warning at $${e.cumulativeCost.toFixed(4)}`),
  );

  // Non-streaming
  const completion = await client.chat.completions.create(
    {
      model: 'openai:llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Say hello in 3 words.' },
      ],
    },
    {
      user: 'alice', // per-request attribution override
      costCenter: 'onboarding',
    }
  );
  console.log('Completion:', completion.choices[0].message.content);
  console.log('Usage:', completion.usage);

  // Streaming
  console.log('\nStreaming:');
  const stream = await client.chat.completions.create({
    model: 'openai:llama-3.1-8b-instant',
    messages: [{ role: 'user', content: 'Write a haiku about APIs.' }],
    stream: true,
  });
  for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
  }
  const full = await stream.finalChatCompletion();
  console.log('\n\nFinal usage:', full.usage);
  console.log('Total tracked spend:', client.getCumulativeCost().toFixed(6));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
