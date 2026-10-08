import yaml from 'yaml';
import type { ProviderAuth, ProviderSpec } from '../types/index.js';

// Shared presets for the Quick-Add wizard. Each preset carries the defaults the admin SPA
// prefills, plus the style that drives spec generation (openai-compatible fast path,
// Anthropic custom mapping, or a bare/root base URL).

export interface PresetDef {
  id: string;
  label: string;
  group: 'cloud' | 'local';
  defaultBase: string;
  defaultModel: string;
  needsKey: boolean;
  /** 'openai' = OpenAI-compatible (/v1/chat/completions), 'root' = OpenAI-compatible mounted at /, 'anthropic' = Messages API shape. */
  style: 'openai' | 'root' | 'anthropic';
  /** Suggested chat path for the spec. */
  chatPath: string;
  /** When style==='openai' and base_url lacks a trailing /v1, append it. */
  appendV1: boolean;
}

export const PROVIDER_PRESETS: PresetDef[] = [
  { id: 'openai', label: 'OpenAI', group: 'cloud', defaultBase: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'claude', label: 'Claude (Anthropic)', group: 'cloud', defaultBase: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514', needsKey: true, style: 'anthropic', chatPath: '/messages', appendV1: true },
  { id: 'gemini', label: 'Gemini (Google)', group: 'cloud', defaultBase: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: false },
  { id: 'groq', label: 'Groq', group: 'cloud', defaultBase: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'mistral', label: 'Mistral', group: 'cloud', defaultBase: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'deepseek', label: 'DeepSeek', group: 'cloud', defaultBase: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'openrouter', label: 'OpenRouter', group: 'cloud', defaultBase: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'xai', label: 'xAI (Grok)', group: 'cloud', defaultBase: 'https://api.x.ai/v1', defaultModel: 'grok-2-latest', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'perplexity', label: 'Perplexity', group: 'cloud', defaultBase: 'https://api.perplexity.ai', defaultModel: 'sonar', needsKey: true, style: 'root', chatPath: '/chat/completions', appendV1: false },
  { id: 'together', label: 'Together AI', group: 'cloud', defaultBase: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', needsKey: true, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'ollama', label: 'Ollama (local)', group: 'local', defaultBase: 'http://127.0.0.1:11434', defaultModel: 'llama3.2', needsKey: false, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'lmstudio', label: 'LM Studio (local)', group: 'local', defaultBase: 'http://127.0.0.1:1234/v1', defaultModel: 'local-model', needsKey: false, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'llamacpp', label: 'llama.cpp server (local)', group: 'local', defaultBase: 'http://127.0.0.1:8080/v1', defaultModel: 'llama', needsKey: false, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'localai', label: 'LocalAI (local)', group: 'local', defaultBase: 'http://127.0.0.1:8080/v1', defaultModel: 'gpt-4o-mini', needsKey: false, style: 'openai', chatPath: '/chat/completions', appendV1: true },
  { id: 'vllm', label: 'vLLM (local)', group: 'local', defaultBase: 'http://127.0.0.1:8000/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct', needsKey: false, style: 'openai', chatPath: '/chat/completions', appendV1: true },
];

export function getPreset(id: string): PresetDef | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

function normalizeBase(baseUrl: string, preset: PresetDef, preserveRoot: boolean): string {
  let base = baseUrl.trim().replace(/\/+$/, '');
  if (!base) base = preset.defaultBase.replace(/\/+$/, '');
  if (preset.appendV1 && !preserveRoot && !/\/v\d+(\.\d+)?(\/openai)?$/i.test(base)) {
    base = `${base}/v1`;
  }
  return base;
}

const ANTHROPIC_REQUEST_MAPPING = `
{
  "model": model,
  "max_tokens": max_tokens ? max_tokens : 1024,
  "system": $string($join(messages[role='system'].content, "\\n")),
  "messages": messages[role!='system'].{
    "role": role,
    "content": $string(content)
  },
  "temperature": temperature,
  "top_p": top_p,
  "stream": stream
}`.trim();

const ANTHROPIC_RESPONSE_MAPPING = `
{
  "id": "chatcmpl-" & $string($millis()),
  "object": "chat.completion",
  "created": $floor($millis() / 1000),
  "model": $string(model),
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": $string($join(content[type='text'].text, "\\n"))
      },
      "finish_reason": stop_reason ? stop_reason : "stop"
    }
  ],
  "usage": {
    "prompt_tokens": usage.input_tokens ? usage.input_tokens : 0,
    "completion_tokens": usage.output_tokens ? usage.output_tokens : 0,
    "total_tokens": (usage.input_tokens ? usage.input_tokens : 0) + (usage.output_tokens ? usage.output_tokens : 0)
  }
}`.trim();

const ANTHROPIC_CHUNK_MAPPING = `
$type(delta) = 'object' and delta.type = 'text_delta' ?
  {
    "id": "chatcmpl-" & $string($millis()),
    "object": "chat.completion.chunk",
    "created": $floor($millis() / 1000),
    "model": "",
    "choices": [{ "index": 0, "delta": { "content": delta.text }, "finish_reason": null }]
  }
:
  {
    "id": "chatcmpl-" & $string($millis()),
    "object": "chat.completion.chunk",
    "created": $floor($millis() / 1000),
    "model": "",
    "choices": [{ "index": 0, "delta": {}, "finish_reason": type = 'message_delta' ? (delta.stop_reason ? delta.stop_reason : "stop") : null }]
  }`.trim();

export interface QuickAddSpecInput {
  name: string;
  presetId: string;
  base_url: string;
  model: string;
  api_key?: string;
  description?: string;
  /** Auto-detected chat path override (from the scanner). */
  chat_path?: string;
  /** True when the scanner determined the server mounts everything at the base root. */
  preserveRoot?: boolean;
}

export interface BuiltQuickAddSpec {
  spec: ProviderSpec;
  specYaml: string;
  base_url: string;
}

export function buildProviderSpec(input: QuickAddSpecInput): BuiltQuickAddSpec {
  const preset = getPreset(input.presetId) || getPreset('openai')!;
  const base_url = normalizeBase(input.base_url, preset, input.preserveRoot === true);

  let spec: ProviderSpec;
  if (preset.style === 'anthropic') {
    const auth: ProviderAuth = { type: 'header', name: 'x-api-key', template: '{{key}}' };
    spec = {
      id: `${slugify(input.name)}-${cryptoRandomSegment()}`,
      name: input.name,
      description: input.description,
      preset: 'custom',
      base_url,
      endpoint_paths: {
        chat: input.chat_path || '/messages',
        models: '/models',
      },
      http_method: 'POST',
      auth,
      static_headers: { 'anthropic-version': '2023-06-01' },
      request_mapping: { engine: 'jsonata', template: ANTHROPIC_REQUEST_MAPPING },
      response_mapping: { engine: 'jsonata', template: ANTHROPIC_RESPONSE_MAPPING },
      streaming: {
        type: 'sse',
        chunk_mapping: { engine: 'jsonata', template: ANTHROPIC_CHUNK_MAPPING },
      },
      error_classification: [
        { status_codes: [429], error_type: 'rate_limit' },
        { status_codes: [401, 403], error_type: 'auth_fail' },
        { status_codes: [529], error_type: 'retryable' },
      ],
      model_name_map: { [input.model]: input.model },
    };
  } else {
    const auth: ProviderAuth = { type: 'header', name: 'Authorization', template: 'Bearer {{key}}' };
    spec = {
      id: `${slugify(input.name)}-${cryptoRandomSegment()}`,
      name: input.name,
      description: input.description,
      preset: 'openai-compatible',
      base_url,
      endpoint_paths: {
        chat: input.chat_path || preset.chatPath,
        models: '/models',
      },
      http_method: 'POST',
      auth,
      streaming: { type: 'sse' },
      error_classification: [
        { status_codes: [429], error_type: 'rate_limit' },
        { status_codes: [401, 403], error_type: 'auth_fail' },
        { status_codes: [500, 502, 503, 504], error_type: 'retryable' },
      ],
      model_name_map: { [input.model]: input.model },
    };
  }

  return {
    spec,
    specYaml: yaml.stringify(spec),
    base_url,
  };
}

// ---------------- Scanner ----------------
const SCAN_TIMEOUT_MS = 8000;

export interface ScanResult {
  base_url: string;
  chat_path: string;
  models_path: string;
  models: string[];
  detected: 'openai' | 'ollama' | 'guess';
  warnings: string[];
}

export function defaultChatPathFor(presetId: string): string {
  return getPreset(presetId)?.chatPath || '/chat/completions';
}

function parseModels(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    const ids = record.data
      .map((m) => (typeof m === 'string' ? m : (m as Record<string, unknown>).id))
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
    if (ids.length > 0) {
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    }
  }
  if (Array.isArray(record.models)) {
    const names = record.models
      .map((m) => (typeof m === 'string' ? m : (m as Record<string, unknown>).name))
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      .map((m) => m.replace(/:latest$/, ''));
    if (names.length > 0) {
      return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    }
  }
  if (Array.isArray(record)) {
    const strs = record.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
    if (strs.length > 0) return [...new Set(strs)].sort((a, b) => a.localeCompare(b));
  }
  return null;
}

async function fetchWithTimeout(url: string, apiKey: string | undefined, method: 'GET' | 'POST' = 'GET'): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function tryGetModels(url: string, apiKey: string | undefined): Promise<{ ok: boolean; models: string[] | null; kind: 'openai' | 'ollama' | 'none' }> {
  try {
    const res = await fetchWithTimeout(url, apiKey);
    if (!res.ok) return { ok: false, models: null, kind: 'none' };
    const text = await res.text();
    if (!text.trim()) return { ok: false, models: null, kind: 'none' };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, models: null, kind: 'none' };
    }
    const models = parseModels(body);
    if (!models) return { ok: true, models: null, kind: 'none' };
    const ollamaNative = url.endsWith('/api/tags');
    return { ok: true, models, kind: ollamaNative ? 'ollama' : 'openai' };
  } catch {
    return { ok: false, models: null, kind: 'none' };
  }
}

