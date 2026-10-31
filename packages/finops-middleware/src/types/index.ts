import { Request, Response, NextFunction } from 'express';

// Virtual key token format: tktt_live_{workspace}_{user}_{hash}
// Example: tktt_live_acme_jane_abc123def456

export interface VirtualKeyToken {
  prefix: 'tktt_live' | 'tktt_test';
  workspace: string;
  userId: string;
  hash: string;
  raw: string;
}

export interface VirtualKeyLookupResult {
  virtualKeyId: string;
  realApiKey: string;
  userId: string;
  workspace: string;
  costCenter: string;
  budgetLimit: number;       // Max budget in dollars
  budgetRemaining: number;   // Current remaining budget in dollars
  budgetResetAt: Date;       // When the budget resets
  rateLimitPerMinute: number;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export interface AttributionContext {
  virtualKeyId: string;
  userId: string;
  workspace: string;
  costCenter: string;
  realApiKey: string;
  budgetRemaining: number;
  budgetLimit: number;
  rateLimitPerMinute: number;
}

export interface BudgetCheckResult {
  allowed: boolean;
  estimatedCost: number;
  remainingAfter: number;
  currentRemaining: number;
  limit: number;
  used: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export interface FinOpsConfig {
  redis?: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
  };
  cache?: {
    virtualKeyTtlSeconds?: number;
    budgetCheckTtlSeconds?: number;
    rateLimitWindowSeconds?: number;
  };
  defaults?: {
    rateLimitPerMinute?: number;
    budgetLimit?: number;
  };
  onBudgetExceeded?: (context: AttributionContext, result: BudgetCheckResult) => void;
  onRateLimitExceeded?: (context: AttributionContext, result: RateLimitResult) => void;
  onVirtualKeyNotFound?: (token: string) => void;
}

// Express middleware type
export type FinOpsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

// Extended Request with attribution context
declare global {
  namespace Express {
    interface Request {
      attribution?: AttributionContext;
    }
  }
}

// Error types
export class FinOpsError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FinOpsError';
  }
}

export class BudgetExceededError extends FinOpsError {
  constructor(
    public limit: number,
    public used: number,
    public estimatedCost: number
  ) {
    super(
      'Budget exceeded',
      429,
      'BUDGET_EXCEEDED',
      { limit, used, estimatedCost }
    );
    this.name = 'BudgetExceededError';
  }
}

export class RateLimitExceededError extends FinOpsError {
  constructor(
    public retryAfterSeconds: number,
    public limit: number,
    public remaining: number
  ) {
    super(
      'Rate limit exceeded',
      429,
      'RATE_LIMIT_EXCEEDED',
      { retryAfterSeconds, limit, remaining }
    );
    this.name = 'RateLimitExceededError';
  }
}

export class InvalidTokenError extends FinOpsError {
  constructor(message: string) {
    super(message, 401, 'INVALID_TOKEN');
    this.name = 'InvalidTokenError';
  }
}

export class VirtualKeyDisabledError extends FinOpsError {
  constructor(virtualKeyId: string) {
    super(
      `Virtual key ${virtualKeyId} is disabled`,
      403,
      'VIRTUAL_KEY_DISABLED',
      { virtualKeyId }
    );
    this.name = 'VirtualKeyDisabledError';
  }
}
