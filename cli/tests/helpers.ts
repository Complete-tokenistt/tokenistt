import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
export type Handler = (req: Recorded) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } | undefined;

/** A tiny stand-in for the gateway: routes by "METHOD /path", records every request. */
export async function fakeGateway(routes: Record<string, Handler | { status?: number; json?: unknown }>) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const rec: Recorded = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(rec);
      const route = routes[`${rec.method} ${rec.path}`];
      const out = typeof route === 'function' ? route(rec) : route;
      if (!out) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'no such route' } }));
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...('headers' in out ? (out as any).headers : {}) });
      res.end('text' in out && (out as any).text !== undefined ? (out as any).text : JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tokenistt-cli-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const WHOAMI = { actor: 'ada@example.com', role: 'admin', operator: false, organization: { id: '7', name: 'Acme', slug: 'acme' } };
export const HEALTH = { status: 'healthy', database: 'connected', providers: ['openai', 'mock'] };

/** A dashboard-shaped JWT (unsigned: the CLI only decodes it for display). */
export function fakeJwt(expOffsetSec = 3600): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub: 'u1', orgId: '7', role: 'admin', email: 'ada@example.com', exp: Math.floor(Date.now() / 1000) + expOffsetSec })}.sig-sig-sig`;
}

export function standardGateway() {
  return fakeGateway({
    'GET /health': { json: HEALTH },
    'GET /v1/admin/whoami': (r) => (r.headers.authorization || r.headers['x-admin-secret'] ? { json: WHOAMI } : { status: 401, json: { error: { message: 'Authentication required' } } }),
    'GET /v1/admin/workspaces': { json: [{ id: '1', name: 'Platform', cost_center: 'CC-1' }] },
    'GET /v1/admin/projects': { json: [{ id: '2', name: 'Search', slug: 'search', environment: 'production' }] },
    'GET /v1/usage/me': (r) => (r.headers.authorization === 'Bearer tktt_live_good_key_0123456789abcdef'
      ? { json: { key: { name: 'ci-key', prefix: 'tktt_live_good_ke...' }, month: { requests: 3, cost_usd: 0.12 } } }
      : { status: 401, json: { error: { message: 'Invalid or revoked key.' } } }),
  });
}
