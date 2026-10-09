import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';
import { buildServer } from '../src/server.js';
import { ApiKeyRepo, ModelAliasRepo, ProviderRepo, getDb } from '../src/db/index.js';
import { TemplateMapper } from '../src/engine/mapper.js';
import {
  PROVIDER_PRESETS,
  buildProviderSpec,
  scanProviderBase,
} from '../src/engine/quick-add.js';
import type { OpenAIChatRequest, ProviderSpec } from '../src/types/index.js';

const ADMIN_TOKEN = 'keygate_test_admin_token_at_least_16_chars';

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function startMock(
  routes: Array<{
    method: string;
    pathname: string;
    handler: (req: http.IncomingMessage & { body?: unknown }) => unknown | null;
  }>
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const pathname = (req.url || '').split('?')[0] || '';
      const match = routes.find((r) => r.method === req.method && r.pathname === pathname);
      const body =
        raw.length > 0 ? (JSON.parse(raw.toString('utf8') || '{}') as unknown) : null;
      if (match) {
        const out = match.handler({ ...req, body } as http.IncomingMessage & { body?: unknown });
        return json(res, 200, out);
      }
      return json(res, 404, { error: { message: `Unhandled mock route: ${req.method} ${pathname}` } });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

describe('quick-add spec builder', () => {
  it('builds an OpenAI-compatible spec with /v1 auto-appended', () => {
    const built = buildProviderSpec({
      name: 'My OpenAI',
      presetId: 'openai',
      base_url: 'https://api.openai.com',
      model: 'gpt-4o-mini',
    });

    expect(built.base_url).toBe('https://api.openai.com/v1');
    expect(built.spec.preset).toBe('openai-compatible');
    expect(built.spec.endpoint_paths.chat).toBe('/chat/completions');
    expect(built.spec.static_headers).toBeUndefined();
    expect(built.spec.id).toMatch(/^my-openai-[a-z0-9]{6}$/);

    // The persisted YAML round-trips to the same spec.
    const reparsed = yaml.parse(built.specYaml) as ProviderSpec;
    expect(reparsed.id).toBe(built.spec.id);
    expect(reparsed.base_url).toBe('https://api.openai.com/v1');
    expect(reparsed.endpoint_paths.chat).toBe('/chat/completions');
  });

  it('builds an Anthropic spec with static_headers and custom JSONata mappings', () => {
    const built = buildProviderSpec({
      name: 'Claude Ops',
      presetId: 'claude',
      base_url: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-20250514',
    });

    expect(built.spec.preset).toBe('custom');
    expect(built.spec.static_headers).toEqual({ 'anthropic-version': '2023-06-01' });
    expect(built.spec.endpoint_paths.chat).toBe('/messages');
    expect(built.spec.auth).toEqual({ type: 'header', name: 'x-api-key', template: '{{key}}' });
    expect(built.spec.request_mapping?.engine).toBe('jsonata');
    expect(built.spec.response_mapping?.engine).toBe('jsonata');
    expect(built.spec.streaming?.chunk_mapping?.engine).toBe('jsonata');
  });

  it('omits the auth block for keyless presets so no bogus header is sent', () => {
    const built = buildProviderSpec({
      name: 'Kilo Free',
      presetId: 'kilocode',
      base_url: 'https://api.kilo.ai/api/gateway',
      model: 'kilo-auto/free',
    });

    expect(built.spec.auth).toBeUndefined();
    expect(yaml.parse(built.specYaml)).not.toHaveProperty('auth');
    expect(built.spec.preset).toBe('openai-compatible');
  });

  it('keeps the Cohere OpenAI-compatible base without appending /v1', () => {
    const built = buildProviderSpec({
      name: 'Cohere Trial',
      presetId: 'cohere',
      base_url: 'https://api.cohere.com/compatibility/v1',
      model: 'command-r-plus',
    });

    expect(built.base_url).toBe('https://api.cohere.com/compatibility/v1');
    expect(built.spec.auth).toEqual({ type: 'header', name: 'Authorization', template: 'Bearer {{key}}' });
  });

  it('preserves the preset catalog the wizard depends on', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('claude');
    expect(ids).toContain('gemini');
    expect(ids).toContain('ollama');
    const local = PROVIDER_PRESETS.filter((p) => p.group === 'local');
    expect(local.some((p) => p.id === 'ollama')).toBe(true);
  });
});

