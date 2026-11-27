import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = [
  '/api/auth/login',
  '/api/auth/register', // self-guarded: needs ADMIN_SECRET and only works while no user exists
  '/api/auth/setup-status',
  '/api/auth/logout',
  '/login',
  '/',
  '/onboarding',
  '/docs',
];

// ---------------------------------------------------------------------------
// JWT Secret validation (Edge-compatible, no Node.js APIs)
// ---------------------------------------------------------------------------

const INSECURE_JWT_DEFAULTS = [
  'dev-tokenistt-insecure-jwt-secret-change-me',
  'secret',
  'jwt-secret',
  'changeme',
  'default-secret',
  'insecure',
  'password',
];

const MIN_JWT_SECRET_LENGTH = 32;

function resolveJwtSecretEdge(): string | null {
  const raw = process.env.JWT_SECRET || process.env.ADMIN_SECRET;
  const isProduction = process.env.NODE_ENV === 'production' || process.env.STRICT_AUTH === 'true';

  if (isProduction) {
    if (!raw) return null;                                               // missing
    if (raw.length < MIN_JWT_SECRET_LENGTH) return null;                // too short
    if (INSECURE_JWT_DEFAULTS.includes(raw.toLowerCase())) return null; // insecure default
    return raw;
  }

  return raw || 'dev-tokenistt-insecure-jwt-secret-change-me';
}

const JWT_SECRET_RESOLVED = resolveJwtSecretEdge();

interface AuthSession {
  sub: string;
  orgId: string;
  email: string;
  role: string;
  exp: number;
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return atob(base64);
}

async function verifyJwtEdge(token: string, secret: string): Promise<AuthSession | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const data = enc.encode(`${headerB64}.${payloadB64}`);
    
    // Decode base64url signature
    let sigBase64 = signatureB64.replace(/-/g, '+').replace(/_/g, '/');
    while (sigBase64.length % 4) {
      sigBase64 += '=';
    }
    const sigBinary = atob(sigBase64);
    const sigBytes = new Uint8Array(sigBinary.length);
    for (let i = 0; i < sigBinary.length; i++) {
      sigBytes[i] = sigBinary.charCodeAt(i);
    }

    const isValid = await crypto.subtle.verify('HMAC', key, sigBytes, data);
    if (!isValid) return null;

    const payload: AuthSession = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 0. Open mode: no login. The sign-in page has nothing to do, so send it home.
  if (process.env.AUTH_MODE === 'open') {
    if (pathname === '/login') return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }

  // 1. Allow public routes
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    return NextResponse.next();
  }

  // 2. In local development without STRICT_AUTH, allow fallback
  if (process.env.NODE_ENV !== 'production' && !process.env.STRICT_AUTH) {
    return NextResponse.next();
  }

  // 3. Verify JWT secret is safe for production
  if (!JWT_SECRET_RESOLVED) {
    // Secret is missing or insecure — fail closed, do not serve any protected route
    console.error('[Security] JWT_SECRET is missing or insecure. Refusing to authenticate requests.');
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { message: 'Authentication service misconfigured. Contact support.' } },
        { status: 503 }
      );
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 4. Extract token from cookie or Authorization header
  let token = req.cookies.get('tokenistt_session')?.value;
  const authHeader = req.headers.get('authorization');
  if (!token && authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { message: 'Unauthorized', status: 401 } }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const session = await verifyJwtEdge(token, JWT_SECRET_RESOLVED);
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: { message: 'Session expired or invalid', status: 401 } }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 5. Inject verified identity headers into downstream request
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-org-id', session.orgId);
  requestHeaders.set('x-user-id', session.sub);
  requestHeaders.set('x-user-role', session.role);

  return NextResponse.next({ request: { headers: requestHeaders } });
}


export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.png).*)'],
};

