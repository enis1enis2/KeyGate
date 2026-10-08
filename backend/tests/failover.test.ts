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
  ProviderRepo,
  RequestLogRepo,
  getDb,
} from '../src/db/index.js';
import { encryptSecret, generateGatewayToken } from '../src/crypto.js';
import { GatewayQuota } from '../src/engine/gateway-quota.js';
import { DEFAULT_ENDPOINT_PATHS, type OpenAIChatResponse, type ProviderSpec } from '../src/types/index.js';

const FAIL_A = 'fail-a';
const FAIL_B = 'fail-b';
const KEY_A = 'fail-key-a';
const KEY_B = 'fail-key-b';
const POOL = 'fail-chat-pool';
const GATEWAY_KEY_ID = 'gwk-fail';

type Scenario = 'ok' | 'rate-limit' | 'stall';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Echo the received chat body back with a provider prefix so tests can assert exactly what
// crossed the wire to each upstream (model, full messages array, etc).
function chatEcho(provider: string, body: { messages?: unknown }): unknown {
  return {
    id: `cmpl-${provider}`,
    object: 'chat.completion',
    created: 1,
    model: (body as { model?: string }).model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `FROM_${provider.toUpperCase()}:${JSON.stringify(body.messages ?? null)}`,
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };
}

describe('failover preserves full conversation context', () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let portA: number;
  let portB: number;
  let app: FastifyInstance;
  let appPort: number;
  let gatewayToken: string;
  let aScenario: Scenario = 'ok';

  beforeAll(async () => {
    getDb();

    // Upstream A is flaky: it can rate-limit or send headers and then stall its body.
    serverA = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const pathname = (req.url || '').split('?')[0] || '';
        if (pathname === '/v1/chat/completions' && req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { messages?: unknown };
          if (aScenario === 'rate-limit') {
            return json(res, 429, { error: { message: 'Rate limited on the API side.' } });
          }
          if (aScenario === 'stall') {
            // Send headers with a content-length we never deliver: headers arrive, body stalls.
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
            return;
          }
          return json(res, 200, chatEcho(FAIL_A, body));
        }
        return json(res, 404, { error: { message: `Unhandled mock route: ${req.method} ${pathname}` } });
      });
    });

    // Upstream B is healthy and yields a normal completion.
    serverB = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const pathname = (req.url || '').split('?')[0] || '';
        if (pathname === '/v1/chat/completions' && req.method === 'POST') {
          const body = JSON.parse(raw.toString('utf8') || '{}') as { messages?: unknown };
          return json(res, 200, chatEcho(FAIL_B, body));
        }
        return json(res, 404, { error: { message: `Unhandled mock route: ${req.method} ${pathname}` } });
      });
    });

    await new Promise<void>((resolve) => {
      serverA.listen(0, '127.0.0.1', () => {
        portA = (serverA.address() as AddressInfo).port;
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      serverB.listen(0, '127.0.0.1', () => {
        portB = (serverB.address() as AddressInfo).port;
        resolve();
      });
    });

    const mkSpec = (id: string, name: string, port: number): ProviderSpec => ({
      id,
      name,
      preset: 'openai-compatible',
      base_url: `http://127.0.0.1:${port}/v1`,
      endpoint_paths: { chat: DEFAULT_ENDPOINT_PATHS.chat },
      http_method: 'POST',
      auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
      error_classification: [{ status_codes: [429], error_type: 'rate_limit' }],
    });

    ProviderRepo.create({
      id: FAIL_A,
      name: 'Failover Upstream A',
      preset: 'openai-compatible',
      spec_yaml: yaml.stringify(mkSpec(FAIL_A, 'Failover Upstream A', portA)),
    });
    ProviderRepo.create({
      id: FAIL_B,
      name: 'Failover Upstream B',
      preset: 'openai-compatible',
      spec_yaml: yaml.stringify(mkSpec(FAIL_B, 'Failover Upstream B', portB)),
    });

    const encA = encryptSecret('secret-a');
    const encB = encryptSecret('secret-b');
    ApiKeyRepo.delete(KEY_A);
    ApiKeyRepo.delete(KEY_B);
    ApiKeyRepo.create({
      id: KEY_A,
      provider_id: FAIL_A,
      key_name: 'Failover Key A',
      encrypted_key: encA.encrypted,
      iv: encA.iv,
      tag: encA.tag,
      key_prefix: 'sk-',
      key_suffix: '-a',
    });
    ApiKeyRepo.create({
      id: KEY_B,
      provider_id: FAIL_B,
      key_name: 'Failover Key B',
      encrypted_key: encB.encrypted,
      iv: encB.iv,
      tag: encB.tag,
      key_prefix: 'sk-',
      key_suffix: '-b',
    });

    ModelAliasRepo.upsert({
      id: 'alias-fail-chat-pool',
      alias_name: POOL,
      strategy: 'priority',
      targets_json: JSON.stringify([
        { provider_id: FAIL_A, model: 'fail-chat-model', weight: 1, priority: 1 },
        { provider_id: FAIL_B, model: 'fail-chat-model', weight: 1, priority: 2 },
      ]),
      endpoint_kind: 'chat',
      timeout_ms: 2000,
      is_active: true,
    });

    const token = generateGatewayToken('kg-fail');
    gatewayToken = token.rawToken;
    GatewayKeyRepo.create({
      id: GATEWAY_KEY_ID,
      name: 'Failover Test Client',
      token_hash: token.tokenHash,
      token_prefix: token.tokenPrefix,
      token_suffix: token.tokenSuffix,
      allowed_aliases_json: '["*"]',
    });

    app = await buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    appPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    if (app) await app.close();
    for (const server of [serverA, serverB]) {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  beforeEach(() => {
    GatewayQuota.reset();
    // Each test starts with both upstream keys healthy, so a cooldown from a previous
    // test cannot steer routing away from provider A.
    ApiKeyRepo.updateCircuitState(KEY_A, 'CLOSED', 0, 0, undefined, undefined);
    ApiKeyRepo.updateCircuitState(KEY_B, 'CLOSED', 0, 0, undefined, undefined);
    aScenario = 'ok';
  });

  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
      body: JSON.stringify(body),
    });

  it('kept the full conversation when upstream A rate-limited and failover hit B', async () => {
    aScenario = 'rate-limit';

    const messages = [
      { role: 'system', content: 'You are the context keeper.' },
      { role: 'user', content: 'First turn: what is my name?' },
      { role: 'assistant', content: 'Your name is Enis.' },
      { role: 'user', content: 'Second turn: remember my name now.' },
    ];

    const res = await post('/v1/chat/completions', { model: POOL, messages, stream: false });
    expect(res.status).toBe(200);

    const body = (await res.json()) as OpenAIChatResponse;
    const raw = body.choices?.[0]?.message?.content ?? '';
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
    expect(content).toMatch(/^FROM_FAIL-B:/);
    // The provider B received the exact same messages array the client sent (no context loss).
    const transmitted = JSON.parse(content.slice('FROM_FAIL-B:'.length)) as typeof messages;
    expect(transmitted).toEqual(messages);

    expect(res.headers.get('x-keygate-provider')).toBe(FAIL_B);
    expect(res.headers.get('x-keygate-model')).toBe('fail-chat-model');
    expect(GatewayQuota.peek(GATEWAY_KEY_ID).tokens).toBe(12);

    const traceId = res.headers.get('x-trace-id')!;
    const logs = RequestLogRepo.getRecent(20).filter((log) => log.trace_id === traceId);
    expect(
      logs.some((log) => log.provider_id === FAIL_A && log.status === 'error' && log.error_type === 'rate_limit')
    ).toBe(true);
    expect(logs.some((log) => log.provider_id === FAIL_B && log.status === 'success')).toBe(true);
    // The failed attempt must not meter tokens toward the gateway's TPM budget.
    const failed = logs.find((log) => log.provider_id === FAIL_A);
    expect(failed!.prompt_tokens).toBe(0);
    expect(failed!.completion_tokens).toBe(0);
  });

  it('failed over to B when A sent headers then stalled its body, within the configured timeout', async () => {
    aScenario = 'stall';

    const messages = [{ role: 'user', content: 'Respond slowly.' }];
    const startedAt = Date.now();
    const res = await post('/v1/chat/completions', { model: POOL, messages, stream: false });
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    // Failover happened well before undici's ~5 minute default body timeout.
    expect(elapsed).toBeLessThan(15_000);

    const body = (await res.json()) as OpenAIChatResponse;
    const raw = body.choices?.[0]?.message?.content ?? '';
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
    expect(content).toMatch(/^FROM_FAIL-B:/);
    const transmitted = JSON.parse(content.slice('FROM_FAIL-B:'.length)) as typeof messages;
    expect(transmitted).toEqual(messages);

    const traceId = res.headers.get('x-trace-id')!;
    const logs = RequestLogRepo.getRecent(20).filter((log) => log.trace_id === traceId);
    expect(
      logs.some((log) => log.provider_id === FAIL_A && log.status === 'error' && log.error_type === 'timeout')
    ).toBe(true);
    expect(logs.some((log) => log.provider_id === FAIL_B && log.status === 'success')).toBe(true);
  });

  it('used provider A directly when it is healthy', async () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const res = await post('/v1/chat/completions', { model: POOL, messages, stream: false });
    expect(res.status).toBe(200);

    const body = (await res.json()) as OpenAIChatResponse;
    expect(String(body.choices?.[0]?.message?.content ?? '')).toMatch(/^FROM_FAIL-A:/);
    expect(res.headers.get('x-keygate-provider')).toBe(FAIL_A);
  });
});