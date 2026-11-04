import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Regression coverage for the audit finding fixed in this change set:
//   429 responses used to come back as 500 with an empty body because the rate-limit
//   errorResponseBuilder returned a plain object (no statusCode) that was then thrown.
// CONFIG snapshots these variables at import time, so they must be set before any import runs.
vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = '2';
  process.env.RATE_LIMIT_V1_MAX = '1';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
});

import { buildServer } from '../src/server.js';
import { GatewayKeyRepo } from '../src/db/index.js';
import { generateGatewayToken } from '../src/crypto.js';

describe('Rate limiting', () => {
  let app: FastifyInstance;
  let gatewayToken: string;

  beforeAll(async () => {
    // /v1 is authenticated by an onRequest hook before the rate-limit hooks run, so the
    // data-plane limit can only be observed with a valid gateway key.
    const token = generateGatewayToken('kg-test');
    GatewayKeyRepo.create({
      id: 'rate-limit-key',
      name: 'Rate limit key',
      token_hash: token.tokenHash,
      token_prefix: token.tokenPrefix,
      token_suffix: token.tokenSuffix,
      allowed_aliases_json: JSON.stringify(['*']),
    });
    gatewayToken = token.rawToken;

    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('returns 429 with Retry-After once the global budget is exhausted', async () => {
    // Distinct remote addresses keep this test in its own rate-limit bucket.
    const remoteAddress = '10.10.0.1';

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'GET', url: '/healthz', remoteAddress });
      expect(res.statusCode, `request ${i + 1} should be allowed`).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('2');
    }

    const limited = await app.inject({ method: 'GET', url: '/healthz', remoteAddress });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: expect.stringContaining('Rate limit exceeded') });
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('returns the OpenAI rate-limit envelope on /v1 routes', async () => {
    // The route-level budget is tighter (1) than the global one (2), so the second
    // request trips the /v1 limiter even though the global bucket still has room.
    const remoteAddress = '10.10.0.2';

    const first = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress,
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    expect(first.statusCode).toBe(200);

    const limited = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress,
      headers: { authorization: `Bearer ${gatewayToken}` },
    });
    expect(limited.statusCode).toBe(429);

    const body = limited.json() as { error?: { type?: string; code?: string } };
    expect(body.error?.type).toBe('rate_limit_error');
    expect(body.error?.code).toBe('rate_limit_exceeded');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
