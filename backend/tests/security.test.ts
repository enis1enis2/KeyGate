import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';
import { buildServer } from '../src/server.js';
import {
  ApiKeyRepo,
  GatewayKeyRepo,
  ModelAliasRepo,
  RequestLogRepo,
  getDb,
} from '../src/db/index.js';
import type { RequestLogRecord } from '../src/types/index.js';
import { encryptSecret, generateGatewayToken } from '../src/crypto.js';
import { GatewayQuota } from '../src/engine/gateway-quota.js';
import { CircuitBreakerManager } from '../src/engine/circuit-breaker.js';
import type { ProviderSpec } from '../src/types/index.js';

// Security audit regression suite. Each block pins a trust-boundary behavior:
//  A. admin guard must cover every request-target shape that reaches /api or /metrics
//  B. passthrough must not escape the provider base_url path with dot segments
//  C. unknown model names must 404 instead of silently routing (pool-cap bypass)
//  D. passthrough must honor gateway-key pool scope
//  E. client-supplied x-trace-id must be validated and metering updates scoped by key

const PROVIDER_ID = 'sec-upstream';
const OTHER_PROVIDER_ID = 'sec-unrelated';
const KEY_ID = 'sec-key-a';
const POOL = 'sec-pool';
const UNRELATED_POOL = 'sec-unrelated-pool';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

interface RawResponse {
  status: number;
  body: string;
}

// Raw socket request so the exact request-target reaches the server unnormalized
// (HTTP clients normalize paths before sending; attackers do not).
function rawRequest(port: number, raw: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(raw);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(parseResponse(data)));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(parseResponse(data));
    }, 3000);
  });
}

function parseResponse(data: string): RawResponse {
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(data);
  const bodyIdx = data.indexOf('\r\n\r\n');
  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    body: bodyIdx >= 0 ? data.slice(bodyIdx + 4) : '',
  };
}

