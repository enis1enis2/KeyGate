import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { authorizeGatewayKey, isAliasAllowed, sendAuthError } from '../src/auth.js';
import { GatewayQuota } from '../src/engine/gateway-quota.js';
import { SmartRouter } from '../src/engine/router.js';
import { computeCost } from '../src/engine/pricing.js';
import {
  GatewayKeyRepo,
  ModelAliasRepo,
  ProviderRepo,
  ApiKeyRepo,
  PricingRepo,
  RequestLogRepo,
  getDb,
} from '../src/db/index.js';
import { encryptSecret, hashToken } from '../src/crypto.js';
import type { GatewayKeyRecord } from '../src/types/index.js';

function fakeRequest(token?: string): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as FastifyRequest;
}

function fakeReply(): { reply: FastifyReply; state: { status?: number; headers?: Record<string, string>; body?: unknown } } {
  const state: { status?: number; headers?: Record<string, string>; body?: unknown } = {};
  const reply = {
    status(code: number) {
      state.status = code;
      return reply;
    },
    headers(h: Record<string, string>) {
      state.headers = h;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

function createGatewayKey(opts: {
  id: string;
  token: string;
  rpm_limit?: number;
  tpm_limit?: number;
  allowed?: string;
}): void {
  GatewayKeyRepo.delete(opts.id);
  GatewayKeyRepo.create({
    id: opts.id,
    name: opts.id,
    token_hash: hashToken(opts.token),
    token_prefix: 'kgw',
    token_suffix: 'abc',
    rpm_limit: opts.rpm_limit ?? 0,
    tpm_limit: opts.tpm_limit ?? 0,
    allowed_aliases_json: opts.allowed ?? '["*"]',
  });
}

describe('Gateway key scope enforcement', () => {
  beforeEach(() => {
    GatewayQuota.reset();
    createGatewayKey({ id: 'gk-scope', token: 'tok-scope', allowed: '["code-fast"]' });
  });

  it('allows only the pools listed on the key', () => {
    const key = GatewayKeyRepo.getByHash(hashToken('tok-scope'));
    expect(key).not.toBeNull();
    expect(isAliasAllowed(key as GatewayKeyRecord, 'code-fast')).toBe(true);
    expect(isAliasAllowed(key as GatewayKeyRecord, 'other-pool')).toBe(false);
  });

  it('treats ["*"] as every pool', () => {
    createGatewayKey({ id: 'gk-open', token: 'tok-open', allowed: '["*"]' });
    const key = GatewayKeyRepo.getByHash(hashToken('tok-open'));
    expect(isAliasAllowed(key as GatewayKeyRecord, 'anything')).toBe(true);
  });

  it('denies a disallowed pool with 403 model_not_allowed', () => {
    const auth = authorizeGatewayKey(fakeRequest('tok-scope'), { alias: 'other-pool' });
    expect(auth.authenticated).toBe(false);
    expect(auth.denial).toBe('model_not_allowed');

    const { reply, state } = fakeReply();
    sendAuthError(reply, auth);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  it('permits the pool the key is scoped to', () => {
    const auth = authorizeGatewayKey(fakeRequest('tok-scope'), { alias: 'code-fast' });
    expect(auth.authenticated).toBe(true);
    expect(auth.keyId).toBe('gk-scope');
  });

  it('rejects a missing token with 401', () => {
    const auth = authorizeGatewayKey(fakeRequest());
    expect(auth.authenticated).toBe(false);
    expect(auth.denial).toBe('missing_token');

    const { reply, state } = fakeReply();
    sendAuthError(reply, auth);
    expect(state.status).toBe(401);
  });
});

describe('Gateway key rpm/tpm limits', () => {
  beforeEach(() => {
    GatewayQuota.reset();
    createGatewayKey({ id: 'gk-rpm', token: 'tok-rpm', rpm_limit: 2 });
    createGatewayKey({ id: 'gk-tpm', token: 'tok-tpm', tpm_limit: 100 });
  });

  it('allows requests up to the rpm limit then returns 429', () => {
    expect(authorizeGatewayKey(fakeRequest('tok-rpm')).authenticated).toBe(true);
    expect(authorizeGatewayKey(fakeRequest('tok-rpm')).authenticated).toBe(true);

    const third = authorizeGatewayKey(fakeRequest('tok-rpm'));
    expect(third.authenticated).toBe(false);
    expect(third.denial).toBe('rpm_limit_exceeded');

    const { reply, state } = fakeReply();
    sendAuthError(reply, third);
    expect(state.status).toBe(429);
    expect(state.headers?.['retry-after']).toBeDefined();
  });

  it('rejects once the tpm budget in the current minute is spent', () => {
    GatewayQuota.addTokens('gk-tpm', 100);
    const auth = authorizeGatewayKey(fakeRequest('tok-tpm'));
    expect(auth.authenticated).toBe(false);
    expect(auth.denial).toBe('tpm_limit_exceeded');
  });

  it('does not consume a slot when the key is over its rpm limit', () => {
    authorizeGatewayKey(fakeRequest('tok-rpm'));
    authorizeGatewayKey(fakeRequest('tok-rpm'));
    authorizeGatewayKey(fakeRequest('tok-rpm'));
    // Third was denied, so a later check must still see a full (not overflowing) window.
    expect(GatewayQuota.peek('gk-rpm').requests).toBe(2);
  });
});

describe('Daily budget enforcement', () => {
  const router = SmartRouter.getInstance();

  beforeEach(() => {
    const db = getDb();
    db.prepare(`DELETE FROM request_logs`).run();

    ProviderRepo.create({
      id: 'p-budget',
      name: 'Budget Provider',
      spec_yaml: 'id: p-budget\nname: Budget\nbase_url: https://budget.example.com',
    });

    for (const id of ['k-broke', 'k-rich']) ApiKeyRepo.delete(id);

    const enc = encryptSecret('upstream-key');
    ApiKeyRepo.create({
      id: 'k-broke',
      provider_id: 'p-budget',
      key_name: 'Broke Key',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'k-b',
      key_suffix: 'oke',
      daily_budget_cap: 0.01,
    });
    ApiKeyRepo.create({
      id: 'k-rich',
      provider_id: 'p-budget',
      key_name: 'Rich Key',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'k-r',
      key_suffix: 'ich',
      daily_budget_cap: 1000,
    });

    RequestLogRepo.insert({
      id: 'log-over-budget',
      trace_id: 'trace-budget',
      gateway_key_id: null,
      alias_name: 'budget-pool',
      provider_id: 'p-budget',
      key_id: 'k-broke',
      model: 'm',
      status: 'success',
      status_code: 200,
      error_type: null,
      latency_ms: 10,
      prompt_tokens: 0,
      completion_tokens: 0,
      is_stream: 0,
      is_hedged: 0,
      request_snippet: null,
      response_snippet: null,
      endpoint: 'chat',
      cost: 0.5,
      pool_name: 'budget-pool',
      created_at: new Date().toISOString(),
    });
  });

  it('excludes keys that already spent their daily budget', () => {
    const candidates = router.getCandidateKeys('p-budget');
    const ids = candidates.map((c) => c.key.id);
    expect(ids).not.toContain('k-broke');
    expect(ids).toContain('k-rich');
  });

  it('keeps keys with no budget cap eligible', () => {
    const enc = encryptSecret('open-key');
    ApiKeyRepo.create({
      id: 'k-open',
      provider_id: 'p-budget',
      key_name: 'Open Key',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'k-o',
      key_suffix: 'pen',
    });

    const ids = router.getCandidateKeys('p-budget').map((c) => c.key.id);
    expect(ids).toContain('k-open');
  });
});

describe('Pool daily caps', () => {
  const router = SmartRouter.getInstance();

  beforeEach(() => {
    getDb().prepare(`DELETE FROM request_logs`).run();

    ModelAliasRepo.upsert({
      id: 'alias-capped',
      alias_name: 'capped-pool',
      strategy: 'priority',
      targets_json: '[]',
      daily_spend_cap: 0.01,
      daily_token_cap: 0,
      hedging_enabled: false,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: true,
    });

    ModelAliasRepo.upsert({
      id: 'alias-token-capped',
      alias_name: 'token-capped-pool',
      strategy: 'priority',
      targets_json: '[]',
      daily_spend_cap: 0,
      daily_token_cap: 100,
      hedging_enabled: false,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: true,
    });

    RequestLogRepo.insert({
      id: 'log-pool-cap',
      trace_id: 'trace-pool-cap',
      gateway_key_id: null,
      alias_name: 'capped-pool',
      provider_id: 'p-none',
      key_id: 'k-none',
      model: 'm',
      status: 'success',
      status_code: 200,
      error_type: null,
      latency_ms: 5,
      prompt_tokens: 50,
      completion_tokens: 50,
      is_stream: 0,
      is_hedged: 0,
      request_snippet: null,
      response_snippet: null,
      endpoint: 'chat',
      cost: 0.5,
      pool_name: 'capped-pool',
      created_at: new Date().toISOString(),
    });

    RequestLogRepo.insert({
      id: 'log-pool-token-cap',
      trace_id: 'trace-pool-token-cap',
      gateway_key_id: null,
      alias_name: 'token-capped-pool',
      provider_id: 'p-none',
      key_id: 'k-none',
      model: 'm',
      status: 'success',
      status_code: 200,
      error_type: null,
      latency_ms: 5,
      prompt_tokens: 500,
      completion_tokens: 500,
      is_stream: 0,
      is_hedged: 0,
      request_snippet: null,
      response_snippet: null,
      endpoint: 'chat',
      cost: 0,
      pool_name: 'token-capped-pool',
      created_at: new Date().toISOString(),
    });
  });

  async function capture(fn: () => Promise<unknown>): Promise<unknown> {
    try {
      await fn();
      return null;
    } catch (err) {
      return err;
    }
  }

  it('rejects before dispatch when the pool spend cap is reached', async () => {
    const thrown = await capture(() =>
      router.routeChatCompletion('capped-pool', { model: 'm', messages: [] })
    );
    expect(thrown).toMatchObject({
      statusCode: 429,
      classified: { errorType: 'quota_exhausted' },
    });
  });

  it('rejects before dispatch when the pool token cap is reached', async () => {
    const thrown = await capture(() =>
      router.routeChatCompletion('token-capped-pool', { model: 'm', messages: [] })
    );
    expect(thrown).toMatchObject({
      statusCode: 429,
      classified: { errorType: 'quota_exhausted' },
    });
  });
});

describe('Pricing and cost calculation', () => {
  beforeEach(() => {
    getDb().prepare(`DELETE FROM model_pricing`).run();
  });

  it('uses the most specific pricing row', () => {
    PricingRepo.upsert({ provider_id: '*', model: '*', input_per_mtok: 1, output_per_mtok: 2 });
    expect(computeCost('any', 'any', 1_000_000, 1_000_000)).toBeCloseTo(3, 6);

    PricingRepo.upsert({ provider_id: 'p-x', model: '*', input_per_mtok: 10, output_per_mtok: 20 });
    expect(computeCost('p-x', 'whatever', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);

    PricingRepo.upsert({ provider_id: 'p-x', model: 'm', input_per_mtok: 100, output_per_mtok: 200 });
    expect(computeCost('p-x', 'm', 1_000_000, 1_000_000)).toBeCloseTo(300, 6);
  });

  it('returns zero when no pricing row matches and never goes negative', () => {
    expect(computeCost('missing', 'missing', 1000, 1000)).toBe(0);
    expect(computeCost('missing', 'missing', -5, -5)).toBe(0);
  });

  it('prices a partial-token request proportionally', () => {
    PricingRepo.upsert({ provider_id: 'p-y', model: 'm', input_per_mtok: 2, output_per_mtok: 4 });
    expect(computeCost('p-y', 'm', 500_000, 250_000)).toBeCloseTo(2, 6);
  });
});

describe('Schema migration', () => {
  it('adds pool and observability columns idempotently', () => {
    const db = getDb();
    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

    expect(columns('model_aliases')).toEqual(
      expect.arrayContaining(['description', 'endpoint_kind', 'daily_token_cap', 'daily_spend_cap'])
    );
    expect(columns('request_logs')).toEqual(
      expect.arrayContaining(['endpoint', 'cost', 'pool_name'])
    );
    expect(columns('model_pricing')).toEqual(
      expect.arrayContaining(['provider_id', 'model', 'input_per_mtok', 'output_per_mtok'])
    );
  });
});
