export interface Provider {
  id: string;
  name: string;
  description?: string;
  preset: string;
  spec_yaml: string;
  is_active: number;
}

export interface ApiKeyItem {
  id: string;
  provider_id: string;
  key_name: string;
  masked_key: string;
  key_prefix: string;
  key_suffix: string;
  is_active: boolean;
  circuit_state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
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
  daily_budget_cap: number;
  daily_usage: number;
}

export interface TargetConfig {
  provider_id: string;
  model: string;
  weight: number;
  priority: number;
}

export interface ModelAlias {
  id: string;
  alias_name: string;
  strategy: 'weighted-by-health' | 'round-robin' | 'priority';
  targets: TargetConfig[];
  hedging_enabled: number | boolean;
  hedged_delay_ms: number;
  timeout_ms: number;
  is_active: number | boolean;
}

export interface GatewayKey {
  id: string;
  name: string;
  masked_token: string;
  is_active: boolean;
  rpm_limit: number;
  tpm_limit: number;
  allowed_aliases: string[];
  expires_at: number | null;
  created_at: string;
}

export interface RequestLog {
  id: string;
  trace_id: string;
  gateway_key_id: string | null;
  alias_name: string | null;
  provider_id: string;
  key_id: string;
  model: string;
  status: 'success' | 'error';
  status_code: number;
  error_type: string | null;
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  is_stream: number;
  is_hedged: number;
  request_snippet: string | null;
  response_snippet: string | null;
  created_at: string;
}

export interface DashboardStats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalKeys: number;
  activeKeys: number;
  totalProviders: number;
  circuits: {
    closed: number;
    halfOpen: number;
    open: number;
  };
}
