import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';
import { buildServer } from '../src/server.js';
import {
  ApiKeyRepo,
  GatewayKeyRepo,
  ModelAliasRepo,
  PricingRepo,
  ProviderRepo,
  RequestLogRepo,
  StickyRouteRepo,
  getDb,
} from '../src/db/index.js';
import { encryptSecret, generateGatewayToken } from '../src/crypto.js';
import { GatewayQuota } from '../src/engine/gateway-quota.js';
import { DEFAULT_ENDPOINT_PATHS, type ProviderSpec } from '../src/types/index.js';

const PROVIDER_ID = 'proxy-upstream';
const KEY_ID = 'proxy-key-a';
const POOL = 'proxy-pool';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('Phase 2: shared proxy pipeline', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let app: FastifyInstance;
  let appPort: number;
  let gatewayToken: string;
  let restrictedToken: string;

  // Captured by the mock upstream so tests can assert what actually crossed the wire.
  const captured: {
    models: string[];
    jsonContentType: string | null;
    multipartContentType: string | null;
    multipartBody: string | null;
  } = { models: [], jsonContentType: null, multipartContentType: null, multipartBody: null };

  beforeAll(async () => {
    getDb();

    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const pathname = (req.url || '').split('?')[0] || '';
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

        if (pathname === '/v1/responses' && req.method === 'POST') {
          captured.jsonContentType = String(req.headers['content-type'] || '');
          const body = JSON.parse(raw.toString('utf8')) as { model?: string };
          captured.models.push(String(body.model ?? ''));
          return json(res, 200, {
            object: 'response',
            id: 'resp_1',
            model: body.model,
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          });
        }

        if (pathname === '/v1/completions' && req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8')) as { model?: string };
          captured.models.push(String(body.model ?? ''));
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: {"id":"cmpl-1","choices":[{"text":"Hello from completions"}]}\n\n');
          res.write(
            'data: {"id":"cmpl-1","usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n'
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (pathname === '/v1/moderations' && req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8')) as { model?: string };
          captured.models.push(String(body.model ?? ''));
          return json(res, 200, { id: 'modr_1', model: body.model, results: [{ flagged: false }] });
        }

        if (pathname === '/v1/images/generations' && req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8')) as { model?: string };
          captured.models.push(String(body.model ?? ''));
          return json(res, 200, { created: 1, data: [{ b64_json: 'GENERATED' }] });
        }

        if (pathname === '/v1/images/edits' && req.method === 'POST') {
          captured.multipartContentType = String(req.headers['content-type'] || '');
          captured.multipartBody = raw.toString('latin1');
          return json(res, 200, { created: 1, data: [{ b64_json: 'EDITED' }] });
        }

        if (pathname === '/v1/audio/speech' && req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8')) as { model?: string };
          captured.models.push(String(body.model ?? ''));
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
          res.end(Buffer.from('FAKE_MP3_BYTES'));
          return;
        }

        if (pathname === '/v1/batches' && req.method === 'POST') {
          return json(res, 200, { id: `batch_${token}`, object: 'batch', status: 'validating' });
        }

        if (pathname.endsWith('/cancel')) {
          if (token !== 'key-a') return json(res, 404, { error: { message: 'No such batch.' } });
          return json(res, 200, {
            id: pathname.split('/')[3],
            object: 'batch',
            status: 'cancelling',
            via: token,
          });
        }

        if (pathname.startsWith('/v1/batches/')) {
          // Only the account that created the batch can see it.
          if (token !== 'key-a') return json(res, 404, { error: { message: 'No such batch.' } });
          return json(res, 200, {
            id: pathname.split('/').pop(),
            object: 'batch',
            status: 'completed',
            via: token,
          });
        }

        if (pathname === '/v1/files' && req.method === 'POST') {
          captured.multipartContentType = String(req.headers['content-type'] || '');
          captured.multipartBody = raw.toString('latin1');
          return json(res, 200, { id: 'file_abc', object: 'file', status: 'processed' });
        }

        if (pathname === '/v1/files/file_abc/content') {
          if (token !== 'key-a') return json(res, 404, { error: { message: 'No such file.' } });
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('FILECONTENT');
          return;
        }

        json(res, 404, { error: { message: `Unhandled mock route: ${req.method} ${pathname}` } });
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as AddressInfo).port;
        resolve();
      });
    });

    const spec: ProviderSpec = {
      id: PROVIDER_ID,
      name: 'Proxy Upstream',
      preset: 'openai-compatible',
      base_url: `http://127.0.0.1:${mockPort}/v1`,
      endpoint_paths: {
        responses: DEFAULT_ENDPOINT_PATHS.responses,
        completions: DEFAULT_ENDPOINT_PATHS.completions,
        moderations: DEFAULT_ENDPOINT_PATHS.moderations,
        images: DEFAULT_ENDPOINT_PATHS.images,
        images_edits: DEFAULT_ENDPOINT_PATHS.images_edits,
        audio_speech: DEFAULT_ENDPOINT_PATHS.audio_speech,
        batches: DEFAULT_ENDPOINT_PATHS.batches,
        files: DEFAULT_ENDPOINT_PATHS.files,
      },
      http_method: 'POST',
      auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
      model_name_map: { 'upstream-model': 'mapped-v9' },
      error_classification: [{ status_codes: [429], error_type: 'rate_limit' }],
    };

    ProviderRepo.create({
      id: PROVIDER_ID,
      name: spec.name,
      preset: 'openai-compatible',
      spec_yaml: yaml.stringify(spec),
    });

    const enc = encryptSecret('key-a');
    ApiKeyRepo.delete(KEY_ID);
    ApiKeyRepo.create({
      id: KEY_ID,
      provider_id: PROVIDER_ID,
      key_name: 'Proxy Key A',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'key-',
      key_suffix: '-a',
    });

    ModelAliasRepo.upsert({
      id: 'alias-proxy-pool',
      alias_name: POOL,
      strategy: 'priority',
      targets_json: JSON.stringify([
        { provider_id: PROVIDER_ID, model: 'upstream-model', weight: 1, priority: 1 },
      ]),
      endpoint_kind: 'responses',
      timeout_ms: 10000,
      is_active: true,
    });

    PricingRepo.upsert({
      provider_id: '*',
      model: 'upstream-model',
      input_per_mtok: 10,
      output_per_mtok: 20,
    });

    const unrestricted = generateGatewayToken('kg-test');
    gatewayToken = unrestricted.rawToken;
    GatewayKeyRepo.create({
      id: 'gwk-proxy-open',
      name: 'Proxy Test Client',
      token_hash: unrestricted.tokenHash,
      token_prefix: unrestricted.tokenPrefix,
      token_suffix: unrestricted.tokenSuffix,
      allowed_aliases_json: '["*"]',
    });

    const restricted = generateGatewayToken('kg-restricted');
    restrictedToken = restricted.rawToken;
    GatewayKeyRepo.create({
      id: 'gwk-proxy-scoped',
      name: 'Scoped Test Client',
      token_hash: restricted.tokenHash,
      token_prefix: restricted.tokenPrefix,
      token_suffix: restricted.tokenSuffix,
      allowed_aliases_json: JSON.stringify([POOL]),
    });

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    appPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  beforeEach(() => {
    GatewayQuota.reset();
    captured.models = [];
    captured.jsonContentType = null;
    captured.multipartContentType = null;
    captured.multipartBody = null;
  });

  const post = (path: string, body: unknown, token = gatewayToken, contentType = 'application/json') =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  const get = (path: string, token = gatewayToken) =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });

  it('proxies /v1/responses with pool routing, model mapping and usage metering', async () => {
    const res = await post('/v1/responses', {
      model: POOL,
      input: 'hello',
      stream: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; model: string; usage: { total_tokens: number } };
    expect(body.object).toBe('response');
    // The client-facing pool model was rewritten to the upstream's model_name_map value.
    expect(captured.models).toEqual(['mapped-v9']);
    expect(body.model).toBe('mapped-v9');
    expect(body.usage.total_tokens).toBe(15);
    expect(res.headers.get('x-keygate-provider')).toBe(PROVIDER_ID);
    expect(res.headers.get('x-keygate-model')).toBe('upstream-model');
    // `fetch` defaults string bodies to text/plain; the pipeline must declare JSON explicitly.
    expect(captured.jsonContentType).toContain('application/json');

    const traceId = res.headers.get('x-trace-id')!;
    const log = RequestLogRepo.getRecent(20).find((row) => row.trace_id === traceId);
    expect(log).toBeDefined();
    expect(log!.endpoint).toBe('responses');
    expect(log!.model).toBe('upstream-model');
    expect(log!.pool_name).toBe(POOL);
    expect(log!.prompt_tokens).toBe(10);
    expect(log!.completion_tokens).toBe(5);
    // 10 input @ $10/M + 5 output @ $20/M
    expect(log!.cost).toBeCloseTo(0.0001 + 0.0001, 10);

    const quota = GatewayQuota.peek('gwk-proxy-open');
    expect(quota.requests).toBe(1);
    expect(quota.tokens).toBe(15);
  });

  it('streams /v1/completions through and backfills usage when the stream drains', async () => {
    const res = await post('/v1/completions', { model: POOL, prompt: 'hi', stream: true });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('Hello from completions');
    expect(text).toContain('data: [DONE]');

    const traceId = res.headers.get('x-trace-id')!;
    const log = RequestLogRepo.getRecent(20).find((row) => row.trace_id === traceId);
    expect(log).toBeDefined();
    expect(log!.endpoint).toBe('completions');
    expect(log!.prompt_tokens).toBe(7);
    expect(log!.completion_tokens).toBe(3);
    expect(log!.cost).toBeGreaterThan(0);
    expect(log!.is_stream).toBe(1);
  });

  it('proxies legacy /v1/moderations and /v1/images/generations', async () => {
    const moderations = await post('/v1/moderations', { model: POOL, input: 'bad words' });
    expect(moderations.status).toBe(200);
    const modBody = (await moderations.json()) as { results: unknown[] };
    expect(modBody.results).toHaveLength(1);

    const images = await post('/v1/images/generations', { model: POOL, prompt: 'a cat', n: 1 });
    expect(images.status).toBe(200);
    const imgBody = (await images.json()) as { data: Array<{ b64_json: string }> };
    expect(imgBody.data[0]?.b64_json).toBe('GENERATED');
  });

  it('forwards multipart image edits with a re-serialized boundary and mapped model', async () => {
    const form = new FormData();
    form.set('model', POOL);
    form.set('prompt', 'make it blue');
    form.set('image', new Blob([new Uint8Array([1, 2, 3, 4])]), 'sample.png');

    const res = await fetch(`http://127.0.0.1:${appPort}/v1/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayToken}` },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ b64_json: string }> };
    expect(body.data[0]?.b64_json).toBe('EDITED');

    expect(captured.multipartContentType).toMatch(
      /^multipart\/form-data; boundary=keygate-boundary-/
    );
    expect(captured.multipartBody).toContain('name="model"');
    expect(captured.multipartBody).toContain('mapped-v9');
    expect(captured.multipartBody).toContain('name="image"');
    expect(captured.multipartBody).toContain('filename="sample.png"');
  });

  it('pipes binary audio back without re-encoding', async () => {
    const res = await post('/v1/audio/speech', {
      model: POOL,
      input: 'hello world',
      voice: 'alloy',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/mpeg');
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe('FAKE_MP3_BYTES');
  });

  it('rejects a pool-scoped gateway key on a pool it is not allowed to reach', async () => {
    const res = await post('/v1/moderations', { model: 'other-pool', input: 'x' }, restrictedToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('model_not_allowed');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('answers unauthenticated calls on new surfaces with the OpenAI key error', async () => {
    const res = await post('/v1/responses', { model: POOL, input: 'x' }, 'bogus-token');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('rejects model-bearing surfaces that arrive without a model', async () => {
    const res = await post('/v1/responses', { input: 'x', stream: false });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('missing_required_fields');
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('pins a created batch to the upstream account that created it', async () => {
    const res = await post('/v1/batches', {
      model: POOL,
      input_file_id: 'file_abc',
      endpoint: '/v1/responses',
      completion_window: '24h',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('batch_key-a');

    const sticky = StickyRouteRepo.get('batch_key-a');
    expect(sticky).not.toBeNull();
    expect(sticky!.provider_id).toBe(PROVIDER_ID);
    expect(sticky!.key_id).toBe(KEY_ID);
    expect(sticky!.pool_name).toBe(POOL);
    expect(sticky!.endpoint).toBe('batches');
  });

  it('still serves the pinned batch after its upstream key is budget-blocked', async () => {
    // Exhaust the only key's daily budget: normal routing now has zero candidates.
    ApiKeyRepo.delete(KEY_ID);
    const enc = encryptSecret('key-a');
    ApiKeyRepo.create({
      id: KEY_ID,
      provider_id: PROVIDER_ID,
      key_name: 'Proxy Key A',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'key-',
      key_suffix: '-a',
      daily_budget_cap: 0.000001,
    });
    RequestLogRepo.insert({
      id: 'log-budget-blocker',
      trace_id: 'trace-budget-blocker',
      gateway_key_id: null,
      alias_name: POOL,
      provider_id: PROVIDER_ID,
      key_id: KEY_ID,
      model: 'upstream-model',
      status: 'success',
      status_code: 200,
      error_type: null,
      latency_ms: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
      is_stream: 0,
      is_hedged: 0,
      request_snippet: null,
      response_snippet: null,
      endpoint: 'responses',
      cost: 0.5,
      pool_name: POOL,
      created_at: new Date().toISOString(),
    });

    // Sticky replay bypasses candidate selection, so the pinned batch still resolves.
    const pinned = await get('/v1/batches/batch_key-a');
    expect(pinned.status).toBe(200);
    const pinnedBody = (await pinned.json()) as { via: string };
    expect(pinnedBody.via).toBe('key-a');

    // The static `/cancel` suffix is appended after the resource id upstream.
    const cancelled = await post('/v1/batches/batch_key-a/cancel', {});
    expect(cancelled.status).toBe(200);
    const cancelBody = (await cancelled.json()) as { id: string; status: string; via: string };
    expect(cancelBody.id).toBe('batch_key-a');
    expect(cancelBody.status).toBe('cancelling');
    expect(cancelBody.via).toBe('key-a');

    // A non-sticky request has no budget-eligible key left and is refused as a quota error.
    const rejected = await post('/v1/moderations', { model: POOL, input: 'x' });
    expect(rejected.status).toBe(429);
    const rejectedBody = (await rejected.json()) as { error: { code: string; type: string } };
    expect(rejectedBody.error.code).toBe('quota_exhausted');
    expect(rejectedBody.error.type).toBe('insufficient_quota');

    // Restore the key for later runs.
    ApiKeyRepo.delete(KEY_ID);
    ApiKeyRepo.create({
      id: KEY_ID,
      provider_id: PROVIDER_ID,
      key_name: 'Proxy Key A',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'key-',
      key_suffix: '-a',
    });
  });

  it('serves pinned file content as a binary stream', async () => {
    const created = await fetch(`http://127.0.0.1:${appPort}/v1/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayToken}` },
      body: (() => {
        const form = new FormData();
        form.set('purpose', 'fine-tune');
        form.set('file', new Blob([new Uint8Array([9, 9, 9])]), 'data.jsonl');
        return form;
      })(),
    });
    expect(created.status).toBe(200);
    expect((await created.json() as { id: string }).id).toBe('file_abc');
    expect(StickyRouteRepo.get('file_abc')).not.toBeNull();

    const content = await get('/v1/files/file_abc/content');
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toContain('text/plain');
    expect(await content.text()).toBe('FILECONTENT');
  });

  it('purges sticky routes older than the retention window', () => {
    getDb().prepare(`UPDATE sticky_routes SET created_at = datetime('now', '-40 days')`).run();
    expect(StickyRouteRepo.purgeOlderThan(30)).toBeGreaterThanOrEqual(1);
    expect(StickyRouteRepo.get('batch_key-a')).toBeNull();
    expect(StickyRouteRepo.get('file_abc')).toBeNull();
  });
});
