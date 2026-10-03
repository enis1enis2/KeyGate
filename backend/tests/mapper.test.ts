import { describe, it, expect } from 'vitest';
import { TemplateMapper } from '../src/engine/mapper.js';
import type { ProviderSpec, OpenAIChatRequest } from '../src/types/index.js';

describe('TemplateMapper', () => {
  const openAISpec: ProviderSpec = {
    id: 'test-openai',
    name: 'OpenAI Test',
    preset: 'openai-compatible',
    base_url: 'https://api.openai.com/v1',
    endpoint_paths: { chat: '/chat/completions' },
    http_method: 'POST',
    auth: { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' },
    model_name_map: { 'my-alias': 'gpt-4o' },
  };

  it('maps model alias using model_name_map', () => {
    const resolved = TemplateMapper.resolveModel(openAISpec, 'my-alias');
    expect(resolved).toBe('gpt-4o');

    const unmapped = TemplateMapper.resolveModel(openAISpec, 'custom-model');
    expect(unmapped).toBe('custom-model');
  });

  it('applies auth correctly for header, query, and body', () => {
    // Header
    const resHeader = TemplateMapper.applyAuth(
      openAISpec,
      'secret-123',
      'https://api.example.com/v1/chat',
      {}
    );
    expect(resHeader.headers['Authorization']).toBe('Bearer secret-123');

    // Query
    const querySpec: ProviderSpec = {
      ...openAISpec,
      auth: { type: 'query', name: 'api_key', template: '{{key}}' },
    };
    const resQuery = TemplateMapper.applyAuth(
      querySpec,
      'secret-456',
      'https://api.example.com/v1/chat?foo=bar',
      {}
    );
    expect(resQuery.url).toBe('https://api.example.com/v1/chat?foo=bar&api_key=secret-456');

    // Body
    const bodySpec: ProviderSpec = {
      ...openAISpec,
      auth: { type: 'body', name: 'token', template: 'token-{{key}}' },
    };
    const resBody = TemplateMapper.applyAuth(
      bodySpec,
      'secret-789',
      'https://api.example.com/v1/chat',
      {},
      { prompt: 'hi' }
    );
    expect(resBody.bodyObj.token).toBe('token-secret-789');
  });

  it('degrades tools gracefully by appending schema to system prompt', () => {
    const req: OpenAIChatRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather for location',
            parameters: { type: 'object', properties: { location: { type: 'string' } } },
          },
        },
      ],
    };

    const degraded = TemplateMapper.degradeToolsIfNeeded(req);
    expect(degraded.messages.length).toBe(2);
    expect(degraded.messages[0]?.role).toBe('system');
    expect(degraded.messages[0]?.content).toContain('[Available Tools]:');
    expect(degraded.messages[0]?.content).toContain('get_weather');
  });

  it('maps custom request and response using JSONata', async () => {
    const customJsonataSpec: ProviderSpec = {
      id: 'custom-jsonata',
      name: 'Custom JSONata Provider',
      preset: 'custom',
      base_url: 'https://api.custom.ai',
      endpoint_paths: { chat: '/generate' },
      http_method: 'POST',
      auth: { type: 'header', name: 'x-custom-key', template: '{{key}}' },
      request_mapping: {
        engine: 'jsonata',
        template: `{
          "custom_model": model,
          "input_text": messages[-1].content,
          "temp": temperature
        }`,
      },
      response_mapping: {
        engine: 'jsonata',
        template: `{
          "id": "custom-" & $string(meta.id),
          "content": output.answer,
          "role": "assistant",
          "finish_reason": "stop",
          "usage": {
            "prompt_tokens": meta.tokens_in,
            "completion_tokens": meta.tokens_out,
            "total_tokens": meta.tokens_in + meta.tokens_out
          }
        }`,
      },
    };

    const req: OpenAIChatRequest = {
      model: 'my-model',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Translate to French' },
      ],
      temperature: 0.5,
    };

    const mappedReq = await TemplateMapper.mapRequest(customJsonataSpec, req, 'testkey123');
    expect(mappedReq.url).toBe('https://api.custom.ai/generate');
    expect(mappedReq.headers['x-custom-key']).toBe('testkey123');
    const parsedBody = JSON.parse(mappedReq.body!);
    expect(parsedBody.custom_model).toBe('my-model');
    expect(parsedBody.input_text).toBe('Translate to French');
    expect(parsedBody.temp).toBe(0.5);

    // Map response
    const rawUpstreamResponse = {
      meta: { id: 987, tokens_in: 15, tokens_out: 30 },
      output: { answer: 'Bonjour le monde' },
    };

    const mappedRes = await TemplateMapper.mapResponse(customJsonataSpec, rawUpstreamResponse, 'my-model');
    expect(mappedRes.id).toBe('custom-987');
    expect(mappedRes.choices[0]?.message.content).toBe('Bonjour le monde');
    expect(mappedRes.usage?.total_tokens).toBe(45);
  });

  it('maps custom streaming SSE chunk using JSONata', async () => {
    const streamingSpec: ProviderSpec = {
      id: 'stream-provider',
      name: 'Stream Provider',
      preset: 'custom',
      base_url: 'https://api.stream.ai',
      endpoint_paths: { chat: '/stream' },
      http_method: 'POST',
      auth: { type: 'header', name: 'x-key', template: '{{key}}' },
      streaming: {
        type: 'sse',
        chunk_mapping: {
          engine: 'jsonata',
          template: `{
            "delta": {
              "content": chunk_text
            },
            "finish_reason": is_final ? "stop" : undefined
          }`,
        },
      },
    };

    const rawChunk = { chunk_text: 'Hello ', is_final: false };
    const mapped = await TemplateMapper.mapChunk(streamingSpec, rawChunk, 'stream-model');
    expect(mapped).not.toBeNull();
    expect(mapped?.choices[0]?.delta.content).toBe('Hello ');
    expect(mapped?.choices[0]?.finish_reason).toBeNull();

    const finalChunk = { chunk_text: '', is_final: true };
    const mappedFinal = await TemplateMapper.mapChunk(streamingSpec, finalChunk, 'stream-model');
    expect(mappedFinal?.choices[0]?.finish_reason).toBe('stop');
  });
});
