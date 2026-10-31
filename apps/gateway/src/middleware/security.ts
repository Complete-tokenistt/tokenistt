/**
 * middleware/security.ts — CORS policy and /metrics access control.
 */
import type { Request, Response, NextFunction } from 'express';
import type { CorsOptions } from 'cors';
import { timingSafeEqual } from 'node:crypto';

/** CORS_ORIGINS=comma,separated,origins ; "*" allows all. Unset: dev allows localhost, production allows none. */
export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const raw = env.CORS_ORIGINS?.trim();
  if (raw === '*') return { origin: true };
  const allowed = raw
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : env.NODE_ENV === 'production'
      ? []
      : [/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
  return {
    origin: allowed.length === 0 ? false : allowed,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Secret', 'X-Organization-Id', 'x-provider',
      'x-tokenistt-team', 'x-tokenistt-project', 'x-tokenistt-environment', 'x-tokenistt-repo',
      'x-tokenistt-ticket', 'x-tokenistt-sprint', 'x-tokenistt-feature', 'x-tokenistt-customer', 'x-tokenistt-employee'],
    exposedHeaders: ['x-tokenistt-cost', 'x-tokenistt-request-id', 'x-tokenistt-budget-level'],
    maxAge: 600,
  };
}

function isPrivateAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const a = ip.replace(/^::ffff:/, '');
  return (
    a === '::1' || a === '127.0.0.1' ||
    /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  );
}

/**
 * /metrics access:
 *   METRICS_TOKEN set          → require `Authorization: Bearer <token>`
 *   unset, development         → open
 *   unset, production          → loopback / private network only
 */
export function metricsAccess(env: NodeJS.ProcessEnv = process.env) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = env.METRICS_TOKEN;
    if (token) {
      const header = req.headers.authorization ?? '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      const a = Buffer.from(token);
      const b = Buffer.from(provided);
      if (a.length === b.length && timingSafeEqual(a, b)) return next();
    } else if (env.NODE_ENV !== 'production' || isPrivateAddress(req.socket?.remoteAddress)) {
      return next();
    }
    res.status(401).json({ error: { message: 'Unauthorized', type: 'authentication_error' } });
  };
}
