import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { SCHEMA_SQL } from './schema.js';
import { runMigrations } from './migrations.js';
import type { 
  ApiKeyRecord, 
  ModelAliasRecord, 
  GatewayKeyRecord, 
  RequestLogRecord,
  ModelPricingRecord,
  StickyRouteRecord
} from '../types/index.js';

interface ProviderRow {
  id: string;
  name: string;
  description: string | null;
  preset: string;
  spec_yaml: string;
  is_active: number;
}

interface StatsRow {
  totalRequests?: number;
  successRequests?: number;
  errorRequests?: number;
  avgLatencyMs?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
}

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  // DECISION: Automatically ensure the directory for SQLite exists before instantiating better-sqlite3.
  const dir = path.dirname(CONFIG.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = new Database(CONFIG.dbPath);
  dbInstance.exec(SCHEMA_SQL);
  runMigrations(dbInstance);

  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ----------------- PROVIDER REPOSITORY -----------------
export const ProviderRepo = {
  create(provider: { id: string; name: string; description?: string; preset?: string; spec_yaml: string }): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO providers (id, name, description, preset, spec_yaml, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        preset = excluded.preset,
        spec_yaml = excluded.spec_yaml,
        updated_at = datetime('now')
    `);
    stmt.run(provider.id, provider.name, provider.description || null, provider.preset || 'custom', provider.spec_yaml);
  },

  getAll(): ProviderRow[] {
    const db = getDb();
    return db.prepare(`SELECT * FROM providers ORDER BY name ASC`).all() as ProviderRow[];
  },

  getById(id: string): ProviderRow | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
    return (row as ProviderRow | undefined) || null;
  },

  delete(id: string): boolean {
    const db = getDb();
    const res = db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
    return res.changes > 0;
  },

  toggleActive(id: string, isActive: boolean): void {
    const db = getDb();
    db.prepare(`UPDATE providers SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(isActive ? 1 : 0, id);
  }
};

// ----------------- API KEY REPOSITORY -----------------
export const ApiKeyRepo = {
  create(key: {
    id: string;
    provider_id: string;
    key_name: string;
    encrypted_key: string;
    iv: string;
    tag: string;
    key_prefix: string;
    key_suffix: string;
    rpm_cap?: number;
    tpm_cap?: number;
    daily_budget_cap?: number;
  }): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO api_keys (
        id, provider_id, key_name, encrypted_key, iv, tag, key_prefix, key_suffix,
        rpm_cap, tpm_cap, daily_budget_cap, is_active, circuit_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'CLOSED', datetime('now'))
    `);
    stmt.run(
      key.id,
      key.provider_id,
      key.key_name,
      key.encrypted_key,
      key.iv,
      key.tag,
      key.key_prefix,
      key.key_suffix,
      key.rpm_cap || 0,
      key.tpm_cap || 0,
      key.daily_budget_cap || 0
    );
  },

  getAll(): ApiKeyRecord[] {
    const db = getDb();
    return db.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`).all() as ApiKeyRecord[];
  },

  getByProvider(providerId: string): ApiKeyRecord[] {
    const db = getDb();
    return db.prepare(`SELECT * FROM api_keys WHERE provider_id = ? ORDER BY created_at DESC`).all(providerId) as ApiKeyRecord[];
  },

  getById(id: string): ApiKeyRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id);
    return (row as ApiKeyRecord) || null;
  },

  updateCircuitState(id: string, state: string, cooldownUntil: number, consecutiveFailures: number, lastError?: string, disabledReason?: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE api_keys 
      SET circuit_state = ?, cooldown_until = ?, consecutive_failures = ?, 
          last_error = coalesce(?, last_error), disabled_reason = coalesce(?, disabled_reason),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(state, cooldownUntil, consecutiveFailures, lastError || null, disabledReason || null, id);
  },

  toggleActive(id: string, isActive: boolean, disabledReason?: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE api_keys 
      SET is_active = ?, disabled_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(isActive ? 1 : 0, disabledReason || null, id);
  },

  updateCaps(id: string, rpm_cap: number, tpm_cap: number, daily_budget_cap: number): void {
    const db = getDb();
    db.prepare(`
      UPDATE api_keys 
      SET rpm_cap = ?, tpm_cap = ?, daily_budget_cap = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(rpm_cap, tpm_cap, daily_budget_cap, id);
  },

  delete(id: string): boolean {
    const db = getDb();
    const res = db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
    return res.changes > 0;
  },

  // Lifetime cumulative spend for this key. The daily budget gate reads
  // RequestLogRepo.getSpendByKeyToday() instead, so day rollover needs no reset job.
  addDailyUsage(id: string, amount: number): void {
    if (!(amount > 0)) return;
    const db = getDb();
    db.prepare(`UPDATE api_keys SET daily_usage = daily_usage + ?, updated_at = datetime('now') WHERE id = ?`)
      .run(amount, id);
  }
};

// ----------------- MODEL ALIAS REPOSITORY -----------------
export const ModelAliasRepo = {
  upsert(alias: {
    id: string;
    alias_name: string;
    strategy: string;
    targets_json: string;
    description?: string | null;
    endpoint_kind?: string;
    daily_token_cap?: number;
    daily_spend_cap?: number;
    hedging_enabled?: boolean;
    hedged_delay_ms?: number;
    timeout_ms?: number;
    is_active?: boolean;
  }): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO model_aliases (
        id, alias_name, strategy, targets_json, description, endpoint_kind,
        daily_token_cap, daily_spend_cap, hedging_enabled, hedged_delay_ms, timeout_ms, is_active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(alias_name) DO UPDATE SET
        strategy = excluded.strategy,
        targets_json = excluded.targets_json,
        description = excluded.description,
        endpoint_kind = excluded.endpoint_kind,
        daily_token_cap = excluded.daily_token_cap,
        daily_spend_cap = excluded.daily_spend_cap,
        hedging_enabled = excluded.hedging_enabled,
        hedged_delay_ms = excluded.hedged_delay_ms,
        timeout_ms = excluded.timeout_ms,
        is_active = excluded.is_active,
        updated_at = datetime('now')
    `);
    stmt.run(
      alias.id,
      alias.alias_name,
      alias.strategy,
      alias.targets_json,
      alias.description || null,
      alias.endpoint_kind || 'chat',
      alias.daily_token_cap || 0,
      alias.daily_spend_cap || 0,
      alias.hedging_enabled ? 1 : 0,
      alias.hedged_delay_ms || 500,
      alias.timeout_ms || 30000,
      alias.is_active !== false ? 1 : 0
    );
  },

  getAll(): ModelAliasRecord[] {
    const db = getDb();
    return db.prepare(`SELECT * FROM model_aliases ORDER BY alias_name ASC`).all() as ModelAliasRecord[];
  },

  getByName(name: string): ModelAliasRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM model_aliases WHERE alias_name = ? AND is_active = 1`).get(name);
    return (row as ModelAliasRecord) || null;
  },

  getById(id: string): ModelAliasRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM model_aliases WHERE id = ?`).get(id);
    return (row as ModelAliasRecord) || null;
  },

  delete(id: string): boolean {
    const db = getDb();
    const res = db.prepare(`DELETE FROM model_aliases WHERE id = ?`).run(id);
    return res.changes > 0;
  }
};

