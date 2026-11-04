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

import helmet from 'helmet';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import { config }                                   from 'dotenv';
import { existsSync }                               from 'fs';
import { timingSafeEqual }                          from 'node:crypto';
import {
  GatewayService,
  validateChatCompletionRequest,
  extractProviderFromHeaders,
}                                                   from './services/gateway.js';
import { ProviderConfig }                           from './providers/registry.js';
import { ProviderType, GatewayError }               from './types/index.js';
import { getAvailableModels, calculateCost, calculateCostWithStatus } from './services/pricing.js';
import { loadPricingFromDb, resolvePricingTierDynamic } from './services/pricingDb.js';
import {
  authenticateRequest,
  AuthError,
  BudgetExceededError,
  RateLimitExceededError,
}                                                   from './db/auth.js';
import { logTransaction }                           from './db/transactionLogger.js';
import { checkDbConnection, closePool, getPool }    from './db/pool.js';
import { waitForRedis }                            from './services/redis.js';
import { startAuditDrainScheduler, stopAuditDrainScheduler } from './services/auditLogger.js';
import { handleStreamingCompletion, streamsNatively, writeSyntheticStream } from './services/streaming.js';
import { checkPolicies }                            from './db/policies.js';
import { enforceBudgets }                          from './services/budgetEngine.js';
import { resolveAttribution }                      from './services/workspaceResolver.js';
import { resolveRoute }                            from './services/routingEngine.js';
import { resolveKeys }                             from './services/byok.js';
import { compressMessages }                        from './services/promptCompression.js';
import { isCacheable, cacheKey, getCached, putCached } from './services/responseCache.js';
import { checkAndSendBudgetAlert }                 from './services/alerting.js';
import { SmartRouter }                              from './services/router.js';
import { adminRouter }                              from './routes/admin.js';
import { managementRouter }                        from './routes/management.js';
import { logsRouter }                              from './routes/logs.js';
import { ingestRouter }                            from './routes/ingest.js';
import { syncRouter }                              from './routes/sync.js';
import { buildOpenApi }                            from './openapi.js';
import { ingestWebhook, startConnectorScheduler, stopConnectorScheduler } from './services/connectorService.js';
import { ConnectorError }                          from './connectors/registry.js';
import { providersRouter }                          from './routes/providers.js';
import { metrics }                                  from './services/metrics.js';
import { validateSecrets }                          from './config/secrets.js';
import { corsOptions, metricsAccess }               from './middleware/security.js';
import { requestContextMiddleware, getElapsedLatencyMs } from './middleware/requestContext.js';
import {
  ensurePartitionsAhead,
  startPartitionMaintenanceScheduler,
  stopPartitionMaintenanceScheduler,
}                                                   from './services/partitionManager.js';
import { startDrainScheduler, stopDrainScheduler }  from './db/durableQueue.js';


// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

if (existsSync('.env')) config();
validateSecrets();

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors(corsOptions()));
app.use(express.json({
  limit: '10mb',
  // keep the raw bytes: connector webhooks verify HMAC signatures over them
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));
app.use(requestContextMiddleware);

// ── Prometheus metrics endpoint ─────────────────────────────────────────────
app.get('/metrics', metricsAccess(), (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(metrics.getMetricsText());
});

// ── Inbound connector webhooks (authenticated by signature, not by session) ──
app.post('/v1/webhooks/connectors/:id', async (req: Request, res: Response) => {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: { message: 'Database not configured' } });
    return;
  }
  try {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const out = await ingestWebhook(String(req.params.id), {
      rawBody: (req as any).rawBody ?? Buffer.from(''), headers, body: req.body,
    });
    res.json({ ok: true, ...out });
  } catch (err: any) {
    if (err instanceof ConnectorError) {
      res.status(err.status).json({ error: { message: err.message } });
      return;
    }
    console.error('[Webhook] ingest failed:', err.message);
    res.status(500).json({ error: { message: 'Internal error' } });
  }
});

