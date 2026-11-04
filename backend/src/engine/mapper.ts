import Handlebars from 'handlebars';
import jsonata from 'jsonata';
import type { 
  ProviderSpec, 
  OpenAIChatRequest, 
  OpenAIChatResponse, 
  OpenAIChatChunk,
  OpenAIChatChoice
} from '../types/index.js';

// DECISION: Register rich helper functions in Handlebars for json serialization, conditionals, and array joining.
Handlebars.registerHelper('json', (context) => JSON.stringify(context));
Handlebars.registerHelper('eq', (a, b) => a === b);
Handlebars.registerHelper('ne', (a, b) => a !== b);
Handlebars.registerHelper('default', (val, def) => (val !== undefined && val !== null && val !== '') ? val : def);

// DECISION: Provider specs are static config, so their templates only need compiling once. These
// caches are bounded: a spec edit produces a new key, and clearing the whole map keeps memory flat
// instead of growing without limit over a long-running process.
const MAX_TEMPLATE_CACHE = 100;

const handlebarsCache = new Map<string, ReturnType<typeof Handlebars.compile>>();
const jsonataCache = new Map<string, ReturnType<typeof jsonata>>();

function compileHandlebars(source: string): ReturnType<typeof Handlebars.compile> {
  const cached = handlebarsCache.get(source);
  if (cached) return cached;

  const template = Handlebars.compile(source);
  if (handlebarsCache.size >= MAX_TEMPLATE_CACHE) handlebarsCache.clear();
  handlebarsCache.set(source, template);
  return template;
}

function compileJsonata(source: string): ReturnType<typeof jsonata> {
  const cached = jsonataCache.get(source);
  if (cached) return cached;

  const expression = jsonata(source);
  if (jsonataCache.size >= MAX_TEMPLATE_CACHE) jsonataCache.clear();
  jsonataCache.set(source, expression);
  return expression;
}

export interface PreparedUpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  stream: boolean;
}

export class TemplateMapper {
  // DECISION: Map OpenAI request model through model_name_map if defined, otherwise pass model directly.
  public static resolveModel(spec: ProviderSpec, requestedModel: string): string {
    if (spec.model_name_map && spec.model_name_map[requestedModel]) {
      return spec.model_name_map[requestedModel];
    }
    return requestedModel;
  }

  // DECISION: Render auth credentials based on spec auth type: header, query, or injected into json body.
  public static applyAuth(
    spec: ProviderSpec,
    key: string,
    url: string,
    headers: Record<string, string>,
    bodyObj?: unknown
  ): { url: string; headers: Record<string, string>; bodyObj?: unknown } {
    const auth = spec.auth;
    // Keyless upstreams declare no auth — pass the request through untouched.
    if (!auth) return { url, headers, bodyObj };

    const renderedAuthValue = auth.template.replace(/\{\{\s*key\s*\}\}/g, key);

    const updatedHeaders = { ...headers };
    let updatedUrl = url;
    let updatedBody = bodyObj;

    if (auth.type === 'header') {
      const headerName = auth.name || 'Authorization';
      updatedHeaders[headerName] = renderedAuthValue;
    } else if (auth.type === 'query') {
      const paramName = auth.name || 'key';
      const delimiter = updatedUrl.includes('?') ? '&' : '?';
      updatedUrl = `${updatedUrl}${delimiter}${encodeURIComponent(paramName)}=${encodeURIComponent(renderedAuthValue)}`;
    } else if (auth.type === 'body') {
      const fieldName = auth.name || 'api_key';
      if (typeof updatedBody === 'object' && updatedBody !== null) {
        (updatedBody as Record<string, unknown>)[fieldName] = renderedAuthValue;
      }
    }

    return { url: updatedUrl, headers: updatedHeaders, bodyObj: updatedBody };
  }

