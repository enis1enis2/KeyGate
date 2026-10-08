// DECISION: Full TypeScript schemas provide strict compile-time safety and runtime validation for specs and logs.

export type ErrorClassificationType = 
  | 'rate_limit'
  | 'auth_fail'
  | 'quota_exhausted'
  | 'timeout'
  | 'retryable'
  | 'fatal';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export type RoutingStrategy = 'weighted-by-health' | 'round-robin' | 'priority';

export type StreamingType = 'none' | 'sse' | 'ndjson';

export interface ProviderAuth {
  type: 'header' | 'query' | 'body';
  name?: string; // e.g. "Authorization", "x-api-key", or query param name "key"
  template: string; // e.g. "Bearer {{key}}" or "{{key}}"
}

export interface MappingConfig {
  engine: 'handlebars' | 'jsonata' | 'preset';
  template?: string; // template string or JSONata query
}

export interface ErrorClassificationRule {
  status_codes?: number[];
  body_patterns?: string[];
  error_type: ErrorClassificationType;
}

export interface RateLimitHeadersConfig {
  retry_after?: string; // default "Retry-After"
  reset?: string;       // e.g. "x-ratelimit-reset-requests"
  remaining?: string;   // e.g. "x-ratelimit-remaining-requests"
}

// Every OpenAI endpoint surface KeyGate can proxy. Keys are looked up on ProviderSpec
//.endpoint_paths, falling back to DEFAULT_ENDPOINT_PATHS when a provider omits one.
export type EndpointPathKey =
  | 'chat'
  | 'embeddings'
  | 'models'
  | 'responses'
  | 'completions'
  | 'moderations'
  | 'images'
  | 'images_edits'
  | 'images_variations'
  | 'audio_transcriptions'
  | 'audio_translations'
  | 'audio_speech'
  | 'batches'
  | 'files';

export interface EndpointPaths {
  chat?: string;
  embeddings?: string;
  models?: string;
  responses?: string;
  completions?: string;
  moderations?: string;
  images?: string;
  images_edits?: string;
  images_variations?: string;
  audio_transcriptions?: string;
  audio_translations?: string;
  audio_speech?: string;
  batches?: string;
  files?: string;
  // Forward compatibility: providers may declare paths for surfaces added later.
  [key: string]: string | undefined;
}

// Default upstream paths, relative to ProviderSpec.base_url (which normally ends in /v1).
export const DEFAULT_ENDPOINT_PATHS: Record<EndpointPathKey, string> = {
  chat: '/chat/completions',
  embeddings: '/embeddings',
  models: '/models',
  responses: '/responses',
  completions: '/completions',
  moderations: '/moderations',
  images: '/images/generations',
  images_edits: '/images/edits',
  images_variations: '/images/variations',
  audio_transcriptions: '/audio/transcriptions',
  audio_translations: '/audio/translations',
  audio_speech: '/audio/speech',
  batches: '/batches',
  files: '/files',
};

export interface ProviderSpec {
  id: string;
  name: string;
  description?: string;
  preset?: 'openai-compatible' | 'custom';
  base_url: string;
  endpoint_paths: EndpointPaths;
  http_method: 'POST' | 'GET' | string;
  auth: ProviderAuth;
  /** Extra headers sent verbatim on every upstream request (e.g. anthropic-version). */
  static_headers?: Record<string, string>;
  request_mapping?: MappingConfig;
  response_mapping?: MappingConfig;
  streaming?: {
    type: StreamingType;
    chunk_mapping?: MappingConfig;
  };
  error_classification?: ErrorClassificationRule[];
  rate_limit_headers?: RateLimitHeadersConfig;
  model_name_map?: Record<string, string>;
  custom_adapter?: string; // Path or module name for JS/TS adapter plugin escape hatch
}

