export type ErrorClassificationType = 'rate_limit' | 'auth_fail' | 'quota_exhausted' | 'retryable' | 'fatal';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type RoutingStrategy = 'weighted-by-health' | 'round-robin' | 'priority';
export type StreamingType = 'none' | 'sse' | 'ndjson';
export interface ProviderAuth {
    type: 'header' | 'query' | 'body';
    name?: string;
    template: string;
}
export interface MappingConfig {
    engine: 'handlebars' | 'jsonata' | 'preset';
    template?: string;
}
export interface ErrorClassificationRule {
    status_codes?: number[];
    body_patterns?: string[];
    error_type: ErrorClassificationType;
}
export interface RateLimitHeadersConfig {
    retry_after?: string;
    reset?: string;
    remaining?: string;
}
export interface ProviderSpec {
    id: string;
    name: string;
    description?: string;
    preset?: 'openai-compatible' | 'custom';
    base_url: string;
    endpoint_paths: {
        chat?: string;
        embeddings?: string;
        models?: string;
    };
    http_method: 'POST' | 'GET' | string;
    auth: ProviderAuth;
    request_mapping?: MappingConfig;
    response_mapping?: MappingConfig;
    streaming?: {
        type: StreamingType;
        chunk_mapping?: MappingConfig;
    };
    error_classification?: ErrorClassificationRule[];
    rate_limit_headers?: RateLimitHeadersConfig;
    model_name_map?: Record<string, string>;
    custom_adapter?: string;
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
    is_active: number;
    rpm_cap: number;
    tpm_cap: number;
    daily_budget_cap: number;
    current_rpm: number;
    current_tpm: number;
    daily_usage: number;
    consecutive_failures: number;
    circuit_state: CircuitState;
    cooldown_until: number;
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
export interface ModelAliasRecord {
    id: string;
    alias_name: string;
    strategy: RoutingStrategy;
    targets_json: string;
    hedging_enabled: number;
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
    allowed_aliases_json: string;
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
export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
    content: string | any[] | null;
    name?: string;
    tool_calls?: any[];
    tool_call_id?: string;
}
export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIMessage[];
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stream?: boolean;
    tools?: any[];
    tool_choice?: any;
    user?: string;
    [key: string]: any;
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
