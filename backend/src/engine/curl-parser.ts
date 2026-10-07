import yaml from 'yaml';
import type { ProviderSpec, ProviderAuth, MappingConfig } from '../types/index.js';

interface SampleResponseShape {
  choices?: Array<{ message?: unknown }>;
  content?: unknown;
  response?: unknown;
  text?: unknown;
  output?: unknown;
  result?: unknown;
}

export interface DraftProviderResult {
  spec: ProviderSpec;
  specYaml: string;
  detectedKey?: string;
  warnings: string[];
}

// DECISION: Parse cURL commands by tokenizing args and extracting HTTP method, URL, headers, and body for zero-friction provider onboarding.
export function parseCurlAndDraftSpec(curlCmd: string, sampleResponseJson?: string): DraftProviderResult {
  const warnings: string[] = [];
  const trimmed = curlCmd.trim().replace(/\\\r?\n/g, ' ');

  // Extract URL
  const urlMatch = trimmed.match(/(https?:\/\/[^\s'"]+)/);
  if (!urlMatch) {
    throw new Error('Could not find a valid HTTP/HTTPS URL in the curl command.');
  }
  const fullUrl = urlMatch[1]!;
  const parsedUrl = new URL(fullUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const endpointPath = parsedUrl.pathname || '/chat/completions';

  // Extract Method
  let method = 'POST';
  const methodMatch = trimmed.match(/(?:-X|--request)\s+([A-Z]+)/i);
  if (methodMatch && methodMatch[1]) {
    method = methodMatch[1].toUpperCase();
  }

  // Extract Headers
  const headers: Record<string, string> = {};
  const headerRegex = /(?:-H|--header)\s+["']([^"']+)["']/g;
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headerRegex.exec(trimmed)) !== null) {
    const rawHeader = hMatch[1];
    if (!rawHeader) continue;
    const colonIdx = rawHeader.indexOf(':');
    if (colonIdx > 0) {
      const hName = rawHeader.slice(0, colonIdx).trim();
      const hVal = rawHeader.slice(colonIdx + 1).trim();
      headers[hName.toLowerCase()] = hVal;
    }
  }

  // Extract Body
  let bodyStr: string | null = null;
  const bodyMatch = trimmed.match(/(?:-d|--data|--data-raw)\s+['"]([\s\S]*?)['"](?:\s+-[A-Za-z]|$)/);
  if (bodyMatch && bodyMatch[1]) {
    bodyStr = bodyMatch[1];
  } else {
    // Try single or double quotes without subsequent flag
    const fallbackMatch = trimmed.match(/(?:-d|--data|--data-raw)\s+('[\s\S]*'|"[\s\S]*")/);
    if (fallbackMatch && fallbackMatch[1]) {
      bodyStr = fallbackMatch[1].slice(1, -1);
    }
  }

  // Detect Auth
  let detectedKey: string | undefined;
  let authConfig: ProviderAuth = {
    type: 'header',
    name: 'Authorization',
    template: 'Bearer {{key}}',
  };

  const authHeader = Object.entries(headers).find(([k]) => k === 'authorization');
  const xApiKeyHeader = Object.entries(headers).find(([k]) => k === 'x-api-key');
  const apiKeyHeader = Object.entries(headers).find(([k]) => k === 'api-key');

  if (authHeader) {
    const val = authHeader[1];
    if (val.toLowerCase().startsWith('bearer ')) {
      detectedKey = val.slice(7).trim();
      authConfig = {
        type: 'header',
        name: 'Authorization',
        template: 'Bearer {{key}}',
      };
    } else {
      detectedKey = val.trim();
      authConfig = {
        type: 'header',
        name: 'Authorization',
        template: '{{key}}',
      };
    }
  } else if (xApiKeyHeader) {
    detectedKey = xApiKeyHeader[1].trim();
    authConfig = {
      type: 'header',
      name: 'x-api-key',
      template: '{{key}}',
    };
  } else if (apiKeyHeader) {
    detectedKey = apiKeyHeader[1].trim();
    authConfig = {
      type: 'header',
      name: 'api-key',
      template: '{{key}}',
    };
  } else if (parsedUrl.searchParams.has('key') || parsedUrl.searchParams.has('api_key')) {
    const param = parsedUrl.searchParams.has('key') ? 'key' : 'api_key';
    detectedKey = parsedUrl.searchParams.get(param) || undefined;
    authConfig = {
      type: 'query',
      name: param,
      template: '{{key}}',
    };
  }

  // Parse Body and determine mapping
  let parsedBody: unknown = null;
  if (bodyStr) {
    try {
      parsedBody = JSON.parse(bodyStr);
    } catch {
      warnings.push('Body was not valid JSON; raw string will be used.');
    }
  }

  const parsedObj =
    typeof parsedBody === 'object' && parsedBody !== null
      ? (parsedBody as { messages?: Array<{ role?: string }> })
      : null;

  let preset: 'openai-compatible' | 'custom' = 'custom';
  let requestMapping: MappingConfig | undefined = undefined;
  let responseMapping: MappingConfig | undefined = undefined;

  // Check if standard OpenAI request
  if (parsedObj && Array.isArray(parsedObj.messages) && parsedObj.messages[0]?.role) {
    preset = 'openai-compatible';
  } else if (parsedObj) {
    // Generate JSONata template draft for request
    preset = 'custom';
    requestMapping = {
      engine: 'jsonata',
      template: `{\n  "model": model,\n  "prompt": messages[-1].content,\n  "temperature": temperature,\n  "max_tokens": max_tokens\n}`,
    };
  }

  // Draft response mapping from sampleResponseJson if provided
  if (sampleResponseJson) {
    try {
      const resp = JSON.parse(sampleResponseJson) as SampleResponseShape;
      if (resp.choices && resp.choices[0]?.message) {
        preset = 'openai-compatible';
      } else {
        // Find text candidate in sample response
        if (resp.content && Array.isArray(resp.content) && resp.content[0]?.text) {
          // Anthropic style
          responseMapping = {
            engine: 'jsonata',
            template: `{\n  "id": id,\n  "content": content[0].text,\n  "role": role,\n  "finish_reason": stop_reason,\n  "usage": {\n    "prompt_tokens": usage.input_tokens,\n    "completion_tokens": usage.output_tokens,\n    "total_tokens": usage.input_tokens + usage.output_tokens\n  }\n}`,
          };
        } else if (resp.response || resp.text || resp.output || resp.result) {
          const field = resp.response ? 'response' : resp.text ? 'text' : resp.output ? 'output' : 'result';
          responseMapping = {
            engine: 'jsonata',
            template: `{\n  "content": ${field},\n  "role": "assistant",\n  "finish_reason": "stop"\n}`,
          };
        }
      }
    } catch {
      warnings.push('Sample response was not valid JSON; response mapping left as default.');
    }
  }

  const specId = parsedUrl.hostname.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const providerName = parsedUrl.hostname
    .replace(/^api\./, '')
    .replace(/\.[a-z]+$/, '')
    .replace(/^[a-z]/, (c) => c.toUpperCase());

  const spec: ProviderSpec = {
    id: specId,
    name: providerName,
    description: `Auto-drafted from curl for ${parsedUrl.hostname}`,
    preset,
    base_url: baseUrl,
    endpoint_paths: {
      chat: endpointPath,
    },
    http_method: method,
    auth: authConfig,
    ...(requestMapping ? { request_mapping: requestMapping } : {}),
    ...(responseMapping ? { response_mapping: responseMapping } : {}),
    streaming: {
      type: 'sse',
    },
    error_classification: [
      { status_codes: [429], error_type: 'rate_limit' },
      { status_codes: [401, 403], error_type: 'auth_fail' },
      { status_codes: [500, 502, 503, 504], error_type: 'retryable' },
    ],
    rate_limit_headers: {
      retry_after: 'Retry-After',
    },
  };

  const specYaml = yaml.stringify(spec);

  return {
    spec,
    specYaml,
    detectedKey,
    warnings,
  };
}