export interface ApiKeyRecord {
  id: string;
  provider_id: string;
  key_name: string;
  encrypted_key: string;
  iv: string;
  tag: string;
  key_prefix: string;
  key_suffix: string;
  is_active: number; // 1 or 0
  rpm_cap: number;
  tpm_cap: number;
  daily_budget_cap: number;
  current_rpm: number;
  current_tpm: number;
  daily_usage: number;
  consecutive_failures: number;
  circuit_state: CircuitState;
  cooldown_until: number; // timestamp in ms
  disabled_reason: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface TargetConfig {
  provider_id: string;
  model: string;
  weight: number;
  priority: number;
}

// Which OpenAI endpoint surface an AI pool serves. Phase 1 stores it; Phase 2 wires routing.
export type EndpointKind =
  | 'chat'
  | 'responses'
  | 'completions'
  | 'embeddings'
  | 'images'
  | 'audio'
  | 'moderations'
  | 'batches'
  | 'files';

export interface ModelAliasRecord {
  id: string;
  alias_name: string;
  strategy: RoutingStrategy;
  targets_json: string; // serialized TargetConfig[]
  description: string | null;
  endpoint_kind: string; // EndpointKind
  daily_token_cap: number; // 0 = unlimited
  daily_spend_cap: number; // 0 = unlimited, USD
  hedging_enabled: number; // 1 or 0
  hedged_delay_ms: number;
  timeout_ms: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface GatewayKeyRecord {
  id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  token_suffix: string;
  is_active: number;
  rpm_limit: number;
  tpm_limit: number;
  allowed_aliases_json: string; // JSON array of allowed alias names or ["*"]
  expires_at: number | null;
  created_at: string;
  updated_at: string;
}

export interface RequestLogRecord {
  id: string;
  trace_id: string;
  gateway_key_id: string | null;
  alias_name: string | null;
  provider_id: string;
  key_id: string;
  model: string;
  status: 'success' | 'error';
  status_code: number;
  error_type: ErrorClassificationType | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  is_stream: number;
  is_hedged: number;
  request_snippet: string | null;
  response_snippet: string | null;
  endpoint: string; // EndpointKind of the surface that served this request
  cost: number; // USD, derived from model_pricing
  pool_name: string | null; // AI pool (model alias) that routed this request
  created_at: string;
}

// USD per million tokens. provider_id '*' and model '*' are wildcards used as pricing fallbacks.
export interface ModelPricingRecord {
  id: string;
  provider_id: string;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  created_at: string;
  updated_at: string;
}

// Batches and files are created on ONE upstream account, so every follow-up call for that
// resource must be replayed against the same provider key or the upstream returns 404.
export interface StickyRouteRecord {
  resource_id: string;
  pool_name: string | null;
  endpoint: string;
  provider_id: string;
  key_id: string;
  created_at: string;
}

// A single prompt or answer captured from a gateway chat completion, grouped by trace_id.
// Only message text is stored (no request headers/body plumbing), one row per role.
export interface ChatHistoryRecord {
  id: string;
  trace_id: string;
  pool_name: string;
  provider_id: string;
  key_id: string;
  model: string;
  role: 'user' | 'assistant';
  content: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  is_stream: number;
  created_at: string;
}

export interface KeyHealthStats {
  key_id: string;
  provider_id: string;
  key_name: string;
  key_prefix: string;
  key_suffix: string;
  is_active: boolean;
  circuit_state: CircuitState;
  cooldown_until: number;
  consecutive_failures: number;
  disabled_reason: string | null;
  last_error: string | null;
  rolling_success_rate: number;
  latency_p50: number;
  latency_p95: number;
  total_calls_window: number;
  rpm_cap: number;
  current_rpm: number;
  tpm_cap: number;
  current_tpm: number;
}

// OpenAI Standard Protocol Types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
  content: string | unknown[] | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  user?: string;
  [key: string]: unknown;
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIChunkChoice {
  index: number;
  delta: Partial<OpenAIMessage>;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIChunkChoice[];
}