describe('anthropic JSONata mapping roundtrip', () => {
  const built = buildProviderSpec({
    name: 'Claude Test',
    presetId: 'claude',
    base_url: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
  });

  it('maps an OpenAI request to the Anthropic Messages shape and back', async () => {
    const req: OpenAIChatRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'system', content: 'You are a calm spy.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there.' },
        { role: 'user', content: 'What is 2+2?' },
      ],
      temperature: 0.2,
      stream: false,
    };

    const prepared = await TemplateMapper.mapRequest(built.spec, req, 'sk-ant-xxxx');

    expect(prepared.url).toContain('/v1/messages');
    expect(prepared.headers['anthropic-version']).toBe('2023-06-01');
    expect(prepared.headers['x-api-key']).toBe('sk-ant-xxxx');

    const body = JSON.parse(prepared.body!) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe('You are a calm spy.');
    expect(body.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'What is 2+2?' },
    ]);

    const response = await TemplateMapper.mapResponse(
      built.spec,
      {
        id: 'msg_123',
        model: 'claude-3',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The answer is 42.' }],
        usage: { input_tokens: 9, output_tokens: 4 },
      },
      'claude-sonnet-4-20250514'
    );

    expect(response.choices[0].message.content).toBe('The answer is 42.');
    expect(response.choices[0].finish_reason).toBe('end_turn');
    expect(response.usage?.prompt_tokens).toBe(9);
    expect(response.usage?.completion_tokens).toBe(4);
    expect(response.usage?.total_tokens).toBe(13);
  });

  it('maps Anthropic streaming chunks into OpenAI chunks', async () => {
    const textChunk = await TemplateMapper.mapChunk(
      built.spec,
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      'm'
    );
    expect(textChunk?.choices[0].delta.content).toBe('Hello ');

    const doneChunk = await TemplateMapper.mapChunk(
      built.spec,
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
      'm'
    );
    expect(doneChunk?.choices[0].finish_reason).toBe('max_tokens');
  });
});

