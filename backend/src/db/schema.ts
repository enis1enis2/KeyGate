// DECISION: SQLite with WAL mode delivers high concurrency for gateway proxying while remaining zero-dependency for self-hosting.

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  preset TEXT DEFAULT 'custom',
  spec_yaml TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  key_name TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_suffix TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  rpm_cap INTEGER NOT NULL DEFAULT 0,
  tpm_cap INTEGER NOT NULL DEFAULT 0,
  daily_budget_cap REAL NOT NULL DEFAULT 0,
  current_rpm INTEGER NOT NULL DEFAULT 0,
  current_tpm INTEGER NOT NULL DEFAULT 0,
  daily_usage REAL NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_state TEXT NOT NULL DEFAULT 'CLOSED',
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_aliases (
  id TEXT PRIMARY KEY,
  alias_name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'weighted-by-health',
  targets_json TEXT NOT NULL DEFAULT '[]',
  hedging_enabled INTEGER NOT NULL DEFAULT 0,
  hedged_delay_ms INTEGER NOT NULL DEFAULT 500,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  token_suffix TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  tpm_limit INTEGER NOT NULL DEFAULT 0,
  allowed_aliases_json TEXT NOT NULL DEFAULT '["*"]',
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  gateway_key_id TEXT,
  alias_name TEXT,
  provider_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  error_type TEXT,
  latency_ms INTEGER NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  is_hedged INTEGER NOT NULL DEFAULT 0,
  request_snippet TEXT,
  response_snippet TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_key_id ON request_logs(key_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_status ON request_logs(status);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider_id ON request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_request_logs_gateway_key_created ON request_logs(gateway_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_logs_alias_created ON request_logs(alias_name, created_at);

-- Per-token pricing used to compute request cost, enforce daily budgets and report spend.
-- provider_id/model of '*' act as wildcards so a single row can price a whole provider.
CREATE TABLE IF NOT EXISTS model_pricing (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL DEFAULT '*',
  model TEXT NOT NULL DEFAULT '*',
  input_per_mtok REAL NOT NULL DEFAULT 0,
  output_per_mtok REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_model_pricing_lookup ON model_pricing(provider_id, model);

-- Sticky routing for resources that live on a single upstream account (batches, files).
CREATE TABLE IF NOT EXISTS sticky_routes (
  resource_id TEXT PRIMARY KEY,
  pool_name TEXT,
  endpoint TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sticky_routes_created_at ON sticky_routes(created_at);

-- Per-pool chat history: the prompt/answer pair captured from gateway chat completions,
-- grouped by trace_id so the UI can render one user+assistant exchange per gateway call.
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  is_stream INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_history_pool_created ON chat_history(pool_name, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_history_created ON chat_history(created_at);
`;