  // DECISION: Gracefully degrade tools if upstream template does not support them by injecting schema into system prompt.
  public static degradeToolsIfNeeded(req: OpenAIChatRequest): OpenAIChatRequest {
    if (!req.tools || req.tools.length === 0) return req;

    const toolInstructions = `\n\n[Available Tools]:\nYou have access to the following tools in JSON schema format:\n` +
      JSON.stringify(req.tools, null, 2) +
      `\nIf you choose to call a tool, reply ONLY with a JSON object: {"tool_name": "function_name", "arguments": {...}}`;

    const messages = [...req.messages];
    const systemIdx = messages.findIndex((m) => m.role === 'system');

    if (systemIdx >= 0 && messages[systemIdx]) {
      messages[systemIdx] = {
        ...messages[systemIdx],
        content: `${messages[systemIdx].content || ''}${toolInstructions}`,
      };
    } else {
      messages.unshift({
        role: 'system',
        content: `You are a helpful assistant.${toolInstructions}`,
      });
    }

    return {
      ...req,
      messages,
    };
  }

  // Build the upstream HTTP request from an OpenAI chat request
  public static async mapRequest(
    spec: ProviderSpec,
    req: OpenAIChatRequest,
    decryptedKey: string,
    modelOverride?: string
  ): Promise<PreparedUpstreamRequest> {
    const targetModel = modelOverride || this.resolveModel(spec, req.model);
    const chatPath = spec.endpoint_paths.chat || '/chat/completions';
    let targetUrl = spec.base_url.replace(/\/+$/, '') + '/' + chatPath.replace(/^\/+/, '');
    const method = spec.http_method || 'POST';
    const isStream = Boolean(req.stream);

    let headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': isStream ? 'text/event-stream, application/json' : 'application/json',
    };

    // DECISION: static_headers are provider-level headers (e.g. anthropic-version) that ride on
    // every upstream request unchanged, before auth is applied so auth can still override.
    if (spec.static_headers) {
      headers = { ...headers, ...spec.static_headers };
    }

    // Fast-path: "openai-compatible" preset
    if (spec.preset === 'openai-compatible' || !spec.request_mapping) {
      const payload = {
        ...req,
        model: targetModel,
      };

      const authed = this.applyAuth(spec, decryptedKey, targetUrl, headers, payload);
      return {
        url: authed.url,
        method,
        headers: authed.headers,
        body: JSON.stringify(authed.bodyObj),
        stream: isStream,
      };
    }

    // Escape hatch check: custom adapter
    if (spec.custom_adapter) {
      // DECISION: Allow custom adapter execution for bespoke API handshakes
      const adapter = await import(spec.custom_adapter).catch(() => null);
      if (adapter && typeof adapter.transformRequest === 'function') {
        return adapter.transformRequest(spec, req, decryptedKey, targetModel);
      }
    }

    // Custom declarative template mapping
    const mapping = spec.request_mapping;
    const context = {
      request: req,
      model: targetModel,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      stream: isStream,
      key: decryptedKey,
    };

    let mappedBodyObj: unknown;

    if (mapping.engine === 'jsonata' && mapping.template) {
      const expression = compileJsonata(mapping.template);
      mappedBodyObj = await expression.evaluate(context);
    } else if (mapping.engine === 'handlebars' && mapping.template) {
      const templateFn = compileHandlebars(mapping.template);
      const renderedStr = templateFn(context);
      try {
        mappedBodyObj = JSON.parse(renderedStr);
      } catch {
        mappedBodyObj = renderedStr;
      }
    } else {
      mappedBodyObj = { ...req, model: targetModel };
    }

    const authed = this.applyAuth(spec, decryptedKey, targetUrl, headers, mappedBodyObj);