// ── Batch: run several chat completions through the full pipeline ───────────
// Each item is dispatched to this server's own /v1/chat/completions so auth, policy,
// budgets, routing, caching and logging behave exactly as for a single request.
app.post('/v1/batch/chat/completions', async (req: Request, res: Response) => {
  const items = req.body?.requests;
  const max = parseInt(process.env.BATCH_MAX_ITEMS || '20', 10);
  if (!Array.isArray(items) || items.length === 0 || items.length > max) {
    res.status(400).json({ error: { message: `"requests" must be an array of 1-${max} chat completion bodies.`, type: 'invalid_request_error' } });
    return;
  }
  const port = req.socket.localPort ?? process.env.PORT ?? 3000;
  const forward: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string' && (k === 'authorization' || k.startsWith('x-'))) forward[k] = v;
  }
  const results: unknown[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST', headers: forward, body: JSON.stringify({ ...items[i], stream: false }),
        });
        results[i] = { index: i, status: r.status, body: await r.json().catch(() => null) };
      } catch (err: any) {
        results[i] = { index: i, status: 502, body: { error: { message: err.message } } };
      }
    }
  }));
  res.json({ object: 'batch', results });
});

// ── Admin and Provider routes ────────────────────────────────────────────────
app.get('/v1/openapi.json', (_req: Request, res: Response) => { res.json(buildOpenApi()); });
app.use('/v1', logsRouter);
app.use('/v1', ingestRouter); // usage events from SDKs / the CLI, authenticated by virtual key
app.use('/v1', syncRouter); // repository summaries from the CLI, authenticated by virtual key
app.use('/v1/admin', managementRouter); // RBAC management API (falls through for legacy routes)
app.use('/v1/admin', adminRouter);
app.use('/v1/providers', providersRouter);

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
  let authForError: Awaited<ReturnType<typeof authenticateRequest>> | null = null;

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
    authForError = auth;

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

    // ── Step 2.2: Workspace / team / project / attribution resolver ──────────
    auth.attribution = await resolveAttribution(auth, req.headers);

    // ── Step 2.5: Policy & Governance Check ──────────────────────────────────
    const policyResult = await checkPolicies(auth, req.body, requestId);
    if (!policyResult.allowed) {
      res.status(403).json({
        error: {
          message: policyResult.reason || 'Blocked by active governance policy.',
          type: policyResult.code === 'approval_required' ? 'approval_required_error' : 'policy_violation_error',
          code: policyResult.code || 'policy_violation',
          ...(policyResult.approvalId ? { approval_id: policyResult.approvalId } : {}),
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
        errorCode: policyResult.code || 'policy_violation',
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

    // ── Step 2.7: Hierarchical budget enforcement (org → team → project → key) ──
    const budget = await enforceBudgets(auth, requestId);
    if (!budget.allowed) {
      res.status(429).json({
        error: {
          message: budget.result?.reason || 'Budget exceeded.',
          type: 'budget_exceeded_error',
          code: 'budget_exceeded',
          scope: budget.result?.scopeType,
        },
      });
      return;
    }
    if (budget.result && budget.result.level !== 'ok') {
      res.setHeader('x-tokenistt-budget-level', budget.result.level);
      res.setHeader('x-tokenistt-budget-percent', budget.result.percentUsed.toFixed(1));
    }
    if (budget.throttleMs > 0) {
      await new Promise(resolve => setTimeout(resolve, budget.throttleMs));
    }

    // ── Step 2.8: opt-in prompt compression ─────────────────────────────────
    const hdr = (n: string) => {
      const v = req.headers[n];
      return Array.isArray(v) ? v[0] : v;
    };
    if (hdr('x-tokenistt-compress') === 'true') {
      const { messages, savedChars } = compressMessages(req.body.messages);
      req.body.messages = messages;
      res.setHeader('x-tokenistt-compressed-chars', String(savedChars));
    }

    // ── Step 2.9: opt-in response cache (identical request -> zero provider cost) ──
    const cacheable = isCacheable(req.body, hdr('x-tokenistt-cache'));
    const rcKey = cacheable ? cacheKey(auth.organizationId, req.body) : null;
    if (rcKey) {
      const hit = await getCached(rcKey);
      if (hit) {
        res.setHeader('x-tokenistt-cache', 'HIT');
        res.setHeader('x-tokenistt-cost', '0.000000');
        logTransaction({
          auth, provider: 'cache', model: req.body.model, endpoint: '/v1/chat/completions', requestId,
          promptTokens: 0, completionTokens: 0, totalTokens: 0, inputCostUsd: 0, outputCostUsd: 0, costUsd: 0,
          durationMs: Date.now() - startTime, status: 'success', projectTag: req.body.project_tag,
          metadata: { cache: 'hit', original_provider: (hit as any).provider },
        }).catch(() => {});
        res.json({ ...hit, _tokenistt: { request_id: requestId, trace_id: traceId, cost_usd: 0, cache: 'hit' } });
        return;
      }
      res.setHeader('x-tokenistt-cache', 'MISS');
    }

    // ── Steps 3-4: provider override, routing rule, provider call ────────────
    const providerOverride = extractProviderFromHeaders(
      req.headers as Record<string, string | undefined>,
    );
    const route = providerOverride ? null : await resolveRoute(auth, req.body, requestId);
    const wantsStream = req.body.stream === true;

    // True passthrough streaming when nothing needs to decide the provider for us. Requests that match a
    // routing rule, or target a provider without native streaming (mock, bedrock), are served through the
    // router (failover included) and replayed to the client as a stream.
    if (wantsStream && !route && streamsNatively(req.body.model, providerOverride)) {
      await handleStreamingCompletion(req.body, res, auth, providerOverride, requestId);
      return;
    }

    const response = await router.route({ ...req.body, stream: false }, {
      providerOverride,
      candidates: route?.candidates,
      keys: provider => resolveKeys(auth, provider),
    });
    const durationMs = Date.now() - startTime;

    // ── Step 5: Precise cost breakdown with cache & reasoning tokens ──────────
    const usedProvider   = (response.provider ?? providerOverride ?? 'anthropic') as string;
    const promptTokens   = response.usage?.prompt_tokens     ?? 0;
    const completTokens  = response.usage?.completion_tokens ?? 0;
    const cacheCreationTokens = (response.usage as any)?.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = (response.usage as any)?.cache_read_input_tokens 
      ?? (response.usage as any)?.prompt_tokens_details?.cached_tokens 
      ?? 0;
    const reasoningTokens = (response.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;

    // Bill the model that actually served the request (routing/failover may have changed it)
    const billedModel: string = (response._tokenistt as any)?.routed_model ?? req.body.model;

    // Dynamically resolve pricing tier from DB (with fallback)
    const customPricing = await resolvePricingTierDynamic(usedProvider, billedModel);

    // Derive per-direction costs from pricing table including cache & reasoning tokens
    const costBreakdown = calculateCostWithStatus(
      usedProvider,
      billedModel,
      promptTokens,
      completTokens,
      cacheReadTokens,
      cacheCreationTokens,
      reasoningTokens,
      customPricing
    );

    const inputCostUsd  = costBreakdown.inputCost + costBreakdown.cachedInputCost + costBreakdown.cacheCreationCost;
    const outputCostUsd = costBreakdown.outputCost + costBreakdown.reasoningCost;
    const totalCostUsd  = costBreakdown.cost;
    const costStatus    = costBreakdown.costStatus;

    // ── Step 6: Inject cost headers ──────────────────────────────────────────
    res.setHeader('x-tokenistt-cost',              totalCostUsd.toFixed(6));
    res.setHeader('x-tokenistt-cost-status',       costStatus);
    res.setHeader('x-tokenistt-input-cost',        inputCostUsd.toFixed(6));
    res.setHeader('x-tokenistt-output-cost',       outputCostUsd.toFixed(6));
    res.setHeader('x-tokenistt-tokens-prompt',     String(promptTokens));
    res.setHeader('x-tokenistt-tokens-completion', String(completTokens));
    res.setHeader('x-tokenistt-tokens-cache-read', String(cacheReadTokens));
    res.setHeader('x-tokenistt-tokens-cache-write', String(cacheCreationTokens));
    res.setHeader('x-tokenistt-latency-ms',        String(durationMs));
    res.setHeader('x-tokenistt-provider',          usedProvider);

    if (rcKey) putCached(rcKey, response).catch(() => {});

    // ── Step 7: Send response ────────────────────────────────────────────────
    const finalBody = {
      ...response,
      _tokenistt: {
        request_id:   requestId,
        trace_id:     traceId,
        actor:        auth.actor,
        cost_center:  auth.costCenter,
        cost_usd:     totalCostUsd,
        cost_status:  costStatus,
        latency_ms:   durationMs,
        // routing / failover outcome, when the router changed the provider or model
        ...((response._tokenistt as any)?.routed_model ? {
          routed_provider: (response._tokenistt as any).routed_provider,
          routed_model:    (response._tokenistt as any).routed_model,
          failover_used:   (response._tokenistt as any).failover_used ?? false,
        } : {}),
      },
    };
    if (wantsStream) writeSyntheticStream(res, finalBody);
    else res.json(finalBody);

    // ── Step 8: Fire-and-forget transaction log ───────────────────────────────
    logTransaction({
      auth,
      provider:        usedProvider,
      model:           billedModel,
      endpoint:        '/v1/chat/completions',
      requestId,
      promptTokens,
      completionTokens: completTokens,
      totalTokens:     promptTokens + completTokens,
      cacheCreationTokens,
      cacheReadTokens,
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

    // ── Step 10: Structured FinOps Observability Log ──────────────────────────
    console.log(JSON.stringify({
      level: 'info',
      event: 'finops_request_complete',
      provider: usedProvider,
      model: req.body.model,
      cost_usd: totalCostUsd,
      cost_status: costStatus,
      duration_ms: durationMs,
      prompt_tokens: promptTokens,
      completion_tokens: completTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens,
      reasoning_tokens: reasoningTokens,
      organization_id: auth.organizationId !== BigInt(0) ? auth.organizationId.toString() : null,
      cost_center: auth.costCenter,
      actor: auth.actor,
      status: 'success',
      request_id: requestId,
    }));

  } catch (err) {
    const durationMs = Date.now() - startTime;

    // Log failed transaction too (fail-open). Use the real identity when authentication succeeded, so
    // the failure lands in the right org's ledger and any budget reservation is released.
    if (!(err instanceof AuthError)) {
      logTransaction({
        auth:             authForError ?? { actor: 'unknown', costCenter: 'default', organizationId: BigInt(0), workspaceId: null, virtualKeyId: BigInt(0), virtualKeyPublicId: '', budgetCapUsd: null, budgetUsedUsd: 0, budgetPeriod: 'none', allowedProviders: [], realApiKey: null, enforcementMode: 'hard_cap', rateLimitPerMinute: 100 },
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
  // Require admin authentication (timing-safe comparison to prevent enumeration attacks).
  const adminSecret = process.env.ADMIN_SECRET || 'dev-admin-secret-change-in-production';
  const headerSecret = req.headers['x-admin-secret'];
  if (!headerSecret || typeof headerSecret !== 'string') {
    res.status(401).json({
      error: { message: 'Unauthorized. Valid X-Admin-Secret header required.', type: 'authentication_error' },
    });
    return;
  }
  try {
    const expected = Buffer.from(adminSecret, 'utf-8');
    const provided = Buffer.from(headerSecret, 'utf-8');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      res.status(401).json({
        error: { message: 'Unauthorized. Valid X-Admin-Secret header required.', type: 'authentication_error' },
      });
      return;
    }
  } catch {
    res.status(401).json({ error: { message: 'Unauthorized.', type: 'authentication_error' } });
    return;
  }
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

  if (process.env.REDIS_REQUIRED === 'true' && !(await waitForRedis())) {
    console.error('[FATAL] REDIS_REQUIRED=true but Redis is unreachable. Refusing to start.');
    process.exit(1);
  }

  if (process.env.DATABASE_URL) {
    await checkDbConnection();
    await loadPricingFromDb();
    await ensurePartitionsAhead(3);
    startPartitionMaintenanceScheduler();
    startDrainScheduler(() => getPool());
    startAuditDrainScheduler();
    startConnectorScheduler();
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
    stopPartitionMaintenanceScheduler();
    stopDrainScheduler();
    stopAuditDrainScheduler();
    stopConnectorScheduler();
    await closePool();
    console.log('Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

export { app, gateway };
