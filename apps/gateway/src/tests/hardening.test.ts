import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../services/circuitBreaker.js';
import { corsOptions, metricsAccess } from '../middleware/security.js';

describe('circuit breaker', () => {
  it('opens after threshold failures, half-opens after cooldown, closes on success', () => {
    let t = 0;
    const b = new CircuitBreaker(3, 10_000, 5_000, () => t);
    assert.equal(b.allow('p'), true);
    b.failure('p'); b.failure('p');
    assert.equal(b.state('p'), 'closed');
    b.failure('p');
    assert.equal(b.state('p'), 'open');
    assert.equal(b.allow('p'), false);

    t += 5_000;
    assert.equal(b.state('p'), 'half-open');
    assert.equal(b.allow('p'), true, 'one trial admitted');
    assert.equal(b.allow('p'), false, 'second concurrent trial rejected');
    b.success('p');
    assert.equal(b.state('p'), 'closed');
  });

  it('failed trial re-opens; old failures age out of the window; keys are independent', () => {
    let t = 0;
    const b = new CircuitBreaker(2, 1_000, 1_000, () => t);
    b.failure('a'); t += 2_000; b.failure('a');
    assert.equal(b.state('a'), 'closed', 'first failure aged out');
    b.failure('a');
    assert.equal(b.state('a'), 'open');
    t += 1_000;
    assert.equal(b.allow('a'), true);
    b.failure('a');
    assert.equal(b.state('a'), 'open');
    assert.equal(b.state('b'), 'closed');
  });
});

describe('CORS policy', () => {
  it('production with no CORS_ORIGINS allows nothing; explicit list is honoured; * allows all', () => {
    assert.equal(corsOptions({ NODE_ENV: 'production' } as any).origin, false);
    assert.deepEqual(corsOptions({ CORS_ORIGINS: 'https://a.com, https://b.com' } as any).origin, ['https://a.com', 'https://b.com']);
    assert.equal(corsOptions({ CORS_ORIGINS: '*' } as any).origin, true);
  });
  it('development defaults to localhost only', () => {
    const o = corsOptions({ NODE_ENV: 'development' } as any).origin as RegExp[];
    assert.ok(o[0].test('http://localhost:3001'));
    assert.ok(!o[0].test('https://evil.com'));
  });
});

describe('/metrics access', () => {
  const run = (env: any, headers: any, ip: string) => {
    let status = 200; let nexted = false;
    const res: any = { status(s: number) { status = s; return this; }, json() { return this; } };
    metricsAccess(env)({ headers, socket: { remoteAddress: ip } } as any, res, () => { nexted = true; });
    return { status, nexted };
  };
  it('token required when METRICS_TOKEN set', () => {
    assert.equal(run({ METRICS_TOKEN: 's3cret' }, {}, '127.0.0.1').nexted, false);
    assert.equal(run({ METRICS_TOKEN: 's3cret' }, { authorization: 'Bearer wrong!' }, '127.0.0.1').nexted, false);
    assert.equal(run({ METRICS_TOKEN: 's3cret' }, { authorization: 'Bearer s3cret' }, '8.8.8.8').nexted, true);
  });
  it('production without a token allows only private networks; dev is open', () => {
    assert.equal(run({ NODE_ENV: 'production' }, {}, '8.8.8.8').status, 401);
    assert.equal(run({ NODE_ENV: 'production' }, {}, '10.1.2.3').nexted, true);
    assert.equal(run({ NODE_ENV: 'production' }, {}, '::ffff:127.0.0.1').nexted, true);
    assert.equal(run({ NODE_ENV: 'development' }, {}, '8.8.8.8').nexted, true);
  });
});
