import type { FastifyPluginAsync } from 'fastify';
import yaml from 'yaml';
import crypto from 'crypto';
import { ProviderRepo, ApiKeyRepo, ModelAliasRepo } from '../db/index.js';
import { parseCurlAndDraftSpec } from '../engine/curl-parser.js';
import { TemplateMapper } from '../engine/mapper.js';
import { PROVIDER_PRESETS, buildProviderSpec, getPreset, scanProviderBase } from '../engine/quick-add.js';
import { encryptSecret, maskKey } from '../crypto.js';
import type { ProviderSpec, OpenAIChatRequest, OpenAIChatResponse } from '../types/index.js';
import { errorMessage } from '../errors.js';

export const providersRoutes: FastifyPluginAsync = async (fastify) => {
  // List all providers
  fastify.get('/api/providers', async (request, reply) => {
    const list = ProviderRepo.getAll();
    return reply.send(list);
  });

  // Quick-add preset catalog (labels, defaults, key requirement) for the wizard UI.
  fastify.get('/api/providers/presets', async (request, reply) => {
    return reply.send(PROVIDER_PRESETS);
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
    } catch (err) {
      return reply.status(400).send({ error: `Invalid YAML: ${errorMessage(err)}` });
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
    } catch (err) {
      return reply.status(400).send({ error: errorMessage(err) });
    }
  });

  // DECISION: Quick-Add scanner probes a base URL's model/chat endpoints so the wizard can
  // auto-assign base_url + chat path and prefill the allowed model list.
  fastify.post('/api/providers/scan', async (request, reply) => {
    const body = request.body as { preset?: string; base_url?: string; api_key?: string };
    if (!body || !body.base_url?.trim()) {
      return reply.status(400).send({ error: 'Missing base_url parameter.' });
    }

    try {
      const result = await scanProviderBase({
        presetId: body.preset || 'openai',
        base_url: body.base_url,
        api_key: body.api_key,
      });
      return reply.send({ success: true, ...result });
    } catch (err) {
      return reply.status(500).send({ error: errorMessage(err) });
    }
  });

  // DECISION: Quick-Add creates provider spec + encrypted upstream key + pool alias in one call.
  // This is the primary "add a model" flow; the cURL/YAML wizard stays available as the advanced method.
  fastify.post('/api/providers/quick-add', async (request, reply) => {
    const body = request.body as {
      name: string;
      preset: string;
      base_url: string;
      model: string;
      api_key?: string;
      description?: string;
      pool_name?: string;
      chat_path?: string;
      preserveRoot?: boolean;
      timeout_ms?: number;
    };

    if (!body || !body.name?.trim() || !body.base_url?.trim() || !body.model?.trim()) {
      return reply.status(400).send({ error: 'Missing name, base_url, or model.' });
    }

    try {
      const built = buildProviderSpec({
        name: body.name.trim(),
        presetId: body.preset,
        base_url: body.base_url.trim(),
        model: body.model.trim(),
        description: body.description,
        chat_path: body.chat_path,
        preserveRoot: body.preserveRoot,
      });

      ProviderRepo.create({
        id: built.spec.id,
        name: built.spec.name,
        description: built.spec.description,
        preset: built.spec.preset || 'custom',
        spec_yaml: built.specYaml,
      });

      const cleanKey = (body.api_key || '').trim();
      const presetDef = getPreset(body.preset);

      // DECISION: Cloud presets require a real upstream key and fail fast here rather than
      // silently saving a provider that can never authenticate. Local servers (Ollama, LM
      // Studio, llama.cpp, vLLM…) usually need no auth, so an inert placeholder secret is
      // stored instead — pool routing still has a key to health-check and dispatch on, and
      // the upstream ignores the bogus Authorization header.
      if (presetDef?.needsKey && !cleanKey) {
        return reply.status(400).send({ error: `API key is required for the "${presetDef.label}" preset.` });
      }

      const secret = cleanKey || 'local-no-auth';
      const keyId = crypto.randomUUID();
      const encrypted = encryptSecret(secret);
      const mask = maskKey(secret);
      ApiKeyRepo.create({
        id: keyId,
        provider_id: built.spec.id,
        key_name: cleanKey ? `${built.spec.name} key` : `${built.spec.name} local (no auth) key`,
        encrypted_key: encrypted.encrypted,
        iv: encrypted.iv,
        tag: encrypted.tag,
        key_prefix: mask.prefix,
        key_suffix: mask.suffix,
      });
      const maskedKey = cleanKey ? mask.masked : null;

      const aliasName = (body.pool_name || body.model).trim();
      ModelAliasRepo.upsert({
        id: crypto.randomUUID(),
        alias_name: aliasName,
        strategy: 'weighted-by-health',
        targets_json: JSON.stringify([
          { provider_id: built.spec.id, model: body.model.trim(), weight: 100, priority: 1 },
        ]),
        description: `Quick-add pool for ${built.spec.name}`,
        endpoint_kind: 'chat',
        is_active: true,
        timeout_ms: body.timeout_ms || 30000,
      });

      return reply.send({
        success: true,
        provider_id: built.spec.id,
        key_id: keyId,
        masked_key: maskedKey,
        alias_name: aliasName,
        spec_yaml: built.specYaml,
      });
    } catch (err) {
      return reply.status(500).send({ error: errorMessage(err) });
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
    } catch (err) {
      return reply.status(400).send({ error: `Invalid YAML: ${errorMessage(err)}` });
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
      let rawJson: unknown = null;
      try {
        rawJson = JSON.parse(rawText);
      } catch {
        rawJson = rawText;
      }

      let mappedResponse: OpenAIChatResponse | null = null;
      let mappingError: string | null = null;

      if (res.ok) {
        try {
          mappedResponse = await TemplateMapper.mapResponse(spec, rawJson, testReq.model);
        } catch (mErr) {
          mappingError = errorMessage(mErr);
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
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: errorMessage(err),
      });
    }
  });
};
