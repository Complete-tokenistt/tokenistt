import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateRequest, AuthError } from '../db/auth.js';

describe('Phase 1 — Auth Hardening & Fail-Closed Protection', () => {
  test('rejects request with 503 when GATEWAY_REQUIRE_AUTH is true and DATABASE_URL is missing', async () => {
    const origDbUrl = process.env.DATABASE_URL;
    const origRequireAuth = process.env.GATEWAY_REQUIRE_AUTH;

    try {
      delete process.env.DATABASE_URL;
      process.env.GATEWAY_REQUIRE_AUTH = 'true';

      await assert.rejects(
        async () => {
          await authenticateRequest('Bearer tktt_live_ws_user_123');
        },
        (err: any) => {
          assert.equal(err instanceof AuthError, true);
          assert.equal(err.statusCode, 503);
          assert.match(err.message, /DATABASE_URL is not configured/);
          return true;
        }
      );
    } finally {
      if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
      else delete process.env.DATABASE_URL;

      if (origRequireAuth) process.env.GATEWAY_REQUIRE_AUTH = origRequireAuth;
      else delete process.env.GATEWAY_REQUIRE_AUTH;
    }
  });

  test('rejects malformed token format when DATABASE_URL is present', async () => {
    const origDbUrl = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = 'postgres://fake:fake@localhost:5432/fake';

      await assert.rejects(
        async () => {
          await authenticateRequest('Bearer invalid-format');
        },
        (err: any) => {
          assert.equal(err instanceof AuthError, true);
          assert.match(err.message, /Invalid Authorization format/);
          return true;
        }
      );
    } finally {
      if (origDbUrl) process.env.DATABASE_URL = origDbUrl;
      else delete process.env.DATABASE_URL;
    }
  });
});

