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

  // Per-request observability: which OpenAI endpoint was served, what it cost, which pool served it.
  ensureColumn(db, 'request_logs', 'endpoint', "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn(db, 'request_logs', 'cost', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'request_logs', 'pool_name', 'TEXT');
}
