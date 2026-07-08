import type { Request, Response, NextFunction } from 'express';
import { RedisCache } from '../cache/redis.js';
import { VirtualKeyService, parseVirtualKeyToken, InMemoryVirtualKeyStore } from '../services/virtualKey.js';
import { BudgetService } from '../services/budget.js';
import { RateLimiterService } from '../services/rateLimiter.js';
import {
  FinOpsConfig,
  FinOpsMiddleware,
  AttributionContext,
  BudgetCheckResult,
  BudgetExceededError,
  RateLimitExceededError,
  InvalidTokenError,
  VirtualKeyDisabledError,
} from '../types/index.js';

export class FinOpsMiddlewareBuilder {
  private cache: RedisCache;
  private virtualKeyService: VirtualKeyService;
  private budgetService: BudgetService;
  private rateLimiterService: RateLimiterService;
  private config: Required<FinOpsConfig>;
  
  constructor(config: FinOpsConfig = {}) {
    this.cache = new RedisCache(config.redis);
    const virtualKeyStore = new InMemoryVirtualKeyStore();
    this.virtualKeyService = new VirtualKeyService(this.cache, virtualKeyStore);
    this.budgetService = new BudgetService(
      this.cache,
      this.virtualKeyService,
      config.defaults?.budgetLimit
    );
    this.rateLimiterService = new RateLimiterService(
      this.cache,
      config.defaults?.rateLimitPerMinute || 100,
      config.cache?.rateLimitWindowSeconds || 60
    );
    
    if (config.cache?.virtualKeyTtlSeconds) {
      this.virtualKeyService.setCacheTtl(config.cache.virtualKeyTtlSeconds);
    }
    
    this.config = {
      redis: config.redis || {},
      cache: config.cache || {},
      defaults: config.defaults || {},
      onBudgetExceeded: config.onBudgetExceeded || (() => {}),
      onRateLimitExceeded: config.onRateLimitExceeded || (() => {}),
      onVirtualKeyNotFound: config.onVirtualKeyNotFound || (() => {}),
    };
  }
  
