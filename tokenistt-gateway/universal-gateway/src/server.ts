/**
 * server.ts — Tokenistt Universal Gateway
 *
 * Request pipeline (per call):
 *  1. Parse & validate request body
 *  2. authenticateRequest() — verify tktt_live_xxx against Postgres virtual_keys
 *     → resolves workspace / cost-center / budget context
 *     → throws AuthError (401) or BudgetExceededError (429)
 *  3. handleChatCompletion() — call provider, calculate exact cost
 *  4. Inject response headers: x-tokenistt-cost, x-tokenistt-request-id, etc.
 *  5. logTransaction() — fire-and-forget write to Postgres transactions table
 *  6. Return OpenAI-compatible JSON to client
 */

import express, { Request, Response, NextFunction } from 'express';
import { config }                                   from 'dotenv';
import { existsSync }                               from 'fs';
import {
  GatewayService,
  validateChatCompletionRequest,
  extractProviderFromHeaders,
}                                                   from './services/gateway.js';
import { ProviderConfig }                           from './providers/registry.js';
import { ProviderType, GatewayError }               from './types/index.js';
import { getAvailableModels, calculateCost, calculateCostWithStatus } from './services/pricing.js';
import {
  authenticateRequest,
  AuthError,
  BudgetExceededError,
  RateLimitExceededError,
}                                                   from './db/auth.js';
import { logTransaction }                           from './db/transactionLogger.js';
import { checkDbConnection, closePool }             from './db/pool.js';
import { handleStreamingCompletion }                from './services/streaming.js';
import { checkPolicies }                            from './db/policies.js';
import { checkAndSendBudgetAlert }                 from './services/alerting.js';
import { SmartRouter }                              from './services/router.js';
import { adminRouter }                              from './routes/admin.js';
import { metrics }                                  from './services/metrics.js';
import { validateSecrets }                          from './config/secrets.js';
import { requestContextMiddleware, getElapsedLatencyMs } from './middleware/requestContext.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (existsSync('.env')) config();
validateSecrets();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(requestContextMiddleware);

// ── Health endpoint ─────────────────────────────────────────────────────────
app.get('/health', async (_req: Request, res: Response) => {
  const db = await checkDbConnection();
  const redis = (await import('./services/redis.js')).getRedisClient() !== null;
  res.json({
    status: 'ok',
    db,
    redis,
    timestamp: new Date().toISOString(),
  });
});

// ── Prometheus metrics endpoint ─────────────────────────────────────────────
app.get('/metrics', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(metrics.getMetricsText());
});

// ── Admin routes ────────────────────────────────────────────────────────────
app.use('/v1/admin', adminRouter);

// ── Provider configuration ──────────────────────────────────────────────────

const providerConfig: ProviderConfig = {};

if (process.env.ANTHROPIC_API_KEY) {
  providerConfig.anthropic = { apiKey: process.env.ANTHROPIC_API_KEY };
}
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  providerConfig.bedrock = {
    awsAccessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region:             process.env.AWS_REGION || 'us-east-1',
  };
}
if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
  providerConfig.azure = {
    endpoint:       process.env.AZURE_OPENAI_ENDPOINT,
    apiKey:         process.env.AZURE_OPENAI_API_KEY,
    deploymentName: process.env.AZURE_DEPLOYMENT_NAME || 'gpt-4',
    apiVersion:     process.env.AZURE_API_VERSION    || '2024-02-01',
  };
}
if (process.env.OPENAI_API_KEY) {
  providerConfig.openai = { apiKey: process.env.OPENAI_API_KEY };
}

const gateway = new GatewayService(
  {
    defaultProvider: (process.env.DEFAULT_PROVIDER as ProviderType) || 'anthropic',
    enableMetrics:   process.env.ENABLE_METRICS !== 'false',
  },
  providerConfig,
);

const router = new SmartRouter(gateway);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', async (_req: Request, res: Response) => {
  const dbConnected = process.env.DATABASE_URL
    ? await checkDbConnection().catch(() => false)
    : null;

  res.json({
    status:    'healthy',
    timestamp: new Date().toISOString(),
    providers: gateway.getAvailableProviders(),
    database:  dbConnected === null ? 'not configured (open mode)' : dbConnected ? 'connected' : 'unreachable',
  });
});

app.get('/v1/models', (_req: Request, res: Response) => {
  const models = getAvailableModels();
  const data = Object.entries(models).flatMap(([provider, modelList]) =>
    modelList.map(modelId => ({
      id:         `${provider}:${modelId}`,
      object:     'model',
      created:    Date.now(),
      owned_by:   provider,
      provider,
    })),
  );
  res.json({ object: 'list', data });
});

// ── Main chat completions endpoint ──────────────────────────────────────────