// ----------------- GATEWAY KEY REPOSITORY -----------------
export const GatewayKeyRepo = {
  create(key: {
    id: string;
    name: string;
    token_hash: string;
    token_prefix: string;
    token_suffix: string;
    rpm_limit?: number;
    tpm_limit?: number;
    allowed_aliases_json?: string;
    expires_at?: number | null;
  }): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO gateway_keys (
        id, name, token_hash, token_prefix, token_suffix, is_active,
        rpm_limit, tpm_limit, allowed_aliases_json, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        token_hash = excluded.token_hash,
        token_prefix = excluded.token_prefix,
        token_suffix = excluded.token_suffix,
        is_active = 1,
        updated_at = datetime('now')
    `);
    stmt.run(
      key.id,
      key.name,
      key.token_hash,
      key.token_prefix,
      key.token_suffix,
      key.rpm_limit || 0,
      key.tpm_limit || 0,
      key.allowed_aliases_json || '["*"]',
      key.expires_at || null
    );
  },

  getAll(): GatewayKeyRecord[] {
    const db = getDb();
    return db.prepare(`SELECT * FROM gateway_keys ORDER BY created_at DESC`).all() as GatewayKeyRecord[];
  },

  getByHash(hash: string): GatewayKeyRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM gateway_keys WHERE token_hash = ? AND is_active = 1`).get(hash);
    return (row as GatewayKeyRecord) || null;
  },

  revoke(id: string): boolean {
    const db = getDb();
    const res = db.prepare(`UPDATE gateway_keys SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return res.changes > 0;
  },

  delete(id: string): boolean {
    const db = getDb();
    const res = db.prepare(`DELETE FROM gateway_keys WHERE id = ?`).run(id);
    return res.changes > 0;
  }
};

// ----------------- REQUEST LOGS REPOSITORY -----------------
export const RequestLogRepo = {
  insert(log: RequestLogRecord): void {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO request_logs (
        id, trace_id, gateway_key_id, alias_name, provider_id, key_id, model,
        status, status_code, error_type, latency_ms, prompt_tokens, completion_tokens,
        is_stream, is_hedged, request_snippet, response_snippet,
        endpoint, cost, pool_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.id,
      log.trace_id,
      log.gateway_key_id || null,
      log.alias_name || null,
      log.provider_id,
      log.key_id,
      log.model,
      log.status,
      log.status_code,
      log.error_type || null,
      log.latency_ms,
      log.prompt_tokens,
      log.completion_tokens,
      log.is_stream,
      log.is_hedged,
      log.request_snippet || null,
      log.response_snippet || null,
      log.endpoint || 'chat',
      log.cost || 0,
      log.pool_name || null
    );
  },

  // Streaming responses finish after the router has already written its log row,
  // so real usage/cost is backfilled here once the upstream stream is drained.
  finalizeUsage(traceId: string, promptTokens: number, completionTokens: number, cost: number): boolean {
    const db = getDb();
    const res = db.prepare(`
      UPDATE request_logs
      SET prompt_tokens = ?, completion_tokens = ?, cost = ?
      WHERE trace_id = ?
    `).run(promptTokens, completionTokens, cost, traceId);
    return res.changes > 0;
  },

  getSpendByKeyToday(keyId: string): number {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) AS spend
      FROM request_logs
      WHERE key_id = ? AND created_at >= datetime('now', 'start of day')
    `).get(keyId) as { spend?: number } | undefined;
    return row?.spend || 0;
  },

  getUsageTodayByPool(aliasName: string): { tokens: number; spend: number } {
    const db = getDb();
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
        COALESCE(SUM(cost), 0) AS spend
      FROM request_logs
      WHERE alias_name = ? AND created_at >= datetime('now', 'start of day')
    `).get(aliasName) as { tokens?: number; spend?: number } | undefined;
    return { tokens: row?.tokens || 0, spend: row?.spend || 0 };
  },

  getUsageTodayByGatewayKey(gatewayKeyId: string): { tokens: number; spend: number; requests: number } {
    const db = getDb();
    const row = db.prepare(`
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
        COALESCE(SUM(cost), 0) AS spend
      FROM request_logs
      WHERE gateway_key_id = ? AND created_at >= datetime('now', 'start of day')
    `).get(gatewayKeyId) as { requests?: number; tokens?: number; spend?: number } | undefined;
    return { requests: row?.requests || 0, tokens: row?.tokens || 0, spend: row?.spend || 0 };
  },

  getSpendTodayTotal(): number {
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(cost), 0) AS spend
      FROM request_logs
      WHERE created_at >= datetime('now', 'start of day')
    `).get() as { spend?: number } | undefined;
    return row?.spend || 0;
  },

  getPoolUsageTodayAll(): Array<{ pool: string; tokens: number; spend: number; requests: number }> {
    const db = getDb();
    return db.prepare(`
      SELECT
        COALESCE(alias_name, model) AS pool,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
        COALESCE(SUM(cost), 0) AS spend,
        COUNT(*) AS requests
      FROM request_logs
      WHERE created_at >= datetime('now', 'start of day')
        AND COALESCE(alias_name, model, '') != ''
      GROUP BY COALESCE(alias_name, model)
      ORDER BY spend DESC
    `).all() as Array<{ pool: string; tokens: number; spend: number; requests: number }>;
  },

  getRecent(limit: number = 100, filters?: { status?: string; provider_id?: string; model?: string; endpoint?: string }): RequestLogRecord[] {
    const db = getDb();
    let query = `SELECT * FROM request_logs WHERE 1=1`;
    const params: Array<string | number> = [];

    if (filters?.status) {
      query += ` AND status = ?`;
      params.push(filters.status);
    }
    if (filters?.provider_id) {
      query += ` AND provider_id = ?`;
      params.push(filters.provider_id);
    }
    if (filters?.model) {
      query += ` AND model LIKE ?`;
      params.push(`%${filters.model}%`);
    }
    if (filters?.endpoint) {
      query += ` AND endpoint = ?`;
      params.push(filters.endpoint);
    }

    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(query).all(...params) as RequestLogRecord[];
  },

  // DECISION: Automatically prune logs older than 30 days to honor the 30-day retention constraint.
  purgeOldLogs(retentionDays: number = 30): number {
    const db = getDb();
    const res = db.prepare(`
      DELETE FROM request_logs 
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    return res.changes;
  },

  getStatsSummary(): {
    totalRequests: number;
    successRequests: number;
    errorRequests: number;
    avgLatencyMs: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
  } {
    const db = getDb();
    const row = db.prepare(`
      SELECT 
        COUNT(*) as totalRequests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successRequests,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errorRequests,
        AVG(latency_ms) as avgLatencyMs,
        SUM(prompt_tokens) as totalPromptTokens,
        SUM(completion_tokens) as totalCompletionTokens
      FROM request_logs
      WHERE created_at >= datetime('now', '-24 hours')
    `).get() as StatsRow | undefined;

    return {
      totalRequests: row?.totalRequests || 0,
      successRequests: row?.successRequests || 0,
      errorRequests: row?.errorRequests || 0,
      avgLatencyMs: Math.round(row?.avgLatencyMs || 0),
      totalPromptTokens: row?.totalPromptTokens || 0,
      totalCompletionTokens: row?.totalCompletionTokens || 0,
    };
  }
};

// ----------------- MODEL PRICING REPOSITORY -----------------
export const PricingRepo = {
  upsert(row: {
    id?: string;
    provider_id: string;
    model: string;
    input_per_mtok: number;
    output_per_mtok: number;
  }): string {
    const db = getDb();
    const id = row.id || crypto.randomUUID();
    const stmt = db.prepare(`
      INSERT INTO model_pricing (id, provider_id, model, input_per_mtok, output_per_mtok, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(provider_id, model) DO UPDATE SET
        input_per_mtok = excluded.input_per_mtok,
        output_per_mtok = excluded.output_per_mtok,
        updated_at = datetime('now')
    `);
    stmt.run(id, row.provider_id, row.model, row.input_per_mtok, row.output_per_mtok);
    return id;
  },

  getAll(): ModelPricingRecord[] {
    const db = getDb();
    return db.prepare(`SELECT * FROM model_pricing ORDER BY provider_id ASC, model ASC`).all() as ModelPricingRecord[];
  },

  // Resolve the most specific pricing row: exact pair, then provider wildcard,
  // then model wildcard, then the global fallback. Single indexed query per request.
  findBest(providerId: string, model: string): ModelPricingRecord | null {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM model_pricing
      WHERE (provider_id = ? AND model = ?)
         OR (provider_id = ? AND model = '*')
         OR (provider_id = '*' AND model = ?)
         OR (provider_id = '*' AND model = '*')
      ORDER BY
        CASE
          WHEN provider_id = ? AND model = ? THEN 0
          WHEN provider_id = ? AND model = '*' THEN 1
          WHEN provider_id = '*' AND model = ? THEN 2
          ELSE 3
        END
      LIMIT 1
    `).get(providerId, model, providerId, model, providerId, model, providerId, model) as
      | ModelPricingRecord
      | undefined;
    return row || null;
  },

  delete(id: string): boolean {
    const db = getDb();
    const res = db.prepare(`DELETE FROM model_pricing WHERE id = ?`).run(id);
    return res.changes > 0;
  }
};

// ----------------- STICKY ROUTE REPOSITORY -----------------
export const StickyRouteRepo = {
  record(route: {
    resource_id: string;
    pool_name: string | null;
    endpoint: string;
    provider_id: string;
    key_id: string;
  }): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO sticky_routes (resource_id, pool_name, endpoint, provider_id, key_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(resource_id) DO UPDATE SET
        pool_name = excluded.pool_name,
        endpoint = excluded.endpoint,
        provider_id = excluded.provider_id,
        key_id = excluded.key_id
    `).run(route.resource_id, route.pool_name, route.endpoint, route.provider_id, route.key_id);
  },

  get(resourceId: string): StickyRouteRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM sticky_routes WHERE resource_id = ?`).get(resourceId);
    return (row as StickyRouteRecord) || null;
  },

  // DECISION: Sticky routes expire with the same retention window as request logs; an expired
  // batch/file simply falls back to normal pool routing and may 404 upstream.
  purgeOlderThan(retentionDays: number = 30): number {
    const db = getDb();
    const res = db.prepare(`
      DELETE FROM sticky_routes WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
    return res.changes;
  }
};
