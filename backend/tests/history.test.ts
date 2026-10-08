import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  getDb,
} from '../src/db/index.js';
import { encryptSecret, generateGatewayToken } from '../src/crypto.js';
import { GatewayQuota } from '../src/engine/gateway-quota.js';
import { DEFAULT_ENDPOINT_PATHS, type ChatHistoryRecord, type ProviderSpec } from '../src/types/index.js';

const PROVIDER = 'hist-provider';
const KEY_A = 'hist-key';
const POOL = 'hist-pool';
const GATEWAY_KEY_ID = 'gwk-hist';
const ADMIN_TOKEN = 'keygate_test_admin_token_at_least_16_chars';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('per-pool chat message history', () => {
  let server: http.Server;
  let port: number;
  let app: FastifyInstance;
  let appPort: number;
  let gatewayToken: string;

  beforeAll(async () => {
    getDb();

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const pathname = (req.url || '').split('?')[0] || '';
        if (pathname !== '/v1/chat/completions' || req.method !== 'POST') {
          return json(res, 404, { error: { message: `Unhandled mock route: ${req.method} ${pathname}` } });
        }

        const body = JSON.parse(raw.toString('utf8') || '{}') as { stream?: boolean; messages?: unknown[] };
        const last = (body.messages || []).find((m) => (m as { role: string }).role === 'user');
        const userText = (last as { content?: unknown } | undefined)?.content;
        const userContent = typeof userText === 'string' ? userText : '';

        if (body.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(`data: ${JSON.stringify({
            id: 'chunk-1',
            object: 'chat.completion.chunk',
            model: 'hist-model',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: 'chunk-2',
            object: 'chat.completion.chunk',
            model: 'hist-model',
            choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }],
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        return json(res, 200, {
          id: 'cmpl-hist',
          object: 'chat.completion',
          created: 1,
          model: 'hist-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `echo:${userContent}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 },
        });
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });

    const spec: ProviderSpec = {
      id: PROVIDER,
      name: 'History Provider',
      preset: 'openai-compatible',
      base_url: `http://127.0.0.1:${port}/v1`,
      endpoint_paths: { chat: DEFAULT_ENDPOINT_PATHS.chat },
      http_method: 'POST',
      auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
    };
    ProviderRepo.create({
      id: PROVIDER,
      name: 'History Provider',
      preset: 'openai-compatible',
      spec_yaml: yaml.stringify(spec),
    });

    const enc = encryptSecret('hist-secret');
    ApiKeyRepo.create({
      id: KEY_A,
      provider_id: PROVIDER,
      key_name: 'History Key',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'sk-',
      key_suffix: '-hist',
    });

    ModelAliasRepo.upsert({
      id: 'alias-hist-pool',
      alias_name: POOL,
      strategy: 'priority',
      targets_json: JSON.stringify([
        { provider_id: PROVIDER, model: 'hist-model', weight: 100, priority: 1 },
      ]),
      endpoint_kind: 'chat',
      timeout_ms: 2000,
      is_active: true,
    });

    const token = generateGatewayToken('gwk-hist');
    gatewayToken = token.rawToken;
    GatewayKeyRepo.create({
      id: GATEWAY_KEY_ID,
      name: 'History Client',
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
      body: JSON.stringify(body),
    });

  const getAdmin = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${appPort}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, ...(init?.headers || {}) },
    });

  it('records user + assistant rows for a non-stream chat completion', async () => {
    GatewayQuota.reset();

    const res = await post('/v1/chat/completions', {
      model: POOL,
      messages: [{ role: 'user', content: 'ping non-stream' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    expect(String((await res.json() as { choices: Array<{ message: { content: string } }> }).choices[0].message.content)).toBe('echo:ping non-stream');
    const traceId = res.headers.get('x-trace-id')!;

    const historyRes = await getAdmin(`/api/history?pool=${POOL}`);
    expect(historyRes.status).toBe(200);
    const { entries, pools } = (await historyRes.json()) as {
      entries: ChatHistoryRecord[];
      pools: Array<{ pool_name: string; count: number }>;
    };

    expect(pools.some((p) => p.pool_name === POOL)).toBe(true);

    const traced = entries.filter((e) => e.trace_id === traceId);
    expect(traced).toHaveLength(2);

    const user = traced.find((e) => e.role === 'user');
    const assistant = traced.find((e) => e.role === 'assistant');
    expect(user?.content).toBe('ping non-stream');
    expect(assistant?.content).toBe('echo:ping non-stream');
    expect(traced.every((e) => e.pool_name === POOL)).toBe(true);
    expect(traced.every((e) => e.provider_id === PROVIDER)).toBe(true);
    expect(traced.every((e) => e.model === 'hist-model')).toBe(true);
    expect(assistant?.prompt_tokens).toBe(4);
    expect(assistant?.completion_tokens).toBe(9);
    expect(assistant?.is_stream).toBe(0);
    expect(entries.every((e) => e.content === undefined || typeof e.content === 'string')).toBe(true);
  });

  it('records accumulated streamed content as the assistant message', async () => {
    GatewayQuota.reset();

    const res = await post('/v1/chat/completions', {
      model: POOL,
      messages: [{ role: 'user', content: 'stream me' }],
      stream: true,
    });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-trace-id')!;

    const historyRes = await getAdmin(`/api/history?pool=${POOL}`);
    const { entries } = (await historyRes.json()) as { entries: ChatHistoryRecord[] };

    const traced = entries.filter((e) => e.trace_id === traceId);
    expect(traced).toHaveLength(2);

    const user = traced.find((e) => e.role === 'user');
    const assistant = traced.find((e) => e.role === 'assistant');
    expect(user?.content).toBe('stream me');
    expect(assistant?.content).toBe('Hello world');
    expect(assistant?.is_stream).toBe(1);
  });

  it('deletes a single entry and clears a whole pool', async () => {
    const beforeRes = await getAdmin(`/api/history?pool=${POOL}`);
    const { entries } = (await beforeRes.json()) as { entries: ChatHistoryRecord[] };
    const trackedContent = entries.find((e) => e.content === 'ping non-stream');
    expect(trackedContent).toBeDefined();

    const delRes = await fetch(`http://127.0.0.1:${appPort}/api/history/${trackedContent!.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(delRes.status).toBe(200);
    expect((await delRes.json() as { success: boolean }).success).toBe(true);

    const afterDelete = await getAdmin(`/api/history?pool=${POOL}`);
    const entriesAfterDelete = (await afterDelete.json() as { entries: ChatHistoryRecord[] }).entries;
    expect(entriesAfterDelete.every((e) => e.id !== trackedContent!.id)).toBe(true);

    const clearRes = await fetch(`http://127.0.0.1:${appPort}/api/history?pool=${POOL}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const cleared = (await clearRes.json() as { removed: number }).removed;
    expect(cleared).toBeGreaterThan(0);

    const afterClear = await getAdmin(`/api/history?pool=${POOL}`);
    const entriesAfterClear = (await afterClear.json() as { entries: ChatHistoryRecord[] }).entries;
    expect(entriesAfterClear).toHaveLength(0);
  });
});