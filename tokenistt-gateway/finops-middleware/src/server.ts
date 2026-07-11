import express, { Request, Response, NextFunction } from 'express';
import { createFinOpsMiddleware, createErrorHandler, requestLogger } from './middleware/index.js';
import { FinOpsConfig } from './types/index.js';

const app = express();
app.use(express.json());

// FinOps configuration
const finOpsConfig: FinOpsConfig = {
  defaults: {
    rateLimitPerMinute: 100,
    budgetLimit: 100.00,
  },
  cache: {
    virtualKeyTtlSeconds: 60,
    rateLimitWindowSeconds: 60,
  },
  onBudgetExceeded: (context, result) => {
    console.log(`[Budget Alert] ${context.userId} exceeded budget: ${result.used}/${result.limit}`);
  },
  onRateLimitExceeded: (context, result) => {
    console.log(`[Rate Limit] ${context.userId} hit rate limit: ${result.remaining}/${context.rateLimitPerMinute}`);
  },
  onVirtualKeyNotFound: (token) => {
    console.log(`[Auth Warning] Unknown token: ${token.substring(0, 20)}...`);
  },
};

// Create FinOps middleware
const finOpsMiddleware = createFinOpsMiddleware(finOpsConfig);

// Apply global request logging middleware
app.use(requestLogger);

// Public endpoints (no auth required)
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.post('/v1/estimate-cost', (req: Request, res: Response) => {
  const { messages, max_tokens } = req.body;
  
  // Estimate input tokens (~4 chars per token)
  const inputChars = messages?.reduce((sum: number, m: { content?: string }) => 
    sum + (m.content?.length || 0), 0) || 0;
  const inputTokens = Math.ceil(inputChars / 4);
  
  const outputTokens = max_tokens || 1000;
  
  // Calculate cost (Claude 3 Sonnet pricing)
  const inputCost = (inputTokens / 1_000_000) * 3;
  const outputCost = (outputTokens / 1_000_000) * 15;
  const totalCost = inputCost + outputCost;
  
  res.json({
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCost: totalCost,
    breakdown: {
      inputCost,
      outputCost,
    },
  });
});

// Apply FinOps middleware (requires auth for all routes defined below)
app.use(finOpsMiddleware);

// Authenticated endpoints (requires auth header)
app.get('/v1/budget', (req: Request, res: Response) => {
  const attribution = req.attribution!;
  res.json({
    userId: attribution.userId,
    workspace: attribution.workspace,
    costCenter: attribution.costCenter,
    budgetLimit: attribution.budgetLimit,
    budgetRemaining: attribution.budgetRemaining,
    rateLimitPerMinute: attribution.rateLimitPerMinute,
  });
});

app.post('/v1/chat/completions', (req: Request, res: Response) => {
  const attribution = req.attribution!;
  
  const response = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'claude-3-sonnet',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: `Hello ${attribution.userId}! This is a demo response. Your cost center is ${attribution.costCenter}.`,
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50,
    },
  };
  
  res.json(response);
});

// Apply error handler
app.use(createErrorHandler());

// Start server
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              FinOps Attribution Middleware Demo               ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                       ║
║                                                               ║
║  Demo Virtual Keys (use Authorization header):                ║
║    tktt_live_acme_jane_abc123def456      (Budget: $87.50)     ║
║    tktt_live_acme_john_xyz789uvw012      (Budget: $12.30)     ║
║    tktt_live_globex_alice_qrs456tuv789   (Budget: $450.00)    ║
║    tktt_live_acme_disabled_mno321pqr654  (DISABLED)           ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /health         - Health check                        ║
║    GET  /v1/budget      - Budget status (requires auth)        ║
║    POST /v1/chat/completions - AI endpoint (requires auth)    ║
║    POST /v1/estimate-cost - Cost estimation                   ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

export { app };
