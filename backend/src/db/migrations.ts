import type { Database } from 'better-sqlite3';

interface ColumnInfo {
  name: string;
}

// DECISION: There is no migration framework in this project (schema.ts is CREATE TABLE IF NOT
// EXISTS only), so schema evolution is handled by idempotent, additive-only ALTER TABLE statements.
// Nothing here ever drops or rewrites a column, which keeps existing databases safe to open.
function ensureColumn(db: Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function runMigrations(db: Database): void {
  // Model aliases are KeyGate's "AI pools": a virtual model name mapped to a target chain.
  ensureColumn(db, 'model_aliases', 'description', 'TEXT');
  ensureColumn(db, 'model_aliases', 'endpoint_kind', "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn(db, 'model_aliases', 'daily_token_cap', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'model_aliases', 'daily_spend_cap', 'REAL NOT NULL DEFAULT 0');

  // Per-pool online web search and the 'by-ai' routing strategy.
  ensureColumn(db, 'model_aliases', 'search_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'model_aliases', 'search_provider', "TEXT NOT NULL DEFAULT 'duckduckgo'");
  ensureColumn(db, 'model_aliases', 'search_max_results', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'model_aliases', 'search_max_rounds', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'model_aliases', 'search_off_notice', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'model_aliases', 'classifier_provider_id', 'TEXT');
  ensureColumn(db, 'model_aliases', 'classifier_model', 'TEXT');
  ensureColumn(db, 'model_aliases', 'tiers_json', "TEXT NOT NULL DEFAULT '[]'");

  // Per-request observability: which OpenAI endpoint was served, what it cost, which pool served it.
  ensureColumn(db, 'request_logs', 'endpoint', "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn(db, 'request_logs', 'cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'request_logs', 'pool_name', 'TEXT');

  // Master-key rotation: records which key generation encrypted the row so operators can find
  // rows still using a retired key. Old rows default to version 1, the only generation that
  // existed before this column was introduced.
  ensureColumn(db, 'api_keys', 'key_version', 'INTEGER NOT NULL DEFAULT 1');

  // Lookup indexes for the queries the console and repos actually run. CREATE INDEX IF NOT
  // EXISTS is repeated here (as well as in schema.ts) so databases created before the index
  // existed pick it up on the next start.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_provider_id ON api_keys(provider_id);
    CREATE INDEX IF NOT EXISTS idx_chat_history_trace_id ON chat_history(trace_id);
  `);
}
