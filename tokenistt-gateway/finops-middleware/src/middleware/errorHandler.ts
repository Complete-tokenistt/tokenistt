import { Request, Response, NextFunction } from 'express';
import {
  FinOpsError,
  BudgetExceededError,
  RateLimitExceededError,
  InvalidTokenError,
  VirtualKeyDisabledError,
} from '../types/index.js';

export interface ErrorHandlerOptions {
  includeStackTrace?: boolean;
  logErrors?: boolean;
  onError?: (error: Error, req: Request, res: Response) => void;
}

export function createErrorHandler(options: ErrorHandlerOptions = {}): 
  (err: Error, req: Request, res: Response, next: NextFunction) => void {
  
  const {
    includeStackTrace = process.env.NODE_ENV === 'development',
    logErrors = true,
    onError,
  } = options;
  
  return (err: Error, req: Request, res: Response, _next: NextFunction): void => {
    // Log the error
    if (logErrors) {
      console.error(`[FinOps Error] ${err.name}: ${err.message}`);
      if (includeStackTrace) {
        console.error(err.stack);
      }
    }
    
    // Call custom error handler
    if (onError) {
      onError(err, req, res);
    }
    
    // Handle specific error types
    if (err instanceof BudgetExceededError) {
      res.status(429).json({
        error: err.message,
        code: err.code,
        limit: err.limit,
        used: err.used,
        estimatedCost: err.estimatedCost,
        type: 'budget_exceeded',
      });
      return;
    }
    
    if (err instanceof RateLimitExceededError) {
      res.status(429).json({
        error: err.message,
        code: err.code,
        limit: err.limit,
        remaining: err.remaining,
        retryAfterSeconds: err.retryAfterSeconds,
        type: 'rate_limit_exceeded',
      });
      return;
    }
    
    if (err instanceof InvalidTokenError) {
      res.status(401).json({
        error: err.message,
        code: err.code,
        type: 'invalid_token',
      });
      return;
    }
    
    if (err instanceof VirtualKeyDisabledError) {
      res.status(403).json({
        error: err.message,
        code: err.code,
        type: 'virtual_key_disabled',
      });
      return;
    }
    
    if (err instanceof FinOpsError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        type: err.name.toLowerCase().replace('error', ''),
        ...err.details,
      });
      return;
    }
    
    // Generic error response
    res.status(500).json({
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
      type: 'internal_error',
      ...(includeStackTrace && { message: err.message }),
    });
  };
}

// Default error handler
export const defaultErrorHandler = createErrorHandler();

// Request logging middleware
export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const attribution = req.attribution;
    
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} ` +
      `${res.statusCode} ${duration}ms ` +
      `${attribution ? `[${attribution.workspace}/${attribution.userId}]` : '[unauthenticated]'}` +
      `${attribution ? `[${attribution.costCenter}]` : ''}`
    );
  });
  
  next();
}

// Health check endpoint helper
export function createHealthCheck(
  services: {
    budget?: unknown;
    rateLimiter?: unknown;
    virtualKey?: unknown;
  }
) {
  return async (_req: Request, res: Response): Promise<void> => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        budget: !!services.budget,
        rateLimiter: !!services.rateLimiter,
        virtualKey: !!services.virtualKey,
      },
    });
  };
}
