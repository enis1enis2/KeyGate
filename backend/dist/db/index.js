import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config.js';
import { SCHEMA_SQL } from './schema.js';
let dbInstance = null;
export function getDb() {
    if (dbInstance)
        return dbInstance;
    // DECISION: Automatically ensure the directory for SQLite exists before instantiating better-sqlite3.
    const dir = path.dirname(CONFIG.dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    dbInstance = new Database(CONFIG.dbPath);
    dbInstance.exec(SCHEMA_SQL);
    return dbInstance;
}
export function closeDb() {
    if (dbInstance) {
        dbInstance.close();
        dbInstance = null;
    }
}
// ----------------- PROVIDER REPOSITORY -----------------
export const ProviderRepo = {
    create(provider) {
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
    getAll() {
        const db = getDb();
        return db.prepare(`SELECT * FROM providers ORDER BY name ASC`).all();
    },
    getById(id) {
        const db = getDb();
        const row = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(id);
        return row || null;
    },
    delete(id) {
        const db = getDb();
        const res = db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
        return res.changes > 0;
    },
    toggleActive(id, isActive) {
        const db = getDb();
        db.prepare(`UPDATE providers SET is_active = ?, updated_at = datetime('now') WHERE id = ?`).run(isActive ? 1 : 0, id);
    }
};
// ----------------- API KEY REPOSITORY -----------------
export const ApiKeyRepo = {
    create(key) {
        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO api_keys (
        id, provider_id, key_name, encrypted_key, iv, tag, key_prefix, key_suffix,
        rpm_cap, tpm_cap, daily_budget_cap, is_active, circuit_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'CLOSED', datetime('now'))
    `);
        stmt.run(key.id, key.provider_id, key.key_name, key.encrypted_key, key.iv, key.tag, key.key_prefix, key.key_suffix, key.rpm_cap || 0, key.tpm_cap || 0, key.daily_budget_cap || 0);
    },
    getAll() {
        const db = getDb();
        return db.prepare(`SELECT * FROM api_keys ORDER BY created_at DESC`).all();
    },
    getByProvider(providerId) {
        const db = getDb();
        return db.prepare(`SELECT * FROM api_keys WHERE provider_id = ? ORDER BY created_at DESC`).all(providerId);
    },
    getById(id) {
        const db = getDb();
        const row = db.prepare(`SELECT * FROM api_keys WHERE id = ?`).get(id);
        return row || null;
    },
    updateCircuitState(id, state, cooldownUntil, consecutiveFailures, lastError, disabledReason) {
        const db = getDb();
        db.prepare(`
      UPDATE api_keys 
      SET circuit_state = ?, cooldown_until = ?, consecutive_failures = ?, 
          last_error = coalesce(?, last_error), disabled_reason = coalesce(?, disabled_reason),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(state, cooldownUntil, consecutiveFailures, lastError || null, disabledReason || null, id);
    },
    toggleActive(id, isActive, disabledReason) {
        const db = getDb();
        db.prepare(`
      UPDATE api_keys 
      SET is_active = ?, disabled_reason = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(isActive ? 1 : 0, disabledReason || null, id);
    },
    updateCaps(id, rpm_cap, tpm_cap, daily_budget_cap) {
        const db = getDb();
        db.prepare(`
      UPDATE api_keys 
      SET rpm_cap = ?, tpm_cap = ?, daily_budget_cap = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(rpm_cap, tpm_cap, daily_budget_cap, id);
    },
    delete(id) {
        const db = getDb();
        const res = db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
        return res.changes > 0;
    }
};
// ----------------- MODEL ALIAS REPOSITORY -----------------
export const ModelAliasRepo = {
    upsert(alias) {
        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO model_aliases (
        id, alias_name, strategy, targets_json, hedging_enabled, hedged_delay_ms, timeout_ms, is_active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(alias_name) DO UPDATE SET
        strategy = excluded.strategy,
        targets_json = excluded.targets_json,
        hedging_enabled = excluded.hedging_enabled,
        hedged_delay_ms = excluded.hedged_delay_ms,
        timeout_ms = excluded.timeout_ms,
        is_active = excluded.is_active,
        updated_at = datetime('now')
    `);
        stmt.run(alias.id, alias.alias_name, alias.strategy, alias.targets_json, alias.hedging_enabled ? 1 : 0, alias.hedged_delay_ms || 500, alias.timeout_ms || 30000, alias.is_active !== false ? 1 : 0);
    },
    getAll() {
        const db = getDb();
        return db.prepare(`SELECT * FROM model_aliases ORDER BY alias_name ASC`).all();
    },
    getByName(name) {
        const db = getDb();
        const row = db.prepare(`SELECT * FROM model_aliases WHERE alias_name = ? AND is_active = 1`).get(name);
        return row || null;
    },
    getById(id) {
        const db = getDb();
        const row = db.prepare(`SELECT * FROM model_aliases WHERE id = ?`).get(id);
        return row || null;
    },
    delete(id) {
        const db = getDb();
        const res = db.prepare(`DELETE FROM model_aliases WHERE id = ?`).run(id);
        return res.changes > 0;
    }
};
// ----------------- GATEWAY KEY REPOSITORY -----------------
export const GatewayKeyRepo = {
    create(key) {
        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO gateway_keys (
        id, name, token_hash, token_prefix, token_suffix, is_active,
        rpm_limit, tpm_limit, allowed_aliases_json, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
    `);
        stmt.run(key.id, key.name, key.token_hash, key.token_prefix, key.token_suffix, key.rpm_limit || 0, key.tpm_limit || 0, key.allowed_aliases_json || '["*"]', key.expires_at || null);
    },
    getAll() {
        const db = getDb();
        return db.prepare(`SELECT * FROM gateway_keys ORDER BY created_at DESC`).all();
    },
    getByHash(hash) {
        const db = getDb();
        const row = db.prepare(`SELECT * FROM gateway_keys WHERE token_hash = ? AND is_active = 1`).get(hash);
        return row || null;
    },
    revoke(id) {
        const db = getDb();
        const res = db.prepare(`UPDATE gateway_keys SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
        return res.changes > 0;
    },
    delete(id) {
        const db = getDb();
        const res = db.prepare(`DELETE FROM gateway_keys WHERE id = ?`).run(id);
        return res.changes > 0;
    }
};
// ----------------- REQUEST LOGS REPOSITORY -----------------
export const RequestLogRepo = {
    insert(log) {
        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO request_logs (
        id, trace_id, gateway_key_id, alias_name, provider_id, key_id, model,
        status, status_code, error_type, latency_ms, prompt_tokens, completion_tokens,
        is_stream, is_hedged, request_snippet, response_snippet
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(log.id, log.trace_id, log.gateway_key_id || null, log.alias_name || null, log.provider_id, log.key_id, log.model, log.status, log.status_code, log.error_type || null, log.latency_ms, log.prompt_tokens, log.completion_tokens, log.is_stream, log.is_hedged, log.request_snippet || null, log.response_snippet || null);
    },
    getRecent(limit = 100, filters) {
        const db = getDb();
        let query = `SELECT * FROM request_logs WHERE 1=1`;
        const params = [];
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
        query += ` ORDER BY created_at DESC LIMIT ?`;
        params.push(limit);
        return db.prepare(query).all(...params);
    },
    // DECISION: Automatically prune logs older than 30 days to honor the 30-day retention constraint.
    purgeOldLogs(retentionDays = 30) {
        const db = getDb();
        const res = db.prepare(`
      DELETE FROM request_logs 
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(retentionDays);
        return res.changes;
    },
    getStatsSummary() {
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
    `).get();
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