function rawGet(port: number, target: string, extraHeaders: string[] = []): Promise<RawResponse> {
  const headers = ['Host: 127.0.0.1', 'Connection: close', ...extraHeaders].join('\r\n');
  return rawRequest(port, `GET ${target} HTTP/1.1\r\n${headers}\r\n\r\n`);
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

describe('security audit regressions', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let app: FastifyInstance;
  let appPort: number;
  let fullToken: string;
  let scopedOkToken: string;
  let scopedNoToken: string;
  const adminToken = process.env.KEYGATE_ADMIN_TOKEN!;

  /** Every path the mock upstream actually received. */
  const mockPaths: string[] = [];
  const mockHeaders: http.IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    getDb();

    mockServer = http.createServer((req, res) => {
      mockPaths.push(req.url || '');
      mockHeaders.push(req.headers);
      const pathname = (req.url || '').split('?')[0] || '';
      const raw: Buffer[] = [];
      req.on('data', (c) => raw.push(c));
      req.on('end', () => {
        if (pathname === '/v1/chat/completions') {
          return json(res, 200, {
            id: 'chatcmpl-sec',
            object: 'chat.completion',
            created: 1,
            model: 'up-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }
        if (pathname === '/v1/models') {
          return json(res, 200, { object: 'list', data: [] });
        }
        if (pathname === '/v1/moderations') {
          return json(res, 200, { id: 'modr_sec', results: [{ flagged: false }] });
        }
        json(res, 404, { error: { message: `unhandled ${pathname}` } });
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
      name: 'Sec Upstream',
      preset: 'openai-compatible',
      base_url: `http://127.0.0.1:${mockPort}/v1`,
      endpoint_paths: {
        chat: '/chat/completions',
        moderations: '/moderations',
        models: '/models',
      },
      http_method: 'POST',
      auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
    };
    const specYaml = yaml.stringify(spec);

    // Only this provider declares a moderations path, so the first-active-provider
    // fallback is deterministic in test C.
    const otherSpec = {
      id: OTHER_PROVIDER_ID,
      name: 'Sec Unrelated',
      preset: 'openai-compatible',
      base_url: `http://127.0.0.1:${mockPort}/v1`,
      endpoint_paths: { chat: '/chat/completions' },
      auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
    };

    getDb()
      .prepare(
        `INSERT INTO providers (id, name, description, preset, spec_yaml, is_active)
         VALUES (?, ?, NULL, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET spec_yaml = excluded.spec_yaml, is_active = 1`
      )
      .run(PROVIDER_ID, 'Sec Upstream', 'openai-compatible', specYaml);
    getDb()
      .prepare(
        `INSERT INTO providers (id, name, description, preset, spec_yaml, is_active)
         VALUES (?, ?, NULL, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET spec_yaml = excluded.spec_yaml, is_active = 1`
      )
      .run(OTHER_PROVIDER_ID, 'Sec Unrelated', 'openai-compatible', yaml.stringify(otherSpec));

    const enc = encryptSecret('sec-key');
    ApiKeyRepo.create({
      id: KEY_ID,
      provider_id: PROVIDER_ID,
      key_name: 'Sec Key',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'sec-',
      key_suffix: '-key',
    });

    ModelAliasRepo.upsert({
      id: 'alias-sec-pool',
      alias_name: POOL,
      strategy: 'priority',
      targets_json: JSON.stringify([
        { provider_id: PROVIDER_ID, model: 'up-model', weight: 1, priority: 1 },
      ]),
      is_active: true,
      timeout_ms: 10000,
    });
    ModelAliasRepo.upsert({
      id: 'alias-sec-unrelated',
      alias_name: UNRELATED_POOL,
      strategy: 'priority',
      targets_json: JSON.stringify([
        { provider_id: OTHER_PROVIDER_ID, model: 'other-model', weight: 1, priority: 1 },
      ]),
      is_active: true,
      timeout_ms: 10000,
    });

    const mkKey = (name: string, allowed: string[]): string => {
      const t = generateGatewayToken('kg-sec');
      GatewayKeyRepo.create({
        id: `gwk-${name}`,
        name,
        token_hash: t.tokenHash,
        token_prefix: t.tokenPrefix,
        token_suffix: t.tokenSuffix,
        allowed_aliases_json: JSON.stringify(allowed),
      });
      return t.rawToken;
    };
    fullToken = mkKey('full', ['*']);
    scopedOkToken = mkKey('scoped-ok', [POOL]);
    scopedNoToken = mkKey('scoped-no', [UNRELATED_POOL]);

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    appPort = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  beforeEach(() => {
    GatewayQuota.reset();
    // Isolate tests from circuit-breaker state left by earlier sub-cases.
    CircuitBreakerManager.getInstance().resetCircuit(KEY_ID);
    mockPaths.length = 0;
    mockHeaders.length = 0;
  });

  const post = (path: string, body: unknown, token = fullToken, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify(body),
    });

  // ---------------------------------------------------------------------
  // A. Management-plane guard vs router path normalization
  // ---------------------------------------------------------------------
  describe('admin guard covers every request-target shape', () => {
    it('rejects the plain management paths without credentials', async () => {
      const keys = await rawGet(appPort, '/api/keys');
      expect(keys.status).toBe(401);
      const metrics = await rawGet(appPort, '/metrics');
      expect(metrics.status).toBe(401);
    });

    it('still serves the admin API to an authenticated caller', async () => {
      const res = await rawGet(appPort, '/api/keys', [
        `Authorization: Bearer ${adminToken}`,
      ]);
      expect(res.status).toBe(200);
      expect(res.body).toContain('masked_key');
    });

    const expectNoManagementLeak = (res: RawResponse): void => {
      if (res.status === 200) {
        // The only thing that may be served without credentials is the public SPA shell.
        expect(res.body).toContain('<div id="root">');
      }
      expect(res.body).not.toContain('masked_key');
      expect(res.body).not.toContain('keygate_');
      expect(res.body).not.toContain('token_hash');
    };

    const suspiciousTargets = [
      '/%61pi/keys',
      '//api/keys',
      '/api%2fkeys',
      '/api/./keys',
      '/./api/keys',
      '/api/../api/keys',
      '/%2e%2e/api/keys',
      '/api/keys/',
      '/API/keys',
      '/api/keys%00',
      '/api/keys%20',
      '/metrics/',
      '/%6detrics',
      '//metrics',
      '/./metrics',
      '/metrics%2f',
      '/%2e%2e/metrics',
    ];

    for (const target of suspiciousTargets) {
      it(`does not serve management data unauthenticated for ${target}`, async () => {
        const res = await rawGet(appPort, target);
        expectNoManagementLeak(res);
      });
    }

    const absoluteFormTargets = ['/api/keys', '/metrics'];
    for (const path of absoluteFormTargets) {
      it(`does not serve management data unauthenticated for absolute-form ${path}`, async () => {
        const res = await rawGet(appPort, `http://127.0.0.1:${appPort}${path}`);
        expectNoManagementLeak(res);
      });
    }
  });

  // ---------------------------------------------------------------------
  // B. Passthrough must stay under the provider base_url path
  // ---------------------------------------------------------------------
  describe('passthrough path confinement', () => {
    const authHeader = () => [`Authorization: Bearer ${fullToken}`];

    it('serves a normal passthrough under the base path', async () => {
      const res = await rawGet(appPort, '/v1/passthrough/sec-upstream/models', authHeader());
      expect(res.status).toBe(200);
      expect(mockPaths.length).toBe(1);
      expect(mockPaths[0]).toBe('/v1/models');
    });

    const traversalTargets = [
      '/v1/passthrough/sec-upstream/../../../leak',
      '/v1/passthrough/sec-upstream/..%2f..%2f..%2fleak',
      '/v1/passthrough/sec-upstream/%2e%2e/%2e%2e/%2e%2e/leak',
      '/v1/passthrough/sec-upstream/%2e%2e%2f%2e%2e%2fleak',
      '/v1/passthrough/sec-upstream/foo/%2e%2e/%2e%2e/leak',
    ];

    for (const target of traversalTargets) {
      it(`keeps ${target} inside the provider base path`, async () => {
        await rawGet(appPort, target, authHeader());
        for (const seen of mockPaths) {
          expect(seen.startsWith('/v1/')).toBe(true);
          expect(seen).not.toMatch(/%2e/i);
          expect(decodeOnce(seen)).not.toMatch(/(^|\/)\.\.(\/|$)/);
        }
      });
    }
  });

  // ---------------------------------------------------------------------
  // C. Unknown model names must not route (pool-cap bypass)
  // ---------------------------------------------------------------------
  describe('unknown model names are rejected', () => {
    it('404s an unknown model on /v1/moderations instead of routing it', async () => {
      const res = await post('/v1/moderations', { model: 'definitely-not-a-pool', input: 'x' });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('model_not_found');
      expect(mockPaths.filter((p) => p.startsWith('/v1/moderations'))).toHaveLength(0);
    });

    it('404s an unknown model on /v1/chat/completions instead of routing it', async () => {
      const res = await post('/v1/chat/completions', {
        model: 'definitely-not-a-pool',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('model_not_found');
      expect(mockPaths.filter((p) => p.startsWith('/v1/chat/completions'))).toHaveLength(0);
    });

    it('still routes a registered pool', async () => {
      const res = await post('/v1/moderations', { model: POOL, input: 'x' });
      expect(res.status).toBe(200);
      expect(mockPaths.filter((p) => p.startsWith('/v1/moderations'))).toHaveLength(1);
    });

    it('still allows model-less surfaces (files/batches style requests)', async () => {
      const res = await fetch(`http://127.0.0.1:${appPort}/v1/models`, {
        headers: { Authorization: `Bearer ${fullToken}` },
      });
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // D. Passthrough honors gateway-key pool scope
  // ---------------------------------------------------------------------
  describe('passthrough pool scope', () => {
    it('allows an unrestricted key', async () => {
      const res = await rawGet(appPort, '/v1/passthrough/sec-upstream/models', [
        `Authorization: Bearer ${fullToken}`,
      ]);
      expect(res.status).toBe(200);
    });

    it('allows a scoped key whose pool targets the provider', async () => {
      const res = await rawGet(appPort, '/v1/passthrough/sec-upstream/models', [
        `Authorization: Bearer ${scopedOkToken}`,
      ]);
      expect(res.status).toBe(200);
    });

    it('denies a scoped key whose pools never target the provider', async () => {
      const res = await rawGet(appPort, '/v1/passthrough/sec-upstream/models', [
        `Authorization: Bearer ${scopedNoToken}`,
      ]);
      expect(res.status).toBe(403);
      const body = JSON.parse(res.body || '{}') as { error?: { code?: string } };
      expect(body.error?.code).toBe('model_not_allowed');
    });
  });

  // ---------------------------------------------------------------------
  // E. Client-supplied trace ids
  // ---------------------------------------------------------------------
  describe('x-trace-id handling', () => {
    it('refuses an unsafe client trace id and substitutes its own', async () => {
      const res = await post(
        '/v1/chat/completions',
        { model: POOL, messages: [{ role: 'user', content: 'hi' }] },
        fullToken,
        { 'x-trace-id': '../../evil trace id!' }
      );
      expect(res.status).toBe(200);
      const trace = res.headers.get('x-trace-id') || '';
      expect(trace).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    });

    it('keeps a safe client trace id for correlation', async () => {
      const res = await post(
        '/v1/chat/completions',
        { model: POOL, messages: [{ role: 'user', content: 'hi' }] },
        fullToken,
        { 'x-trace-id': 'trace-abc-12345' }
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-trace-id')).toBe('trace-abc-12345');
    });

    it('scopes usage finalization to the requesting gateway key', () => {
      const row = (id: string, keyId: string): RequestLogRecord => ({
        id,
        trace_id: 'shared-trace',
        gateway_key_id: keyId,
        alias_name: null,
        provider_id: PROVIDER_ID,
        key_id: KEY_ID,
        model: 'up-model',
        status: 'success',
        status_code: 200,
        error_type: null,
        latency_ms: 1,
        prompt_tokens: 0,
        completion_tokens: 0,
        is_stream: 0,
        is_hedged: 0,
        request_snippet: null,
        response_snippet: null,
        endpoint: 'chat',
        cost: 0,
        pool_name: null,
        created_at: new Date().toISOString(),
      });
      RequestLogRepo.insert(row('sec-log-a', 'gwk-a'));
      RequestLogRepo.insert(row('sec-log-b', 'gwk-b'));

      RequestLogRepo.finalizeUsage('shared-trace', 10, 5, 3.5, 'gwk-a');

      const a = RequestLogRepo.getRecent(50).find((r) => r.id === 'sec-log-a')!;
      const b = RequestLogRepo.getRecent(50).find((r) => r.id === 'sec-log-b')!;
      expect(a.cost).toBe(3.5);
      expect(a.prompt_tokens).toBe(10);
      // Another principal's row sharing the same trace id must stay untouched.
      expect(b.cost).toBe(0);
      expect(b.prompt_tokens).toBe(0);
    });
  });
});