    return {
      url: authed.url,
      method,
      headers: authed.headers,
      body: typeof authed.bodyObj === 'string' ? authed.bodyObj : JSON.stringify(authed.bodyObj),
      stream: isStream,
    };
  }

  // Map non-streaming response body into standard OpenAI chat completion response
  public static async mapResponse(
    spec: ProviderSpec,
    rawBody: unknown,
    modelName: string
  ): Promise<OpenAIChatResponse> {
    // Fast-path: "openai-compatible" preset
    if (spec.preset === 'openai-compatible' || !spec.response_mapping) {
      if (typeof rawBody === 'object' && rawBody !== null && 'choices' in rawBody) {
        return rawBody as OpenAIChatResponse;
      }
    }

    // Escape hatch
    if (spec.custom_adapter) {
      const adapter = await import(spec.custom_adapter).catch(() => null);
      if (adapter && typeof adapter.transformResponse === 'function') {
        return adapter.transformResponse(spec, rawBody, modelName);
      }
    }

    const mapping = spec.response_mapping;
    if (!mapping || !mapping.template) {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
            },
            finish_reason: 'stop',
          },
        ],
      };
    }

    if (mapping.engine === 'jsonata') {
      const expression = compileJsonata(mapping.template);
      const result = await expression.evaluate(rawBody);

      // If jsonata directly returns an OpenAI completion object
      if (result && result.choices) {
        return result as OpenAIChatResponse;
      }

      // If jsonata returns mapped fields: { content, role, finish_reason, usage, tool_calls }
      return {
        id: result?.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: result?.created || Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            message: {
              role: result?.role || 'assistant',
              content: result?.content ?? '',
              tool_calls: result?.tool_calls,
            },
            finish_reason: result?.finish_reason || 'stop',
          },
        ],
        usage: result?.usage,
      };
    }

    if (mapping.engine === 'handlebars') {
      const templateFn = compileHandlebars(mapping.template);
      const renderedStr = templateFn(rawBody);
      try {
        const parsed = JSON.parse(renderedStr);
        if (parsed.choices) return parsed;
        return {
          id: parsed.id || `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            {
              index: 0,
              message: {
                role: parsed.role || 'assistant',
                content: parsed.content || '',
                tool_calls: parsed.tool_calls,
              },
              finish_reason: parsed.finish_reason || 'stop',
            },
          ],
          usage: parsed.usage,
        };
      } catch {
        return {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: renderedStr },
              finish_reason: 'stop',
            },
          ],
        };
      }
    }

    throw new Error(`Unsupported mapping engine: ${mapping.engine}`);
  }

  // DECISION: Map streaming chunk from SSE or NDJSON into standard OpenAI chunk format.
  public static async mapChunk(
    spec: ProviderSpec,
    rawChunkData: unknown,
    modelName: string
  ): Promise<OpenAIChatChunk | null> {
    const chunkRecord =
      typeof rawChunkData === 'object' && rawChunkData !== null
        ? (rawChunkData as Record<string, unknown>)
        : null;

    if (spec.preset === 'openai-compatible' || !spec.streaming?.chunk_mapping) {
      if (chunkRecord?.choices) {
        return rawChunkData as OpenAIChatChunk;
      }
    }

    const chunkMapping = spec.streaming?.chunk_mapping;
    if (!chunkMapping || !chunkMapping.template) {
      // Default extraction if text field is present
      const content = (chunkRecord?.text || chunkRecord?.delta || chunkRecord?.content || '') as string;
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            delta: { content },
            finish_reason: (chunkRecord?.finish_reason as OpenAIChatChoice['finish_reason']) || null,
          },
        ],
      };
    }

    if (chunkMapping.engine === 'jsonata') {
      const expression = compileJsonata(chunkMapping.template);
      const res = await expression.evaluate(rawChunkData);
      if (!res) return null;

      if (res.choices) return res as OpenAIChatChunk;

      return {
        id: res.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {
              role: res.role || res.delta?.role,
              content: res.content !== undefined ? res.content : (res.delta?.content !== undefined ? res.delta.content : undefined),
              tool_calls: res.tool_calls || res.delta?.tool_calls,
            },
            finish_reason: res.finish_reason !== undefined ? res.finish_reason : (res.delta?.finish_reason || null),
          },
        ],
      };
    }

    if (chunkMapping.engine === 'handlebars') {
      const templateFn = compileHandlebars(chunkMapping.template);
      const renderedStr = templateFn(rawChunkData);
      try {
        const parsed = JSON.parse(renderedStr);
        if (parsed.choices) return parsed;
        return {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {
                role: parsed.role || parsed.delta?.role,
                content: parsed.content !== undefined ? parsed.content : (parsed.delta?.content !== undefined ? parsed.delta.content : ''),
                tool_calls: parsed.tool_calls || parsed.delta?.tool_calls,
              },
              finish_reason: parsed.finish_reason !== undefined ? parsed.finish_reason : (parsed.delta?.finish_reason || null),
            },
          ],
        };
      } catch {
        return {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            {
              index: 0,
              delta: { content: renderedStr },
              finish_reason: null,
            },
          ],
        };
      }
    }

    return null;
  }
}
