import type {
  ApiKeyItem,
  GatewayKey,
  ModelAlias,
  ModelPricing,
  Provider,
  TargetConfig,
} from '../types';
import { createSeedState, PROVIDER_PRESETS, type DemoState } from './seed';

/**
 * Installs a browser-only mock of the KeyGate HTTP API. The Pages build never
 * talks to a backend: every request below is answered from memory, and a reload
 * rebuilds the seed state, which is how the demo resets.
 */

const DEMO_GATEWAY_KEY = 'kg-demo-playground-key';

type Json = Record<string, unknown>;

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extra },
  });
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBody(init?: RequestInit): Json {
  if (!init?.body || typeof init.body !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(init.body);
    return parsed && typeof parsed === 'object' ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Manual scanner rather than a chained regex, matching the backend's approach
// to user-provided identifiers and keeping the frontend free of backtracking.
function slugify(value: string): string {
  let out = '';
  let pendingDash = false;
  for (const raw of value.toLowerCase()) {
    const code = raw.charCodeAt(0);
    const alnum = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (alnum) {
      if (pendingDash && out.length > 0) out += '-';
      out += raw;
      pendingDash = false;
    } else {
      pendingDash = out.length > 0;
    }
    if (out.length >= 40) break;
  }
  while (out.endsWith('-')) out = out.slice(0, -1);
  return out || 'demo';
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out.slice(0, length);
}

function maskSecret(raw: string): { masked: string; prefix: string; suffix: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { masked: '(no key)', prefix: '', suffix: '' };
  const prefix = trimmed.slice(0, Math.min(7, trimmed.length));
  const suffix = trimmed.slice(-4);
  return { masked: `${prefix}••••${suffix}`, prefix, suffix };
}

function baseKey(providerId: string, keyName: string, raw: string, caps: Json): ApiKeyItem {
  const { masked, prefix, suffix } = maskSecret(raw);
  return {
    id: '',
    provider_id: providerId,
    key_name: keyName,
    masked_key: masked,
    key_prefix: prefix,
    key_suffix: suffix,
    is_active: true,
    circuit_state: 'CLOSED',
    cooldown_until: 0,
    consecutive_failures: 0,
    disabled_reason: null,
    last_error: null,
    rolling_success_rate: 100,
    latency_p50: 0,
    latency_p95: 0,
    total_calls_window: 0,
    rpm_cap: num(caps.rpm_cap, 0),
    current_rpm: 0,
    tpm_cap: num(caps.tpm_cap, 0),
    current_tpm: 0,
    daily_budget_cap: num(caps.daily_budget_cap, 0),
    daily_usage: 0,
  };
}

function statsFor(state: DemoState) {
  const closed = state.keys.filter((key) => key.circuit_state === 'CLOSED').length;
  const halfOpen = state.keys.filter((key) => key.circuit_state === 'HALF_OPEN').length;
  const open = state.keys.filter((key) => key.circuit_state === 'OPEN').length;
  const totalRequests = 128_460 + state.statsCalls * 13;
  return {
    totalRequests,
    successRequests: totalRequests - 1_028,
    errorRequests: 1_028,
    successRate: 99.2,
    avgLatencyMs: 812,
    p50LatencyMs: 640,
    p95LatencyMs: 1_840,
    totalPromptTokens: 48_210_000,
    totalCompletionTokens: 12_860_000,
    totalKeys: state.keys.length,
    activeKeys: state.keys.filter((key) => key.is_active).length,
    totalProviders: state.providers.length,
    spendToday: 38.42 + state.statsCalls * 0.004,
    poolUsageToday: [
      { pool: 'smart-chat', tokens: 1_842_000, spend: 11.24, requests: 8_210 },
      { pool: 'fast-draft', tokens: 920_400, spend: 3.18, requests: 6_120 },
      { pool: 'deep-reasoning', tokens: 612_800, spend: 18.44, requests: 2_140 },
      { pool: 'embed-small', tokens: 2_310_000, spend: 0.06, requests: 1_120 },
    ],
    budgetedKeys: state.keys
      .filter((key) => key.daily_budget_cap > 0)
      .map((key) => ({
        id: key.id,
        name: key.key_name,
        provider: state.providers.find((provider) => provider.id === key.provider_id)?.name ?? key.provider_id,
        daily_budget_cap: key.daily_budget_cap,
        spend_today: key.daily_usage,
      })),
    circuits: { closed, halfOpen, open },
  };
}

function parseSpec(spec: string): { id: string; name: string; baseUrl: string } {
  let id = '';
  let name = '';
  let baseUrl = '';
  for (const line of spec.split('\n')) {
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon < 1) continue;
    const field = trimmed.slice(0, colon);
    let value = trimmed.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (field === 'id') id = value;
    if (field === 'name') name = value;
    if (field === 'base_url') baseUrl = value;
  }
  return { id, name, baseUrl };
}

function specFor(name: string, baseUrl: string, chatPath: string): string {
  return `id: ${slugify(name)}
name: ${name}
base_url: ${baseUrl}
auth:
  type: bearer
  key: "{{api_key}}"
endpoints:
  chat: ${chatPath}
  models: /models
timeout_ms: 30000`;
}

function providerName(state: DemoState, id: string): string {
  return state.providers.find((provider) => provider.id === id)?.name ?? id;
}

function completionResponse(state: DemoState, body: Json, signal?: AbortSignal | null): Response {
  const requested = str(body.model);
  const alias = state.aliases.find((entry) => entry.alias_name === requested) ?? state.aliases[0];
  const target = alias?.targets[0];
  const upstream = target ? providerName(state, target.provider_id) : 'the demo upstream';
  const model = target?.model ?? 'demo-model';
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let prompt = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Json;
    if (record.role === 'user' && typeof record.content === 'string') prompt = record.content;
  }
  const clipped = prompt.length > 160 ? `${prompt.slice(0, 157)}…` : prompt;
  const content = `This is the KeyGate demo — no request left your browser.

Pool ${alias?.alias_name ?? 'demo'} (${alias?.strategy ?? 'weighted-by-health'}) would route this to ${upstream} · ${model}.

You said: "${clipped || 'hello'}"`;

  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4) + 12);
  const completionTokens = Math.max(1, Math.ceil(content.length / 4));
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
  const traceId = `tr_demo${randomHex(8)}`;
  const headers = {
    'x-keygate-provider': upstream,
    'x-keygate-model': model,
    'x-trace-id': traceId,
  };

  if (body.stream !== true) {
    return json(
      {
        id: `chatcmpl-demo-${randomHex(8)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage,
      },
      200,
      headers
    );
  }

  const encoder = new TextEncoder();
  const words = content.match(/\S+\s*/g) ?? [content];
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        for (const word of words) {
          if (signal?.aborted) throw abortError();
          send({ choices: [{ delta: { content: word }, finish_reason: null }] });
          await sleep(18, signal);
        }
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        send({ choices: [], usage });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch {
        try {
          controller.error(abortError());
        } catch {
          // The consumer already closed the stream.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      ...headers,
    },
  });
}

async function route(state: DemoState, url: URL, method: string, init?: RequestInit): Promise<Response | null> {
  const path = url.pathname;
  const body = readBody(init);

  if (path === '/api/dashboard/stats' && method === 'GET') {
    state.statsCalls += 1;
    return json(statsFor(state));
  }

  if (path === '/api/providers/presets' && method === 'GET') {
    return json(PROVIDER_PRESETS);
  }

  if (path === '/api/providers/wizard/draft' && method === 'POST') {
    const curl = str(body.curl_command, 'https://api.example.com/v1/chat/completions');
    let detectedBase = 'https://api.example.com/v1';
    for (const token of curl.split(/\s+/)) {
      if (token.startsWith('http://') || token.startsWith('https://')) {
        detectedBase = token;
        break;
      }
    }
    return json({
      specYaml: specFor('Drafted provider', detectedBase, '/chat/completions'),
      detectedKey: 'sk-demo-drafted-key',
      warnings: [],
    });
  }

  if (path === '/api/providers/test' && method === 'POST') {
    const spec = str(body.spec_yaml);
    const parsed = parseSpec(spec);
    return json({
      success: true,
      statusCode: 200,
      latencyMs: 418,
      preparedRequest: {
        url: `${parsed.baseUrl || 'https://api.example.com/v1'}/chat/completions`,
        method: 'POST',
        headers: { Authorization: 'Bearer ••••', 'Content-Type': 'application/json' },
        body: { model: 'demo-model', messages: [{ role: 'user', content: 'Write a 1-sentence haiku about speed.' }] },
      },
      rawResponse: { choices: [{ message: { role: 'assistant', content: 'Fast packets travel light — the pool reroutes in a blink.' } }] },
      mappedResponse: { choices: [{ message: { role: 'assistant', content: 'Fast packets travel light — the pool reroutes in a blink.' } }] },
      mappingError: null,
    });
  }

  if (path === '/api/providers/scan' && method === 'POST') {
    const preset = str(body.preset, 'openai');
    const models = preset === 'ollama' ? ['llama3.2', 'nomic-embed-text'] : ['gpt-4o-mini', 'gpt-4o', 'o3-mini'];
    return json({
      success: true,
      base_url: str(body.base_url, 'https://api.example.com/v1'),
      chat_path: preset === 'ollama' ? '/v1/chat/completions' : '/chat/completions',
      models_path: '/models',
      models,
      detected: preset === 'ollama' ? 'ollama' : 'openai',
      warnings: [],
    });
  }

  if (path === '/api/providers/quick-add' && method === 'POST') {
    const name = str(body.name, 'Demo provider');
    const providerId = uniqueId(slugify(name), state.providers.map((provider) => provider.id));
    const baseUrl = str(body.base_url, 'https://api.example.com/v1');
    const model = str(body.model, 'demo-model');
    const apiKey = str(body.api_key);
    const presetId = str(body.preset, 'openai');
    const chatPath = str(body.chat_path, '/chat/completions');
    const specYaml = specFor(name, baseUrl, chatPath);
    const provider: Provider = {
      id: providerId,
      name,
      description: str(body.description, 'Added from the interactive demo'),
      preset: presetId,
      spec_yaml: specYaml,
      is_active: 1,
    };
    state.providers.push(provider);

    let keyId: string | null = null;
    let maskedKey: string | null = null;
    if (apiKey) {
      const key = baseKey(providerId, `${name} · demo`, apiKey, {});
      key.id = uniqueId(`key-${slugify(name)}`, state.keys.map((entry) => entry.id));
      state.keys.push(key);
      keyId = key.id;
      maskedKey = key.masked_key;
    }

    const poolName = str(body.pool_name) || model;
    const aliasId = uniqueId(`pool-${slugify(poolName)}`, state.aliases.map((entry) => entry.id));
    const alias: ModelAlias = {
      id: aliasId,
      alias_name: poolName,
      strategy: 'weighted-by-health',
      targets: [{ provider_id: providerId, model, weight: 100, priority: 1 }],
      hedging_enabled: 0,
      hedged_delay_ms: 500,
      timeout_ms: num(body.timeout_ms, 30_000),
      is_active: 1,
      description: 'Added from the interactive demo',
      endpoint_kind: 'chat',
      daily_token_cap: 0,
      daily_spend_cap: 0,
      search_enabled: 0,
      search_provider: 'duckduckgo',
      search_max_results: 3,
      search_max_rounds: 3,
      search_off_notice: 0,
      classifier_provider_id: null,
      classifier_model: null,
      tiers: [],
    };
    state.aliases.push(alias);

    return json({
      success: true,
      provider_id: providerId,
      key_id: keyId,
      masked_key: maskedKey,
      alias_name: poolName,
      spec_yaml: specYaml,
    });
  }

  if (path === '/api/providers' && method === 'GET') {
    return json(state.providers);
  }

  if (path === '/api/providers' && method === 'POST') {
    const spec = str(body.spec_yaml);
    const parsed = parseSpec(spec);
    const name = parsed.name || 'Demo provider';
    const id = parsed.id || uniqueId(slugify(name), state.providers.map((provider) => provider.id));
    const existing = state.providers.find((provider) => provider.id === id);
    if (existing) {
      existing.name = name;
      existing.spec_yaml = spec;
    } else {
      state.providers.push({
        id,
        name,
        description: 'Saved in the demo',
        preset: 'openai',
        spec_yaml: spec,
        is_active: 1,
      });
    }
    return json({ success: true, id });
  }

  if (path.startsWith('/api/providers/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/providers/'.length));
    const before = state.providers.length;
    state.providers = state.providers.filter((provider) => provider.id !== id);
    if (state.providers.length === before) return json({ error: 'Provider not found' }, 404);
    state.keys = state.keys.filter((key) => key.provider_id !== id);
    state.aliases = state.aliases
      .map((alias) => ({ ...alias, targets: alias.targets.filter((target) => target.provider_id !== id) }))
      .filter((alias) => alias.targets.length > 0);
    return json({ success: true });
  }

  if (path === '/api/keys' && method === 'GET') {
    return json(state.keys);
  }

  if (path === '/api/keys' && method === 'POST') {
    const providerId = str(body.provider_id);
    if (!state.providers.some((provider) => provider.id === providerId)) {
      return json({ error: 'Choose an existing provider first.' }, 400);
    }
    const keyName = str(body.key_name, 'Demo key');
    const key = baseKey(providerId, keyName, str(body.api_key), body);
    key.id = uniqueId(`key-${slugify(keyName)}`, state.keys.map((entry) => entry.id));
    state.keys.push(key);
    return json({ success: true, id: key.id });
  }

  if (path.startsWith('/api/keys/') && method === 'PUT') {
    const id = decodeURIComponent(path.slice('/api/keys/'.length));
    const key = state.keys.find((entry) => entry.id === id);
    if (!key) return json({ error: 'Key not found' }, 404);
    if (body.reset_circuit) {
      key.circuit_state = 'CLOSED';
      key.consecutive_failures = 0;
      key.cooldown_until = 0;
      key.disabled_reason = null;
      key.last_error = null;
      key.is_active = true;
    }
    if (typeof body.is_active === 'boolean') key.is_active = body.is_active;
    if (typeof body.rpm_cap === 'number') key.rpm_cap = body.rpm_cap;
    if (typeof body.tpm_cap === 'number') key.tpm_cap = body.tpm_cap;
    if (typeof body.daily_budget_cap === 'number') key.daily_budget_cap = body.daily_budget_cap;
    return json({ success: true });
  }

  if (path.startsWith('/api/keys/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/keys/'.length));
    const before = state.keys.length;
    state.keys = state.keys.filter((key) => key.id !== id);
    return json({ success: state.keys.length !== before });
  }

  if (path === '/api/aliases' && method === 'GET') {
    return json(state.aliases);
  }

  if (path === '/api/aliases' && method === 'POST') {
    const aliasName = str(body.alias_name).trim();
    if (!aliasName) return json({ error: 'Pool name is required' }, 400);
    const targets = Array.isArray(body.targets) ? (body.targets as TargetConfig[]) : [];
    if (targets.length === 0) return json({ error: 'At least one target is required' }, 400);
    const wantedId = str(body.id);
    const existing = state.aliases.find((alias) => (wantedId && alias.id === wantedId) || alias.alias_name === aliasName);
    const alias: ModelAlias = {
      id: existing?.id ?? uniqueId(`pool-${slugify(aliasName)}`, state.aliases.map((entry) => entry.id)),
      alias_name: aliasName,
      strategy: (str(body.strategy, existing?.strategy ?? 'weighted-by-health') as ModelAlias['strategy']),
      targets,
      hedging_enabled: body.hedging_enabled === undefined ? existing?.hedging_enabled ?? 0 : Number(body.hedging_enabled),
      hedged_delay_ms: num(body.hedged_delay_ms, existing?.hedged_delay_ms ?? 500),
      timeout_ms: num(body.timeout_ms, existing?.timeout_ms ?? 30_000),
      is_active: existing?.is_active ?? 1,
      description: body.description === null ? null : str(body.description, existing?.description ?? ''),
      endpoint_kind: (str(body.endpoint_kind, existing?.endpoint_kind ?? 'chat') as ModelAlias['endpoint_kind']),
      daily_token_cap: num(body.daily_token_cap, existing?.daily_token_cap ?? 0),
      daily_spend_cap: num(body.daily_spend_cap, existing?.daily_spend_cap ?? 0),
      search_enabled: body.search_enabled === undefined ? existing?.search_enabled ?? 0 : Number(body.search_enabled),
      search_provider: str(body.search_provider, existing?.search_provider ?? 'duckduckgo'),
      search_max_results: num(body.search_max_results, existing?.search_max_results ?? 3),
      search_max_rounds: num(body.search_max_rounds, existing?.search_max_rounds ?? 3),
      search_off_notice: body.search_off_notice === undefined ? existing?.search_off_notice ?? 0 : Number(body.search_off_notice),
      classifier_provider_id: body.classifier_provider_id === null ? null : str(body.classifier_provider_id, existing?.classifier_provider_id ?? '') || null,
      classifier_model: body.classifier_model === null ? null : str(body.classifier_model, existing?.classifier_model ?? '') || null,
      tiers: Array.isArray(body.tiers) ? (body.tiers as ModelAlias['tiers']) : existing?.tiers ?? [],
    };
    if (existing) {
      state.aliases = state.aliases.map((entry) => (entry.id === existing.id ? alias : entry));
    } else {
      state.aliases.push(alias);
    }
    return json({ success: true, id: alias.id });
  }

  if (path.startsWith('/api/aliases/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/aliases/'.length));
    const before = state.aliases.length;
    state.aliases = state.aliases.filter((alias) => alias.id !== id);
    return json({ success: state.aliases.length !== before });
  }

  if (path === '/api/gateway-keys' && method === 'GET') {
    return json(state.gatewayKeys);
  }

  if (path === '/api/gateway-keys' && method === 'POST') {
    const name = str(body.name, 'Demo gateway key');
    const token = `kg-demo-${randomHex(24)}`;
    const expiresInDays = num(body.expires_in_days, 0);
    const key: GatewayKey = {
      id: uniqueId(`gk-${slugify(name)}`, state.gatewayKeys.map((entry) => entry.id)),
      name,
      masked_token: `${token.slice(0, 8)}••••${token.slice(-4)}`,
      is_active: true,
      rpm_limit: num(body.rpm_limit, 0),
      tpm_limit: num(body.tpm_limit, 0),
      allowed_aliases: Array.isArray(body.allowed_aliases) ? body.allowed_aliases.filter((value): value is string => typeof value === 'string') : [],
      expires_at: expiresInDays > 0 ? Date.now() + expiresInDays * 86_400_000 : null,
      created_at: new Date().toISOString(),
    };
    state.gatewayKeys.push(key);
    return json({ token, id: key.id, name });
  }

  if (path.startsWith('/api/gateway-keys/') && method === 'POST' && path.endsWith('/revoke')) {
    const id = decodeURIComponent(path.slice('/api/gateway-keys/'.length, -'/revoke'.length));
    const key = state.gatewayKeys.find((entry) => entry.id === id);
    if (!key) return json({ error: 'Gateway key not found' }, 404);
    key.is_active = false;
    return json({ success: true });
  }

  if (path.startsWith('/api/gateway-keys/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/gateway-keys/'.length));
    const before = state.gatewayKeys.length;
    state.gatewayKeys = state.gatewayKeys.filter((key) => key.id !== id);
    return json({ success: state.gatewayKeys.length !== before });
  }

  if (path === '/api/history' && method === 'GET') {
    const pool = url.searchParams.get('pool');
    const limit = Number(url.searchParams.get('limit') ?? '300') || 300;
    const entries = state.history
      .filter((entry) => !pool || entry.pool_name === pool)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
    const counts = new Map<string, number>();
    for (const entry of state.history) {
      counts.set(entry.pool_name, (counts.get(entry.pool_name) ?? 0) + 1);
    }
    const pools = [...counts.entries()].map(([pool_name, count]) => ({ pool_name, count }));
    return json({ entries, pools });
  }

  if (path === '/api/history' && method === 'DELETE') {
    const pool = url.searchParams.get('pool');
    const before = state.history.length;
    state.history = state.history.filter((entry) => (pool ? entry.pool_name !== pool : false));
    return json({ removed: before - state.history.length });
  }

  if (path.startsWith('/api/history/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/history/'.length));
    const before = state.history.length;
    state.history = state.history.filter((entry) => entry.id !== id);
    return json({ success: state.history.length !== before });
  }

  if (path === '/api/logs' && method === 'GET') {
    const status = url.searchParams.get('status');
    const providerId = url.searchParams.get('provider_id');
    const model = url.searchParams.get('model');
    const endpoint = url.searchParams.get('endpoint');
    const limit = Number(url.searchParams.get('limit') ?? '200') || 200;
    const logs = state.logs
      .filter((log) => !status || log.status === status)
      .filter((log) => !providerId || log.provider_id === providerId)
      .filter((log) => !model || log.model === model)
      .filter((log) => !endpoint || log.endpoint === endpoint)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
    return json(logs);
  }

  if (path === '/api/pricing' && method === 'GET') {
    return json(state.pricing);
  }

  if (path === '/api/pricing' && method === 'POST') {
    const providerId = str(body.provider_id);
    const model = str(body.model);
    if (!providerId || !model) return json({ error: 'Provider and model are required' }, 400);
    const existing = state.pricing.find(
      (row) => (str(body.id) && row.id === body.id) || (row.provider_id === providerId && row.model === model)
    );
    if (existing) {
      existing.input_per_mtok = num(body.input_per_mtok, existing.input_per_mtok);
      existing.output_per_mtok = num(body.output_per_mtok, existing.output_per_mtok);
      existing.updated_at = new Date().toISOString();
      return json({ success: true, id: existing.id });
    }
    const row: ModelPricing = {
      id: uniqueId(`price-${slugify(model)}`, state.pricing.map((entry) => entry.id)),
      provider_id: providerId,
      model,
      input_per_mtok: num(body.input_per_mtok, 0),
      output_per_mtok: num(body.output_per_mtok, 0),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    state.pricing.push(row);
    return json({ success: true, id: row.id });
  }

  if (path.startsWith('/api/pricing/') && method === 'DELETE') {
    const id = decodeURIComponent(path.slice('/api/pricing/'.length));
    const before = state.pricing.length;
    state.pricing = state.pricing.filter((row) => row.id !== id);
    return json({ success: state.pricing.length !== before });
  }

  if (path === '/v1/models' && method === 'GET') {
    return json({
      object: 'list',
      data: state.aliases.map((alias) => ({
        id: alias.alias_name,
        object: 'model',
        owned_by: 'keygate-demo',
        endpoint_kind: alias.endpoint_kind,
      })),
    });
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    return completionResponse(state, body, init?.signal);
  }

  if (path.startsWith('/api/')) {
    return json({ error: `Demo API has no route for ${method} ${path}` }, 404);
  }

  return null;
}

let installed = false;

export function installMockApi(): void {
  if (installed) return;
  installed = true;
  const state = createSeedState();

  // The playground sends a bearer token; prefill a demo one so the tab works
  // without asking the reviewer to invent a credential.
  sessionStorage.setItem('keygate.playground_key', DEMO_GATEWAY_KEY);

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();

    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/v1/')) {
      return originalFetch(input as RequestInfo, init);
    }

    try {
      // No artificial latency: a background tab gets its timers throttled to
      // once a minute, which would make tabs that fetch on mount look hung.
      const response = await route(state, url, method, init);
      return response ?? json({ error: 'Not found' }, 404);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return json({ error: err instanceof Error ? err.message : 'Demo API error' }, 500);
    }
  };
}