  create(): FinOpsMiddleware {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authHeader = req.headers.authorization;
        const token = parseVirtualKeyToken(authHeader || '');
        
        if (!token) {
          throw new InvalidTokenError(
            'Invalid or missing Authorization header. Expected format: Bearer tktt_live_{workspace}_{user}_{hash}'
          );
        }
        
        const keyLookup = await this.virtualKeyService.lookup(token);
        
        if (!keyLookup) {
          this.config.onVirtualKeyNotFound(token.raw);
          throw new InvalidTokenError(`Virtual key not found: ${token.workspace}/${token.userId}`);
        }
        
        if (!keyLookup.enabled) {
          throw new VirtualKeyDisabledError(keyLookup.virtualKeyId);
        }
        
        const context: AttributionContext = {
          virtualKeyId: keyLookup.virtualKeyId,
          userId: keyLookup.userId,
          workspace: keyLookup.workspace,
          costCenter: keyLookup.costCenter,
          realApiKey: keyLookup.realApiKey,
          budgetRemaining: keyLookup.budgetRemaining,
          budgetLimit: keyLookup.budgetLimit,
          rateLimitPerMinute: keyLookup.rateLimitPerMinute,
        };
        
        const rateLimitResult = await this.rateLimiterService.checkRateLimit(context);
        
        if (!rateLimitResult.allowed) {
          this.config.onRateLimitExceeded(context, rateLimitResult);
          
          res.setHeader('X-RateLimit-Limit', context.rateLimitPerMinute);
          res.setHeader('X-RateLimit-Remaining', 0);
          res.setHeader('X-RateLimit-Reset', rateLimitResult.resetAt);
          res.setHeader('Retry-After', rateLimitResult.retryAfter || 60);
          
          throw new RateLimitExceededError(
            rateLimitResult.retryAfter || 60,
            context.rateLimitPerMinute,
            0
          );
        }
        
        res.setHeader('X-RateLimit-Limit', context.rateLimitPerMinute);
        res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
        res.setHeader('X-RateLimit-Reset', rateLimitResult.resetAt);
        
        const estimatedCost = this.extractEstimatedCost(req);
        const budgetResult = await this.budgetService.checkBudget(context, estimatedCost);
        
        if (!budgetResult.allowed) {
          this.config.onBudgetExceeded(context, budgetResult);
          
          res.setHeader('X-Budget-Limit', budgetResult.limit);
          res.setHeader('X-Budget-Used', budgetResult.used);
          res.setHeader('X-Budget-Remaining', 0);
          
          throw new BudgetExceededError(
            budgetResult.limit,
            budgetResult.used,
            budgetResult.estimatedCost
          );
        }
        
        const reserved = await this.budgetService.reserveBudget(context, estimatedCost);
        
        if (!reserved) {
          throw new BudgetExceededError(
            context.budgetLimit,
            context.budgetLimit - context.budgetRemaining,
            estimatedCost
          );
        }
        
        res.setHeader('X-Attribution-User', context.userId);
        res.setHeader('X-Attribution-Cost-Center', context.costCenter);
        res.setHeader('X-Attribution-Workspace', context.workspace);
        res.setHeader('X-Attribution-Virtual-Key', context.virtualKeyId);
        res.setHeader('X-Budget-Limit', context.budgetLimit);
        res.setHeader('X-Budget-Remaining', budgetResult.remainingAfter);
        
        req.attribution = context;
        
        const originalJson = res.json.bind(res);
        res.json = ((body: unknown) => {
          const actualCost = this.extractActualCost(body) || estimatedCost;
          this.budgetService.recordCost(context, actualCost).catch(console.error);
          
          const costDiff = estimatedCost - actualCost;
          if (costDiff > 0.01) {
            this.budgetService.releaseBudget(context, costDiff).catch(console.error);
          }
          
          if (typeof body === 'object' && body !== null) {
            const responseBody = body as Record<string, unknown>;
            responseBody._attribution = {
              userId: context.userId,
              costCenter: context.costCenter,
              workspace: context.workspace,
              cost: actualCost,
            };
          }
          
          return originalJson(body);
        }) as typeof res.json;
        
        next();
        
      } catch (error) {
        next(error);
      }
    };
  }
  
  private extractEstimatedCost(req: Request): number {
    const costHeader = req.headers['x-estimated-cost'];
    if (costHeader) {
      const cost = parseFloat(Array.isArray(costHeader) ? costHeader[0] : costHeader);
      if (!isNaN(cost) && cost > 0) {
        return cost;
      }
    }
    
    if (req.body && typeof req.body === 'object') {
      const body = req.body as Record<string, unknown>;
      
      if (body.max_tokens) {
        const maxTokens = typeof body.max_tokens === 'number' 
          ? body.max_tokens 
          : parseInt(String(body.max_tokens), 10);
        
        if (!isNaN(maxTokens)) {
          const estimatedOutputCost = (maxTokens / 1_000_000) * 15;
          const estimatedInputCost = 0.001;
          return estimatedInputCost + estimatedOutputCost;
        }
      }
      
      if (body.cost_estimate) {
        const cost = typeof body.cost_estimate === 'number' 
          ? body.cost_estimate 
          : parseFloat(String(body.cost_estimate));
        
        if (!isNaN(cost)) {
          return cost;
        }
      }
    }
    
    return 0.001;
  }
  
  private extractActualCost(body: unknown): number | null {
    if (!body || typeof body !== 'object') {
      return null;
    }
    
    const obj = body as Record<string, unknown>;
    
    if (obj.actual_cost !== undefined) {
      return typeof obj.actual_cost === 'number' ? obj.actual_cost : null;
    }
    
    if (obj.usage && typeof obj.usage === 'object') {
      const usage = obj.usage as Record<string, unknown>;
      
      if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
        const promptTokens = typeof usage.prompt_tokens === 'number' 
          ? usage.prompt_tokens 
          : parseInt(String(usage.prompt_tokens), 10);
        const completionTokens = typeof usage.completion_tokens === 'number' 
          ? usage.completion_tokens 
          : parseInt(String(usage.completion_tokens), 10);
        
        if (!isNaN(promptTokens) && !isNaN(completionTokens)) {
          const inputCost = (promptTokens / 1_000_000) * 3;
          const outputCost = (completionTokens / 1_000_000) * 15;
          return inputCost + outputCost;
        }
      }
    }
    
    return null;
  }
  
  getBudgetService(): BudgetService {
    return this.budgetService;
  }
  
  getRateLimiterService(): RateLimiterService {
    return this.rateLimiterService;
  }
  
  getVirtualKeyService(): VirtualKeyService {
    return this.virtualKeyService;
  }
  
  async close(): Promise<void> {
    await this.cache.close();
  }
}

export function createFinOpsMiddleware(
  config?: FinOpsConfig
): FinOpsMiddleware {
  const builder = new FinOpsMiddlewareBuilder(config);
  return builder.create();
}

export async function setupFinOps(
  config?: FinOpsConfig
): Promise<{
  middleware: FinOpsMiddleware;
  services: {
    budget: BudgetService;
    rateLimiter: RateLimiterService;
    virtualKey: VirtualKeyService;
  };
  close: () => Promise<void>;
}> {
  const builder = new FinOpsMiddlewareBuilder(config);
  
  return {
    middleware: builder.create(),
    services: {
      budget: builder.getBudgetService(),
      rateLimiter: builder.getRateLimiterService(),
      virtualKey: builder.getVirtualKeyService(),
    },
    close: () => builder.close(),
  };
}
