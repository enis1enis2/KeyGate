import Database from 'better-sqlite3';
import type { ApiKeyRecord, ModelAliasRecord, GatewayKeyRecord, RequestLogRecord } from '../types/index.js';
export declare function getDb(): Database.Database;
export declare function closeDb(): void;
export declare const ProviderRepo: {
    create(provider: {
        id: string;
        name: string;
        description?: string;
        preset?: string;
        spec_yaml: string;
    }): void;
    getAll(): Array<{
        id: string;
        name: string;
        description: string | null;
        preset: string;
        spec_yaml: string;
        is_active: number;
    }>;
    getById(id: string): {
        id: string;
        name: string;
        description: string | null;
        preset: string;
        spec_yaml: string;
        is_active: number;
    } | null;
    delete(id: string): boolean;
    toggleActive(id: string, isActive: boolean): void;
};
export declare const ApiKeyRepo: {
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
    }): void;
    getAll(): ApiKeyRecord[];
    getByProvider(providerId: string): ApiKeyRecord[];
    getById(id: string): ApiKeyRecord | null;
    updateCircuitState(id: string, state: string, cooldownUntil: number, consecutiveFailures: number, lastError?: string, disabledReason?: string): void;
    toggleActive(id: string, isActive: boolean, disabledReason?: string): void;
    updateCaps(id: string, rpm_cap: number, tpm_cap: number, daily_budget_cap: number): void;
    delete(id: string): boolean;
};
export declare const ModelAliasRepo: {
    upsert(alias: {
        id: string;
        alias_name: string;
        strategy: string;
        targets_json: string;
        hedging_enabled?: boolean;
        hedged_delay_ms?: number;
        timeout_ms?: number;
        is_active?: boolean;
    }): void;
    getAll(): ModelAliasRecord[];
    getByName(name: string): ModelAliasRecord | null;
    getById(id: string): ModelAliasRecord | null;
    delete(id: string): boolean;
};
export declare const GatewayKeyRepo: {
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
    }): void;
    getAll(): GatewayKeyRecord[];
    getByHash(hash: string): GatewayKeyRecord | null;
    revoke(id: string): boolean;
    delete(id: string): boolean;
};
export declare const RequestLogRepo: {
    insert(log: RequestLogRecord): void;
    getRecent(limit?: number, filters?: {
        status?: string;
        provider_id?: string;
        model?: string;
    }): RequestLogRecord[];
    purgeOldLogs(retentionDays?: number): number;
    getStatsSummary(): {
        totalRequests: number;
        successRequests: number;
        errorRequests: number;
        avgLatencyMs: number;
        totalPromptTokens: number;
        totalCompletionTokens: number;
    };
};
