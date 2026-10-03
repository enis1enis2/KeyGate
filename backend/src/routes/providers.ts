import type { FastifyPluginAsync } from 'fastify';
import yaml from 'yaml';
import { ProviderRepo } from '../db/index.js';
import { parseCurlAndDraftSpec } from '../engine/curl-parser.js';
import { TemplateMapper } from '../engine/mapper.js';
import type { ProviderSpec, OpenAIChatRequest } from '../types/index.js';

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  // List all providers
  fastify.get('/api/providers', async (request, reply) => {
    const list = ProviderRepo.getAll();
    return reply.send(list);
  });

  // Get single provider
  fastify.get('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const p = ProviderRepo.getById(id);
    if (!p) return reply.status(404).send({ error: 'Provider not found' });
    return reply.send(p);
  });

  // Create or update provider
  fastify.post('/api/providers', async (request, reply) => {
    const body = request.body as {
      id?: string;
      name?: string;
      description?: string;
      preset?: string;
      spec_yaml: string;
    };

    if (!body || !body.spec_yaml) {
      return reply.status(400).send({ error: 'Missing spec_yaml in request body' });
    }

    let parsedSpec: ProviderSpec;
    try {
      parsedSpec = yaml.parse(body.spec_yaml) as ProviderSpec;
      if (!parsedSpec.id || !parsedSpec.name || !parsedSpec.base_url) {
        return reply.status(400).send({ error: 'Provider spec must contain id, name, and base_url.' });
      }
    } catch (err: any) {
      return reply.status(400).send({ error: `Invalid YAML: ${err.message}` });
    }

    ProviderRepo.create({
      id: parsedSpec.id,
      name: parsedSpec.name,
      description: parsedSpec.description,
      preset: parsedSpec.preset || 'custom',
      spec_yaml: body.spec_yaml,
    });

    return reply.send({ success: true, id: parsedSpec.id });
  });

  // Delete provider
  fastify.delete('/api/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = ProviderRepo.delete(id);
    return reply.send({ success: deleted });
  });

  // DECISION: Curl wizard endpoint auto-drafts complete YAML spec from curl command + optional response JSON.
  fastify.post('/api/providers/wizard/draft', async (request, reply) => {
    const body = request.body as { curl_command: string; sample_response?: string };
    if (!body || !body.curl_command) {
      return reply.status(400).send({ error: 'Missing curl_command parameter.' });
    }

    try {
      const draft = parseCurlAndDraftSpec(body.curl_command, body.sample_response);
      return reply.send(draft);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // DECISION: Live Test button allows inspecting mapped request and actual upstream response in real-time.
  fastify.post('/api/providers/test', async (request, reply) => {
    const body = request.body as {
      spec_yaml: string;
      test_key: string;
      prompt?: string;
      model?: string;
    };

    if (!body || !body.spec_yaml || !body.test_key) {
      return reply.status(400).send({ error: 'Missing spec_yaml or test_key.' });
    }

    let spec: ProviderSpec;
    try {
      spec = yaml.parse(body.spec_yaml) as ProviderSpec;
    } catch (err: any) {
      return reply.status(400).send({ error: `Invalid YAML: ${err.message}` });
    }

    const testReq: OpenAIChatRequest = {
      model: body.model || 'test-model',
      messages: [{ role: 'user', content: body.prompt || 'Hello! Please respond with a short greeting.' }],
      max_tokens: 50,
      temperature: 0.7,
      stream: false,
    };

    try {
      const prepared = await TemplateMapper.mapRequest(spec, testReq, body.test_key, body.model);

      const startTime = Date.now();
      const res = await fetch(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
      });
      const latencyMs = Date.now() - startTime;

      const rawText = await res.text();
      let rawJson: any = null;
      try {
        rawJson = JSON.parse(rawText);
      } catch {
        rawJson = rawText;
      }

      let mappedResponse: any = null;
      let mappingError: string | null = null;

      if (res.ok) {
        try {
          mappedResponse = await TemplateMapper.mapResponse(spec, rawJson, testReq.model);
        } catch (mErr: any) {
          mappingError = mErr.message;
        }
      }

      return reply.send({
        success: res.ok,
        statusCode: res.status,
        latencyMs,
        preparedRequest: {
          url: prepared.url,
          method: prepared.method,
          headers: prepared.headers,
          body: prepared.body ? JSON.parse(prepared.body) : undefined,
        },
        rawResponse: rawJson,
        mappedResponse,
        mappingError,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        error: err.message,
      });
    }
  });
};
