/**
 * connectors/http.ts — outbound HTTP for connectors with SSRF protection.
 *
 * Connector base URLs are user-supplied (Jira site, Salesforce instance, ...), so they
 * must be https and must not point at loopback / private / link-local / metadata hosts.
 * Tests (and local dev against fixtures) can opt out with CONNECTORS_ALLOW_PRIVATE_URLS=1.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorError } from './types.js';

function isPrivateIp(ip: string): boolean {
  const a = ip.replace(/^::ffff:/, '');
  if (isIP(a) === 6) {
    const l = a.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [p, q] = a.split('.').map(Number);
  return (
    p === 10 || p === 127 || p === 0 ||
    (p === 169 && q === 254) ||            // link-local + cloud metadata
    (p === 172 && q >= 16 && q <= 31) ||
    (p === 192 && q === 168) ||
    (p === 100 && q >= 64 && q <= 127)     // CGNAT
  );
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorError(`Invalid URL: ${raw}`);
  }
  if (process.env.CONNECTORS_ALLOW_PRIVATE_URLS === '1') return url;
  if (url.protocol !== 'https:') throw new ConnectorError('Connector URLs must use https.');
  if (url.username || url.password) throw new ConnectorError('Credentials in URLs are not allowed.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map(r => r.address);
  if (addrs.length === 0) throw new ConnectorError(`Cannot resolve host ${host}.`);
  if (addrs.some(isPrivateIp)) throw new ConnectorError(`Host ${host} resolves to a private address; refusing.`);
  return url;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** JSON request with timeout, SSRF check and readable errors (never echoes credentials). */
export async function httpJson<T = any>(rawUrl: string, opts: HttpOptions = {}): Promise<T> {
  const url = await assertSafeUrl(rawUrl);
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    redirect: 'error', // a redirect could bounce a validated host to an internal one
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' (check the token and its scopes)' : '';
    throw new ConnectorError(`${url.hostname} responded ${res.status}${hint}: ${text.slice(0, 200)}`, 502);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorError(`${url.hostname} returned a non-JSON response.`, 502);
  }
}

/** Paginate with a callback that returns the next URL (or null). Capped to keep syncs bounded. */
export async function paginate<T>(
  first: string,
  fetchPage: (url: string) => Promise<{ items: T[]; next: string | null }>,
  maxPages = 20
): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  for (let i = 0; url && i < maxPages; i++) {
    const page = await fetchPage(url);
    out.push(...page.items);
    url = page.next;
  }
  return out;
}

/** Constant-time HMAC-SHA256 check of `sha256=<hex>` style signatures. */
export function verifyHmac(secret: string, rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const provided = signature.replace(/^sha256=/i, '').trim().toLowerCase();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireConfig(config: Record<string, any>, ...keys: string[]): void {
  const missing = keys.filter(k => !config[k]);
  if (missing.length) throw new ConnectorError(`Missing required config: ${missing.join(', ')}`);
}