// DECISION: The scanner probes the common OpenAI-style endpoints (with/without /v1, plus the
// Ollama-native /api/tags) and picks the first base+path pairing that returns a model list.
// The chat path is assigned by convention from whichever models endpoint matched, so a custom
// upstream that mounts at the root gets a spec that hits /chat/completions at the root too.
export async function scanProviderBase(
  input: { presetId: string; base_url: string; api_key?: string }
): Promise<ScanResult> {
  const preset = getPreset(input.presetId) || getPreset('openai')!;
  const rawBase = (input.base_url || preset.defaultBase).trim().replace(/\/+$/, '');
  const warnings: string[] = [];

  const hasV1 = /\/v\d+(\.\d+)?(\/openai)?$/i.test(rawBase);
  const candidates: Array<{ base: string; path: string; kind: 'openai' | 'ollama' }> = [];
  if (hasV1) {
    candidates.push({ base: rawBase, path: '/models', kind: 'openai' });
  } else {
    candidates.push({ base: `${rawBase}/v1`, path: '/models', kind: 'openai' });
    candidates.push({ base: rawBase, path: '/models', kind: 'openai' });
    candidates.push({ base: rawBase, path: '/api/tags', kind: 'ollama' });
  }

  for (const candidate of candidates) {
    const result = await tryGetModels(`${candidate.base}${candidate.path}`, input.api_key);
    if (result.kind === 'none') continue;
    if (result.ok && result.models && result.models.length > 0) {
      if (result.kind === 'ollama') {
        return {
          base_url: `${candidate.base}/v1`,
          chat_path: preset.style === 'anthropic' ? '/messages' : '/chat/completions',
          models_path: '/models',
          models: result.models,
          detected: 'ollama',
          warnings: ['Detected Ollama via /api/tags — using its OpenAI-compatible /v1 endpoints.'],
        };
      }
      const detectedRoot = candidate.base === rawBase;
      return {
        base_url: candidate.base,
        chat_path: preset.style === 'anthropic' ? '/messages' : '/chat/completions',
        models_path: candidate.path,
        models: result.models,
        detected: 'openai',
        warnings: detectedRoot
          ? ['Endpoint detected at the base URL root (no /v1) — chat path assigned to /chat/completions at the root.']
          : [],
      };
    }
  }

  // No model list found: fall back to a conventional guess so the wizard can still proceed.
  const fallbackBase = hasV1 ? rawBase : preset.appendV1 || preset.style !== 'root' ? `${rawBase}/v1` : rawBase;
  warnings.push('Could not auto-detect endpoints — using the standard OpenAI-compatible mapping as a guess. Fill in the fields and use Live Test before saving.');
  return {
    base_url: fallbackBase,
    chat_path: preset.style === 'anthropic' ? '/messages' : preset.chatPath,
    models_path: '/models',
    models: [],
    detected: 'guess',
    warnings,
  };
}

// ---------------- Helpers ----------------
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'provider';
}

export function cryptoRandomSegment(): string {
  return Math.random().toString(36).slice(2, 8);
}