app.post('/v1/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const requestId = req.context?.requestId || `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const traceId   = req.context?.traceId || requestId;

  try {
    // ── Step 1: Validate request body ───────────────────────────────────────
    if (!validateChatCompletionRequest(req.body)) {
      res.status(400).json({
        error: {
          message: 'Invalid request format. Expected OpenAI chat completions format.',
          type:    'invalid_request_error',
          code:    'invalid_request',
        },
      });
      return;
    }

    // ── Step 2: Auth & Budget Check ─────────────────────────────────────────
    const auth = await authenticateRequest(req.headers.authorization);

    // Soft budget warning (within 20% of limit)
    if (
      auth.budgetCapUsd !== null &&
      auth.budgetUsedUsd >= auth.budgetCapUsd * 0.8
    ) {
      res.setHeader('x-tokenistt-budget-warning', 'true');
      res.setHeader(
        'x-tokenistt-budget-remaining',
        (auth.budgetCapUsd - auth.budgetUsedUsd).toFixed(4),
      );
      checkAndSendBudgetAlert(auth, 'soft').catch(() => {});
    }

    // Attach attribution headers
    res.setHeader('x-tokenistt-workspace',   auth.costCenter);
    res.setHeader('x-tokenistt-actor',       auth.actor);
    res.setHeader('x-tokenistt-request-id',  requestId);

    // ── Step 2.5: Policy & Governance Check ──────────────────────────────────
    const policyResult = await checkPolicies(auth, req.body);
    if (!policyResult.allowed) {
      res.status(403).json({
        error: {
          message: policyResult.reason || 'Blocked by active governance policy.',
          type: 'policy_violation_error',
          code: 'policy_violation',
        },
      });

      // Log blocked transaction
      logTransaction({
        auth,
        provider: 'governance',
        model: req.body.model,
        endpoint: '/v1/chat/completions',
        requestId,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
        costUsd: 0,
        durationMs: 0,
        status: 'error',
        errorCode: 'policy_violation',
        projectTag: req.body.project_tag,
        metadata: {
          error: policyResult.reason || 'Blocked by active governance policy.',
        },
      }).catch(() => {});
      return;
    }

    if (policyResult.modifiedRequest) {
      req.body = policyResult.modifiedRequest;
    }

    // ── Streaming (passthrough) ─────────────────────────────────────────────
    if (req.body.stream === true) {
      const providerOverride = extractProviderFromHeaders(
        req.headers as Record<string, string | undefined>,
      );
      await handleStreamingCompletion(req.body, res, auth, providerOverride, requestId);
      return;
    }

    // ── Step 3: Resolve provider override ────────────────────────────────────
    const providerOverride = extractProviderFromHeaders(
      req.headers as Record<string, string | undefined>,
    );

    // ── Step 4: Call provider (via SmartRouter for automatic failover) ───────
    const response  = await router.handleChatCompletion(req.body, providerOverride, auth.realApiKey);
    const durationMs = Date.now() - startTime;

    // ── Step 5: Precise cost breakdown ───────────────────────────────────────
    const usedProvider   = (response.provider ?? providerOverride ?? 'anthropic') as string;
    const promptTokens   = response.usage?.prompt_tokens     ?? 0;
    const completTokens  = response.usage?.completion_tokens ?? 0;

    // Re-derive per-direction costs from pricing table
    const inputCostRes  = calculateCostWithStatus(usedProvider, req.body.model, promptTokens, 0);
    const outputCostRes = calculateCostWithStatus(usedProvider, req.body.model, 0, completTokens);
    const inputCostUsd  = inputCostRes.cost;
    const outputCostUsd = outputCostRes.cost;
    const totalCostUsd  = response.actual_cost ?? (inputCostUsd + outputCostUsd);
    const costStatus    = (!inputCostRes.isKnown || !outputCostRes.isKnown) ? 'COST_UNAVAILABLE' : 'ok';

    // ── Step 6: Inject cost headers ──────────────────────────────────────────
    res.setHeader('x-tokenistt-cost',              totalCostUsd.toFixed(6));
    res.setHeader('x-tokenistt-cost-status',       costStatus);
    res.setHeader('x-tokenistt-input-cost',        inputCostUsd.toFixed(6));
    res.setHeader('x-tokenistt-output-cost',       outputCostUsd.toFixed(6));
    res.setHeader('x-tokenistt-tokens-prompt',     String(promptTokens));
    res.setHeader('x-tokenistt-tokens-completion', String(completTokens));
    res.setHeader('x-tokenistt-latency-ms',        String(durationMs));
    res.setHeader('x-tokenistt-provider',          usedProvider);

    // ── Step 7: Send response ────────────────────────────────────────────────
    res.json({
      ...response,
      _tokenistt: {
        request_id:   requestId,
        trace_id:     traceId,
        actor:        auth.actor,
        cost_center:  auth.costCenter,
        cost_usd:     totalCostUsd,
        cost_status:  costStatus,
        latency_ms:   durationMs,
      },
    });

    // ── Step 8: Fire-and-forget transaction log ───────────────────────────────
    logTransaction({
      auth,
      provider:        usedProvider,
      model:           req.body.model,
      endpoint:        '/v1/chat/completions',
      requestId,
      promptTokens,
      completionTokens: completTokens,
      totalTokens:     promptTokens + completTokens,
      inputCostUsd,
      outputCostUsd,
      costUsd:         totalCostUsd,
      durationMs,
      status:          'success',
      projectTag:      req.body.project_tag,
      metadata: {
        trace_id:        traceId,
        cost_status:     costStatus,
        finish_reason:   response.choices?.[0]?.finish_reason,
        model_used:      response.model_used,
        user_agent:      req.headers['user-agent'],
      },
    }).catch(() => { /* already logged inside */ });

    // ── Step 9: Collect Prometheus metrics ────────────────────────────────────
    metrics.recordTransaction({
      provider: usedProvider,
      model: req.body.model,
      status: 'success',
      costCenter: auth.costCenter,
      costUsd: totalCostUsd,
      promptTokens,
      completionTokens: completTokens,
      latencyMs: durationMs,
    });

  } catch (err) {
    const durationMs = Date.now() - startTime;

    // Log failed transaction too (fail-open)
    if (!(err instanceof AuthError)) {
      logTransaction({
        auth:             { actor: 'unknown', costCenter: 'default', organizationId: BigInt(0), workspaceId: null, virtualKeyId: BigInt(0), virtualKeyPublicId: '', budgetCapUsd: null, budgetUsedUsd: 0, budgetPeriod: 'none', allowedProviders: [], realApiKey: null, enforcementMode: 'hard_cap', rateLimitPerMinute: 100 },
        provider:         'unknown',
        model:            req.body?.model ?? 'unknown',
        endpoint:         '/v1/chat/completions',
        requestId,
        promptTokens:     0,
        completionTokens: 0,
        totalTokens:      0,
        inputCostUsd:     0,
        outputCostUsd:    0,
        costUsd:          0,
        durationMs,
        status:           'error',
        errorCode:        (err as any)?.code ?? 'UNKNOWN',
      }).catch(() => {});
    }

    next(err);
  }
});

