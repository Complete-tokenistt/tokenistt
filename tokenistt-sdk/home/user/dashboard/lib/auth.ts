/**
 * lib/auth.ts — Authentication and Session management for Tokenistt Dashboard.
 * Uses native node:crypto for high performance, zero external C-bindings.
 */

import { scrypt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { Role } from './rbac';

const scryptAsync = promisify(scrypt);

const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_SECRET || 'dev-tokenistt-insecure-jwt-secret-change-me';

export interface AuthSession {
  sub: string;       // user public_id
  orgId: string;     // organization id or public_id
  email: string;
  role: Role;
  exp: number;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  if (!salt || !key) return false;
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const keyBuffer = Buffer.from(key, 'hex');
  if (derived.length !== keyBuffer.length) return false;
  return timingSafeEqual(new Uint8Array(derived), new Uint8Array(keyBuffer));
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

export function signJwt(payload: Omit<AuthSession, 'exp'>, expiresInSeconds = 86400): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload: AuthSession = { ...payload, exp };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const hmac = createHmac('sha256', JWT_SECRET);
  hmac.update(signatureInput);
  const signature = hmac.digest('base64url');

  return `${signatureInput}.${signature}`;
}

export function verifyJwt(token: string): AuthSession | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signature] = parts;

    const signatureInput = `${headerB64}.${payloadB64}`;
    const hmac = createHmac('sha256', JWT_SECRET);
    hmac.update(signatureInput);
    const expectedSig = hmac.digest('base64url');

    if (signature.length !== expectedSig.length) return null;
    if (!timingSafeEqual(new Uint8Array(Buffer.from(signature)), new Uint8Array(Buffer.from(expectedSig)))) return null;

    const payload: AuthSession = JSON.parse(base64UrlDecode(payloadB64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

export function getSessionFromRequest(req: NextRequest): AuthSession | null {
  // 1. Check Bearer Authorization header
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const session = verifyJwt(token);
    if (session) return session;
  }

  // 2. Check cookie
  const cookie = req.cookies.get('tokenistt_session');
  if (cookie?.value) {
    const session = verifyJwt(cookie.value);
    if (session) return session;
  }

  // 3. Fallback for development / mock mode if not in production
  if (process.env.NODE_ENV !== 'production' && !process.env.STRICT_AUTH) {
    return {
      sub: '00000000-0000-0000-0000-000000000001',
      orgId: '1',
      email: 'dev@tokenistt.ai',
      role: 'owner',
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
  }

  return null;
}

export function unauthorizedResponse(message = 'Unauthorized'): NextResponse {
  return NextResponse.json({ error: { message, status: 401 } }, { status: 401 });
}

export function forbiddenResponse(message = 'Forbidden: insufficient role permissions'): NextResponse {
  return NextResponse.json({ error: { message, status: 403 } }, { status: 403 });
}
