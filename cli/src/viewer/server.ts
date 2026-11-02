/**
 * The local graph viewer's server. It only ever listens on loopback, and because any web page can try to reach a
 * localhost port, every data request must also carry the random token from the opening URL, and the Host header
 * must be the loopback address (which stops DNS rebinding). It serves the graph and nothing else, and changes nothing.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { git } from '../project/git.js';
import type { GraphIndex } from '../graph/query.js';
import type { GraphMetadata } from '../graph/store.js';
import { UsageError } from '../core/errors.js';

export const DEFAULT_ASSETS = fileURLToPath(new URL('../../dist/viewer-assets/', import.meta.url));

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const MAX_BODY = 8 * 1024 * 1024;

export interface ViewerOptions {
  index: GraphIndex;
  metadata?: GraphMetadata;
  root: string;
  port?: number;
  token?: string;
  assetsDir?: string;
}

export interface ViewerHandle {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function recentChanges(root: string, limit = 40): Array<{ path: string; commit: string; date: string; subject: string }> {
  try {
    const raw = git(root, ['log', '-n', '30', '--name-only', '--date=short', '--format=%x01%h%x09%ad%x09%s']);
    const out = new Map<string, { path: string; commit: string; date: string; subject: string }>();
    for (const block of raw.split('\x01').filter(Boolean)) {
      const [head = '', ...files] = block.split('\n');
      const [commit = '', date = '', subject = ''] = head.split('\t');
      for (const path of files.map((f) => f.trim()).filter(Boolean)) if (!out.has(path)) out.set(path, { path, commit, date, subject });
    }
    return [...out.values()].slice(0, limit);
  } catch {
    return [];
  }
}

function fileHistory(root: string, path: string): Promise<Array<{ commit: string; date: string; subject: string }>> {
  return new Promise((resolve) => {
    execFile('git', ['log', '-n', '5', '--date=short', '--format=%h%x09%ad%x09%s', '--', path], { cwd: root, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split('\n').filter(Boolean).map((l) => {
        const [commit = '', date = '', subject = ''] = l.split('\t');
        return { commit, date, subject };
      }));
    });
  });
}

export async function startViewer(opts: ViewerOptions): Promise<ViewerHandle> {
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const assets = opts.assetsDir ?? DEFAULT_ASSETS;
  const { index, root } = opts;
  let port = 0;

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  };

  const api = async (req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> => {
    const route = url.pathname;
    const id = url.searchParams.get('id') ?? '';
    if (req.method === 'POST' && route === '/api/subgraph') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return json(res, 413, { error: 'Too many visible nodes.' });
        chunks.push(c as Buffer);
      }
      let body: { visible?: unknown; types?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString()) as typeof body;
      } catch {
        return json(res, 400, { error: 'Invalid JSON.' });
      }
      if (!Array.isArray(body.visible)) return json(res, 400, { error: 'visible must be a list of node ids.' });
      const types = Array.isArray(body.types) ? new Set(body.types.map(String)) : undefined;
      return json(res, 200, { edges: index.rollup(new Set(body.visible.map(String)), types) });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    switch (route) {
      case '/api/overview':
        return json(res, 200, { metadata: opts.metadata ?? null, root: index.view('dir:.'), children: index.childrenOf('dir:.'), mostUsed: index.mostUsed() });
      case '/api/children':
        return json(res, 200, index.childrenOf(id, Number(url.searchParams.get('limit')) || 200));
      case '/api/search':
        return json(res, 200, { items: index.search(url.searchParams.get('q') ?? '') });
      case '/api/recent':
        return json(res, 200, { items: recentChanges(root).filter((c) => index.nodes.has(`file:${c.path}`)) });
      case '/api/ancestors':
        return json(res, 200, { ids: index.ancestors(id), nodes: index.ancestors(id).map((a) => index.childrenOf(a)) });
      case '/api/impact': {
        const direction = url.searchParams.get('direction') === 'dependencies' ? 'dependencies' : 'dependents';
        return json(res, 200, { items: index.traverse(id, direction, { maxDepth: Number(url.searchParams.get('depth')) || 6 }) });
      }
      case '/api/node': {
        const node = index.nodes.get(id);
        if (!node) return json(res, 404, { error: 'No such node.' });
        // Only paths the graph already knows reach git.
        const file = node.path && index.nodes.has(`file:${node.path}`) ? node.path : undefined;
        return json(res, 200, { node, view: index.view(id), ...index.relations(id), history: file ? await fileHistory(root, file) : [] });
      }
      default:
        return json(res, 404, { error: 'Not found.' });
    }
  };

  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const asset = ASSETS[url.pathname];
    if (asset) {
      if (req.method !== 'GET') { res.writeHead(405, SECURITY_HEADERS).end(); return; }
      readFile(`${assets.replace(/[\\/]$/, '')}/${asset.file}`)
        .then((content) => { res.writeHead(200, { 'content-type': asset.type, ...SECURITY_HEADERS }); res.end(content); })
        .catch(() => { res.writeHead(500, { 'content-type': 'text/plain', ...SECURITY_HEADERS }); res.end('Viewer assets are missing. Rebuild with: npm run build -w cli'); });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const supplied = String(req.headers['x-tokenistt-token'] ?? '');
      if (!sameToken(supplied, token)) return json(res, 401, { error: 'Missing or wrong token. Open the URL printed by tokenistt graph --open.' });
      api(req, url, res).catch((err: unknown) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
      return;
    }
    res.writeHead(404, SECURITY_HEADERS).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE' ? new UsageError(`Port ${opts.port} is already in use.`, 'Choose another with --port, or leave it out to use any free port.') : err);
    });
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    port,
    token,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