app.post('/v1/config/providers', (req: Request, res: Response) => {
  try {
    const { provider, config: providerCfg } = req.body;
    if (!provider || !providerCfg) {
      res.status(400).json({ error: { message: 'Missing provider or config', type: 'invalid_request_error' } });
      return;
    }
    gateway.updateProviderConfig({ [provider]: providerCfg });
    res.json({ success: true, provider, message: `Provider ${provider} configuration updated` });
  } catch (error: any) {
    res.status(400).json({ error: { message: error.message, type: 'configuration_error' } });
  }
});

app.get('/v1/providers', (_req: Request, res: Response) => {
  res.json({
    providers: gateway.getAvailableProviders().map(p => ({
      name:      p,
      available: gateway.hasProvider(p as ProviderType),
    })),
  });
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Gateway Error]', err.message);

  if (err instanceof AuthError) {
    res.status(err.statusCode).json({
      error: { message: err.message, type: 'authentication_error', code: 'auth_failed' },
    });
    return;
  }

  if (err instanceof BudgetExceededError) {
    res.status(err.statusCode).json({
      error: {
        message:    err.message,
        type:       'budget_exceeded',
        code:       'budget_exceeded',
        limit_usd:  err.limitUsd,
        used_usd:   err.usedUsd,
      },
    });
    return;
  }

  if (err instanceof RateLimitExceededError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        type:    'rate_limit_exceeded',
        code:    'rate_limit_exceeded',
        limit:   err.limit,
      },
    });
    return;
  }

  if (err instanceof GatewayError) {
    res.status(err.statusCode).json({
      error: { message: err.message, type: 'provider_error', code: err.code, provider: err.provider },
    });
    return;
  }

  res.status(500).json({
    error: {
      message: 'Internal server error',
      type:    'server_error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    },
  });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: { message: 'Not found', type: 'not_found_error' } });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, async () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              Tokenistt Universal Gateway                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Server  →  http://localhost:${PORT}                             ║
║                                                               ║
║  POST /v1/chat/completions   Main endpoint                    ║
║  GET  /v1/models             List available models            ║
║  GET  /v1/providers          Provider status                  ║
║  GET  /health                Health + DB status               ║
╚═══════════════════════════════════════════════════════════════╝
  `);

  console.log('Providers:', gateway.getAvailableProviders());

  if (process.env.DATABASE_URL) {
    await checkDbConnection();
  } else {
    console.warn(
      '[Gateway] DATABASE_URL not set — running in OPEN mode.\n' +
      '           Set DATABASE_URL to enable auth + transaction logging.'
    );
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(async () => {
    await closePool();
    console.log('Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export { app, gateway };
