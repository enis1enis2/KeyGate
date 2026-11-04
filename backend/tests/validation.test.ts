import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';
import { buildServer } from '../src/server.js';
import { ProviderRepo, ModelAliasRepo, GatewayKeyRepo } from '../src/db/index.js';
import { generateGatewayToken } from '../src/crypto.js';
import type { ProviderSpec } from '../src/types/index.js';

// Regression coverage for the audit findings fixed in this change set:
//   H-4  mutating admin routes reject non-numeric / negative values with 400 instead of
//        silently coercing them to "unlimited" via `|| 0`.
//   M-1/L-5 security headers, admin auth boundary, and passthrough path/scope enforcement.
const ADMIN_TOKEN = process.env.KEYGATE_ADMIN_TOKEN as string;
const adminHeaders = {
  authorization: `Bearer ${ADMIN_TOKEN}`,
  'content-type': 'application/json',
};

describe('Request validation and boundary hardening', () => {
  let app: FastifyInstance;
  let scopedToken: string;
  let wildcardToken: string;

  beforeAll(async () => {
    const spec: ProviderSpec = {
      id: 'validation-provider',
      name: 'Validation Provider',
      base_url: 'https://validation.example.test/v1',
      endpoint_paths: { chat: '/chat/completions' },
      http_method: 'POST',
      auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
    };

    ProviderRepo.create({
      id: spec.id,
      name: spec.name,
      preset: 'custom',
      spec_yaml: yaml.stringify(spec),
    });

    // A provider with no upstream keys: lets the wildcard-scope test stop at the availability
    // check without making a network call.
    ProviderRepo.create({
      id: 'validation-empty-provider',
      name: 'Validation Empty Provider',
      preset: 'custom',
      spec_yaml: yaml.stringify({ ...spec, id: 'validation-empty-provider', name: 'Validation Empty Provider' }),
    });

    ModelAliasRepo.upsert({
      id: 'validation-pool-id',
      alias_name: 'validation-pool',
      strategy: 'weighted-by-health',
      targets_json: JSON.stringify([{ provider_id: spec.id, model: 'test-model' }]),
      is_active: true,
    });

    const scoped = generateGatewayToken('kg-test');
    GatewayKeyRepo.create({
      id: 'validation-scoped-key',
      name: 'Scoped key',
      token_hash: scoped.tokenHash,
      token_prefix: scoped.tokenPrefix,
      token_suffix: scoped.tokenSuffix,
      allowed_aliases_json: JSON.stringify(['some-other-pool']),
    });
    scopedToken = scoped.rawToken;

    const wildcard = generateGatewayToken('kg-test');
    GatewayKeyRepo.create({
      id: 'validation-wildcard-key',
      name: 'Wildcard key',
      token_hash: wildcard.tokenHash,
      token_prefix: wildcard.tokenPrefix,
      token_suffix: wildcard.tokenSuffix,
      allowed_aliases_json: JSON.stringify(['*']),
    });
    wildcardToken = wildcard.rawToken;

    app = await buildServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('rejects unauthenticated management writes with 401', async () => {
    const requests = [
      { url: '/api/keys', payload: { provider_id: 'x', key_name: 'x', api_key: 'sk-x' } },
      { url: '/api/gateway-keys', payload: { name: 'x' } },
      { url: '/api/aliases', payload: { alias_name: 'x', targets: [] } },
      { url: '/api/providers', payload: { spec_yaml: 'id: x' } },
    ];

    for (const request of requests) {
      const res = await app.inject({
        method: 'POST',
        url: request.url,
        headers: { 'content-type': 'application/json' },
        payload: request.payload,
      });
      expect(res.statusCode, request.url).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it('rejects a wrong admin token with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/gateway-keys',
      headers: { authorization: 'Bearer definitely-not-the-admin-token' },
      payload: { name: 'nope' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-numeric and negative key caps with 400 (H-4)', async () => {
    const invalidPayloads = [
      { provider_id: 'validation-provider', key_name: 'k', api_key: 'sk-x', rpm_cap: 'abc' },
      { provider_id: 'validation-provider', key_name: 'k', api_key: 'sk-x', rpm_cap: -1 },
      { provider_id: 'validation-provider', key_name: 'k', api_key: 'sk-x', tpm_cap: -5 },
      { provider_id: 'validation-provider', key_name: 'k', api_key: 'sk-x', daily_budget_cap: -0.01 },
      { provider_id: 'validation-provider', key_name: '', api_key: 'sk-x' },
      { provider_id: 'validation-provider', key_name: 'k', api_key: 'sk-x', rpm_cap: 1.5 },
    ];

    for (const payload of invalidPayloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/keys',
        headers: adminHeaders,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBeTruthy();
    }
  });

  it('coerces numeric strings for key caps instead of silently zeroing them', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: adminHeaders,
      payload: {
        provider_id: 'validation-provider',
        key_name: 'Coerced caps',
        api_key: 'sk-validation',
        rpm_cap: '10',
        tpm_cap: '2000',
        daily_budget_cap: '1.25',
      },
    });
    expect(create.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/keys', headers: adminHeaders });
    expect(list.statusCode).toBe(200);
    const created = (list.json() as Array<Record<string, unknown>>).find(
      (key) => key.key_name === 'Coerced caps'
    );
    expect(created).toMatchObject({ rpm_cap: 10, tpm_cap: 2000, daily_budget_cap: 1.25 });
  });

  it('validates gateway key creation payloads', async () => {
    const invalidPayloads = [
      {},
      { name: '' },
      { name: 'x', rpm_limit: -1 },
      { name: 'x', tpm_limit: 'many' },
      { name: 'x', allowed_aliases: { not: 'a list' } },
      { name: 'x', expires_in_days: 40000 },
    ];

    for (const payload of invalidPayloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/gateway-keys',
        headers: adminHeaders,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }

    const valid = await app.inject({
      method: 'POST',
      url: '/api/gateway-keys',
      headers: adminHeaders,
      payload: { name: 'Valid key', rpm_limit: 60, allowed_aliases: ['validation-pool'] },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().token).toMatch(/^kg-live_/);
  });

  it('validates AI pool payloads', async () => {
    const invalidPayloads = [
      { alias_name: 'no-targets' },
      { alias_name: '', targets: [] },
      { alias_name: 'bad-strategy', targets: [], strategy: 'random' },
      { alias_name: 'bad-target', targets: [{ provider_id: 'p' }] },
      { alias_name: 'negative-cap', targets: [], daily_token_cap: -1 },
      { alias_name: 'zero-timeout', targets: [], timeout_ms: 0 },
      { alias_name: 'bad-endpoint', targets: [], endpoint_kind: 'telepathy' },
    ];

    for (const payload of invalidPayloads) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/aliases',
        headers: adminHeaders,
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('sets security headers on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(String(res.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('rejects passthrough path traversal before reaching an upstream', async () => {
    // Encoded dots are normalised by the router itself (404). Every path that does reach the
    // handler is rejected with 400 invalid_path. Neither outcome forwards the request.
    const traversalPaths = [
      '/v1/passthrough/validation-provider/%2e%2e/%2e%2e/etc/passwd',
      '/v1/passthrough/validation-provider/..%2f..%2fetc%2fpasswd',
      '/v1/passthrough/validation-provider/%252e%252e/%252e%252e/etc/passwd',
      '/v1/passthrough/validation-provider/..%5c..%5cwindows',
    ];

    for (const url of traversalPaths) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${wildcardToken}` },
      });
      expect([400, 404], url).toContain(res.statusCode);
      if (res.statusCode === 400) {
        expect(res.json().error.code).toBe('invalid_path');
      }
    }
  });

  it('publishes an OpenAPI 3.1 document generated from route schemas', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(unauth.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/api/openapi.json',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);

    const doc = res.json() as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths['/api/keys']?.post).toBeTruthy();
    expect(doc.paths['/v1/chat/completions']?.post).toBeTruthy();
  });

  it('denies a side-scoped gateway key access to a provider outside its pools', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/passthrough/validation-provider/v1/messages',
      headers: { authorization: `Bearer ${scopedToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('model_not_allowed');
  });

  it('lets a wildcard key through the provider scope check', async () => {
    // The provider exists but has no upstream keys, so the request stops at the availability
    // check (503) rather than the scope check (403). That proves the wildcard key passed scope.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/passthrough/validation-empty-provider/v1/messages',
      headers: { authorization: `Bearer ${wildcardToken}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('upstream_unavailable');
  });
});