describe('provider scanner', () => {
  it('detects an OpenAI-compatible server at /v1/models', async () => {
    const { server, port } = await startMock([
      {
        method: 'GET',
        pathname: '/v1/models',
        handler: () => ({ object: 'list', data: [{ id: 'gpt-x' }, { id: 'gpt-y' }] }),
      },
    ]);
    try {
      const result = await scanProviderBase({ presetId: 'openai', base_url: `http://127.0.0.1:${port}` });
      expect(result.detected).toBe('openai');
      expect(result.base_url).toBe(`http://127.0.0.1:${port}/v1`);
      expect(result.chat_path).toBe('/chat/completions');
      expect(result.models).toEqual(['gpt-x', 'gpt-y']);
      expect(result.warnings).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('detects Ollama via /api/tags and assigns its OpenAI-compatible /v1 surface', async () => {
    const { server, port } = await startMock([
      {
        method: 'GET',
        pathname: '/api/tags',
        handler: () => ({ models: [{ name: 'llama3.2:latest' }, { name: 'llama3.2' }] }),
      },
    ]);
    try {
      const result = await scanProviderBase({ presetId: 'ollama', base_url: `http://127.0.0.1:${port}` });
      expect(result.detected).toBe('ollama');
      expect(result.base_url).toBe(`http://127.0.0.1:${port}/v1`);
      expect(result.models).toEqual(['llama3.2']);
      expect(result.chat_path).toBe('/chat/completions');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back to a conventional guess when nothing answers', async () => {
    const { server, port } = await startMock([]);
    try {
      const result = await scanProviderBase({ presetId: 'openai', base_url: `http://127.0.0.1:${port}` });
      expect(result.detected).toBe('guess');
      expect(result.models).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('quick-add API', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    getDb();
    app = await buildServer();
  });

  it('creates provider, encrypted key, and chat pool alias in a single call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/quick-add',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        name: 'QA Gadget',
        preset: 'openai',
        base_url: 'https://prov.example.com',
        model: 'qa-model-1',
        api_key: 'sk-abc123',
        pool_name: 'qa-pool',
      },
    });

    expect(res.statusCode).toBe(200);
    const out = res.json() as {
      success: boolean;
      provider_id: string;
      alias_name: string;
      masked_key: string;
      key_id: string | null;
      spec_yaml: string;
    };
    expect(out.success).toBe(true);
    expect(out.provider_id).toMatch(/^qa-gadget-[a-z0-9]{6}$/);
    expect(out.alias_name).toBe('qa-pool');
    expect(out.masked_key).toMatch(/^sk-/);

    const stored = ProviderRepo.getById(out.provider_id);
    expect(stored).not.toBeNull();
    const spec = yaml.parse(stored!.spec_yaml) as ProviderSpec;
    expect(spec.base_url).toBe('https://prov.example.com/v1');
    expect(spec.preset).toBe('openai-compatible');

    const keys = ApiKeyRepo.getByProvider(out.provider_id);
    expect(keys.length).toBe(1);
    expect(keys[0].key_prefix).toBe('sk-abc');

    const alias = ModelAliasRepo.getByName('qa-pool');
    expect(alias).not.toBeNull();
    const targets = JSON.parse(alias!.targets_json) as Array<{ provider_id: string; model: string; weight: number }>;
    expect(targets[0].provider_id).toBe(out.provider_id);
    expect(targets[0].model).toBe('qa-model-1');
    expect(targets[0].weight).toBe(100);
  });

  it('rejects a cloud preset when no API key is supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/quick-add',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        name: 'Cloud No Key',
        preset: 'openai',
        base_url: 'https://prov.example.com',
        model: 'gpt-4o-mini',
      },
    });
    expect(res.statusCode).toBe(400);
    const out = res.json() as { error: string };
    expect(out.error).toContain('API key is required');
  });

  it('stores an inert placeholder key for key-less local presets', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/quick-add',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        name: 'Local QA',
        preset: 'ollama',
        base_url: 'http://127.0.0.1:11434',
        model: 'llama3.2',
        pool_name: 'local-qa-pool',
      },
    });

    expect(res.statusCode).toBe(200);
    const out = res.json() as {
      success: boolean;
      provider_id: string;
      masked_key: string | null;
      key_id: string | null;
    };
    expect(out.success).toBe(true);
    expect(out.key_id).not.toBeNull();
    expect(out.masked_key).toBeNull();

    const keys = ApiKeyRepo.getByProvider(out.provider_id);
    expect(keys.length).toBe(1);
    expect(keys[0].key_prefix).toBe('local-');
    expect(keys[0].key_name).toContain('no auth');

    const alias = ModelAliasRepo.getByName('local-qa-pool');
    expect(alias).not.toBeNull();
  });

  it('exposes the preset catalog for the wizard dropdown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/providers/presets',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const presets = res.json() as Array<{ id: string; label: string; group: string }>;
    expect(presets.length).toBeGreaterThanOrEqual(15);
    expect(presets.find((p) => p.id === 'claude')?.label).toContain('Claude');
  });

  it('runs the scanner through the API', async () => {
    const { server, port } = await startMock([
      {
        method: 'GET',
        pathname: '/v1/models',
        handler: () => ({ data: [{ id: 'gem-x' }] }),
      },
    ]);
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/providers/scan',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { preset: 'openai', base_url: `http://127.0.0.1:${port}` },
      });
      expect(res.statusCode).toBe(200);
      const out = res.json() as { success: boolean; detected: string; models: string[] };
      expect(out.success).toBe(true);
      expect(out.detected).toBe('openai');
      expect(out.models).toEqual(['gem-x']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});