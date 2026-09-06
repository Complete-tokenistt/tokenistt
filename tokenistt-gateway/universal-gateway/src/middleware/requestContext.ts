import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  traceId: string;
  startTimeHr: bigint;
  startTimeMs: number;
}

declare global {
  namespace Express {
    interface Request {
      context?: RequestContext;
    }
  }
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  const traceId = (req.headers['x-trace-id'] as string) || (req.headers['x-request-id'] as string) || randomUUID();
  const startTimeHr = process.hrtime.bigint();
  const startTimeMs = Date.now();

  req.context = {
    requestId,
    traceId,
    startTimeHr,
    startTimeMs,
  };

  // Set trace identifiers on response immediately
  res.setHeader('x-tokenistt-request-id', requestId);
  res.setHeader('x-tokenistt-trace-id', traceId);

  next();
}

export function getElapsedLatencyMs(req: Request): number {
  if (!req.context?.startTimeHr) return 0;
  const diffHr = process.hrtime.bigint() - req.context.startTimeHr;
  return Math.round(Number(diffHr) / 1_000_000);
}

