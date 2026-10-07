import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { FastifyInstance } from 'fastify';
import yaml from 'yaml';
import { buildServer } from '../src/server.js';
import { ProviderRepo, ApiKeyRepo, ModelAliasRepo, GatewayKeyRepo, getDb } from '../src/db/index.js';
import { encryptSecret, generateGatewayToken } from '../src/crypto.js';
import type { ProviderSpec, OpenAIChatRequest, OpenAIChatResponse } from '../src/types/index.js';

describe('Integration Test: Mock Non-Standard Upstream & Failover', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let fastifyApp: FastifyInstance;
  let fastifyPort: number;
  let gatewayToken: string;

  beforeAll(async () => {
    getDb();

    // 1. Create Mock Non-Standard Upstream Server
    mockServer = http.createServer((req, res) => {
      const url = req.url || '';
      const authHeader = req.headers['x-api-token'];

      // Failover simulation: if token is flaky-key, return 429 rate limit
      if (authHeader === 'flaky-key') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '5',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded on this key' }));
        return;
      }

      if (url === '/custom/api/v2/generate') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            result: {
              output_text: 'Greetings from non-standard upstream API!',
              usage_stats: { input: 12, output: 25 },
            },
          }));
        });
        return;
      }

      if (url === '/custom/api/v2/stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        res.write('data: {"piece": "Hello "}\n\n');
        setTimeout(() => {
          res.write('data: {"piece": "from "}\n\n');
          setTimeout(() => {
            res.write('data: {"piece": "stream!", "done": true}\n\n');
            res.end();
          }, 30);
        }, 30);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as AddressInfo).port;
        resolve();
      });
    });

    // 2. Define non-standard provider spec pointing to mock upstream
    const mockProviderSpec: ProviderSpec = {
      id: 'mock-non-standard',
      name: 'Mock Non-Standard Provider',
      preset: 'custom',
      base_url: `http://127.0.0.1:${mockPort}`,
      endpoint_paths: {
        chat: '/custom/api/v2/generate',
      },
      http_method: 'POST',
      auth: {
        type: 'header',
        name: 'x-api-token',
        template: '{{key}}',
      },
      request_mapping: {
        engine: 'jsonata',
        template: `{
          "query": messages[-1].content,
          "parameters": {
            "max_tokens": max_tokens ? max_tokens : 100
          }
        }`,
      },
      response_mapping: {
        engine: 'jsonata',
        template: `{
          "id": "mock-resp-1",
          "content": result.output_text,
          "role": "assistant",
          "finish_reason": "stop",
          "usage": {
            "prompt_tokens": result.usage_stats.input,
            "completion_tokens": result.usage_stats.output,
            "total_tokens": result.usage_stats.input + result.usage_stats.output
          }
        }`,
      },
      streaming: {
        type: 'sse',
        chunk_mapping: {
          engine: 'jsonata',
          template: `{
            "delta": {
              "content": piece
            },
            "finish_reason": done ? "stop" : undefined
          }`,
        },
      },
      error_classification: [
        { status_codes: [429], error_type: 'rate_limit' },
      ],
      rate_limit_headers: {
        retry_after: 'Retry-After',
      },
    };

    ProviderRepo.create({
      id: mockProviderSpec.id,
      name: mockProviderSpec.name,
      preset: 'custom',
      spec_yaml: yaml.stringify(mockProviderSpec),
    });

    // 3. Add two keys: key 1 is flaky, key 2 is healthy
    const enc1 = encryptSecret('flaky-key');
    const enc2 = encryptSecret('healthy-key');

    ApiKeyRepo.delete('mock-key-flaky');
    ApiKeyRepo.delete('mock-key-healthy');

    ApiKeyRepo.create({
      id: 'mock-key-flaky',
      provider_id: 'mock-non-standard',
      key_name: 'Flaky Primary Key',
      encrypted_key: enc1.encrypted,
      iv: enc1.iv,
      tag: enc1.tag,
      key_prefix: 'flaky-',
      key_suffix: '-key',
    });

    ApiKeyRepo.create({
      id: 'mock-key-healthy',
      provider_id: 'mock-non-standard',
      key_name: 'Healthy Backup Key',
      encrypted_key: enc2.encrypted,
      iv: enc2.iv,
      tag: enc2.tag,
      key_prefix: 'healt',
      key_suffix: '-key',
    });

    // 4. Configure alias
    ModelAliasRepo.upsert({
      id: 'alias-mock-integration',
      alias_name: 'mock-alias',
      strategy: 'priority',
      targets_json: JSON.stringify([
        { provider_id: 'mock-non-standard', model: 'mock-v1', weight: 1, priority: 1 },
      ]),
      hedging_enabled: false,
      hedged_delay_ms: 500,
      timeout_ms: 10000,
      is_active: true,
    });

    // 5. Generate gateway client token
    const tokenInfo = generateGatewayToken('kg-test');
    gatewayToken = tokenInfo.rawToken;
    GatewayKeyRepo.create({
      id: 'gwk-test-integration',
      name: 'Integration Test Client',
      token_hash: tokenInfo.tokenHash,
      token_prefix: tokenInfo.tokenPrefix,
      token_suffix: tokenInfo.tokenSuffix,
    });

    // 6. Start KeyGate Fastify App
    fastifyApp = await buildServer();
    await fastifyApp.listen({ port: 0, host: '127.0.0.1' });
    const address = fastifyApp.server.address();
    fastifyPort = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    if (fastifyApp) await fastifyApp.close();
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  it('routes OpenAI chat completion through mock upstream and fails over from flaky key to healthy key', async () => {
    const chatReq: OpenAIChatRequest = {
      model: 'mock-alias',
      messages: [{ role: 'user', content: 'Say greetings!' }],
      temperature: 0.7,
    };

    const res = await fetch(`http://127.0.0.1:${fastifyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify(chatReq),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as OpenAIChatResponse;

    // Verify response was mapped properly into OpenAI format
    expect(json.object).toBe('chat.completion');
    expect(json.choices).toBeDefined();
    expect(json.choices[0]?.message.role).toBe('assistant');
    expect(json.choices[0]?.message.content).toBe('Greetings from non-standard upstream API!');
    expect(json.usage?.total_tokens).toBe(37);

    // Verify flaky key was cooled down due to 429
    const flakyKeyRecord = ApiKeyRepo.getById('mock-key-flaky');
    expect(flakyKeyRecord?.circuit_state).toBe('OPEN');
    expect(flakyKeyRecord?.consecutive_failures).toBe(1);

    // Verify healthy key succeeded
    const healthyKeyRecord = ApiKeyRepo.getById('mock-key-healthy');
    expect(healthyKeyRecord?.circuit_state).toBe('CLOSED');
  });

  it('streams chat completion from mock SSE endpoint and translates into standard OpenAI chunks', async () => {
    // Reconfigure endpoint to stream for this test
    const streamingSpec = ProviderRepo.getById('mock-non-standard')!;
    const parsed = yaml.parse(streamingSpec.spec_yaml);
    parsed.endpoint_paths.chat = '/custom/api/v2/stream';
    ProviderRepo.create({
      id: 'mock-non-standard',
      name: 'Mock Non-Standard Provider',
      preset: 'custom',
      spec_yaml: yaml.stringify(parsed),
    });

    const chatReq: OpenAIChatRequest = {
      model: 'mock-alias',
      messages: [{ role: 'user', content: 'Stream test' }],
      stream: true,
    };

    const res = await fetch(`http://127.0.0.1:${fastifyPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify(chatReq),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('Hello ');
    expect(text).toContain('stream!');
  });
});
