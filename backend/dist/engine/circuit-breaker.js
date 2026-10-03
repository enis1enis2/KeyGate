import { CONFIG } from '../config.js';
import { ApiKeyRepo } from '../db/index.js';
export class CircuitBreakerManager {
    static instance;
    // In-memory sliding window of last 100 calls per key ID
    callHistory = new Map();
    // Minute bucket usage for RPM / TPM tracking
    minuteTokens = new Map();
    // Half open probe lock
    halfOpenProbingKeys = new Set();
    constructor() { }
    static getInstance() {
        if (!CircuitBreakerManager.instance) {
            CircuitBreakerManager.instance = new CircuitBreakerManager();
        }
        return CircuitBreakerManager.instance;
    }
    // DECISION: In-memory sliding window provides sub-millisecond metric lookups and latency calculations without hammering SQLite.
    getHistory(keyId) {
        let history = this.callHistory.get(keyId);
        if (!history) {
            history = [];
            this.callHistory.set(keyId, history);
        }
        return history;
    }
    recordCallResult(keyId, success, latencyMs, promptTokens = 0, completionTokens = 0, errorType, errorMessage, retryAfterMs) {
        const history = this.getHistory(keyId);
        history.push({
            timestamp: Date.now(),
            success,
            latencyMs,
            promptTokens,
            completionTokens,
        });
        // Retain only the last 100 calls in the rolling window
        if (history.length > 100) {
            history.shift();
        }
        // Update minute RPM / TPM
        const now = Date.now();
        const currentMinute = Math.floor(now / 60000);
        let minBucket = this.minuteTokens.get(keyId);
        if (!minBucket || minBucket.minute !== currentMinute) {
            minBucket = { minute: currentMinute, tokens: 0, requests: 0 };
            this.minuteTokens.set(keyId, minBucket);
        }
        minBucket.requests += 1;
        minBucket.tokens += (promptTokens + completionTokens);
        const key = ApiKeyRepo.getById(keyId);
        if (!key)
            return;
        // Release half-open probe lock
        this.halfOpenProbingKeys.delete(keyId);
        if (success) {
            // Successful call: reset consecutive failures, transition HALF_OPEN -> CLOSED
            const newState = 'CLOSED';
            ApiKeyRepo.updateCircuitState(keyId, newState, 0, 0, undefined, undefined);
        }
        else {
            // Failed call
            const consecutiveFailures = key.consecutive_failures + 1;
            let newState = key.circuit_state;
            let cooldownUntil = key.cooldown_until;
            let disabledReason = undefined;
            // DECISION: Auth failure immediately disables the key pending human review to avoid repeated unauthorized requests.
            if (errorType === 'auth_fail') {
                ApiKeyRepo.toggleActive(keyId, false, 'auth_failed_pending_review');
                ApiKeyRepo.updateCircuitState(keyId, 'OPEN', 0, consecutiveFailures, errorMessage, 'auth_failed_pending_review');
                return;
            }
            // DECISION: Quota exhaustion trips a long cooldown (24h or spec) rather than rapid retries.
            if (errorType === 'quota_exhausted') {
                const cooldown = CONFIG.circuitBreaker.quotaCooldownMs;
                cooldownUntil = now + cooldown;
                newState = 'OPEN';
                ApiKeyRepo.updateCircuitState(keyId, newState, cooldownUntil, consecutiveFailures, errorMessage, 'quota_exhausted_cooling_down');
                return;
            }
            // Rate limit or retryable error: calculate exponential backoff cooldown or honor Retry-After
            const exponentialBackoff = Math.min(CONFIG.circuitBreaker.maxCooldownMs, CONFIG.circuitBreaker.baseCooldownMs * Math.pow(2, Math.max(0, consecutiveFailures - 1)));
            const effectiveCooldown = retryAfterMs ? Math.max(retryAfterMs, exponentialBackoff) : exponentialBackoff;
            // Check if threshold breached
            const stats = this.getKeyStats(keyId);
            const isThresholdBreached = consecutiveFailures >= CONFIG.circuitBreaker.failureThreshold ||
                (stats.total_calls_window >= 10 && stats.rolling_success_rate < (CONFIG.circuitBreaker.successRateThreshold * 100));
            if (isThresholdBreached || errorType === 'rate_limit') {
                newState = 'OPEN';
                cooldownUntil = now + effectiveCooldown;
            }
            ApiKeyRepo.updateCircuitState(keyId, newState, cooldownUntil, consecutiveFailures, errorMessage);
        }
    }
    // DECISION: Check whether a key is healthy and available for routing, handling HALF_OPEN single-probe transition.
    isKeyAvailable(keyId) {
        const key = ApiKeyRepo.getById(keyId);
        if (!key)
            return { available: false, reason: 'key_not_found' };
        if (!key.is_active)
            return { available: false, reason: key.disabled_reason || 'key_disabled' };
        // Check RPM cap
        const now = Date.now();
        const currentMinute = Math.floor(now / 60000);
        const minBucket = this.minuteTokens.get(keyId);
        if (minBucket && minBucket.minute === currentMinute) {
            if (key.rpm_cap > 0 && minBucket.requests >= key.rpm_cap) {
                return { available: false, reason: 'rpm_cap_exceeded' };
            }
            if (key.tpm_cap > 0 && minBucket.tokens >= key.tpm_cap) {
                return { available: false, reason: 'tpm_cap_exceeded' };
            }
        }
        // Check circuit breaker state
        if (key.circuit_state === 'OPEN') {
            if (now >= key.cooldown_until) {
                // Cooldown expired: allow a single half-open probe
                if (!this.halfOpenProbingKeys.has(keyId)) {
                    this.halfOpenProbingKeys.add(keyId);
                    ApiKeyRepo.updateCircuitState(keyId, 'HALF_OPEN', 0, key.consecutive_failures);
                    return { available: true, isProbe: true };
                }
                return { available: false, reason: 'probe_already_in_flight' };
            }
            const remainingSeconds = Math.ceil((key.cooldown_until - now) / 1000);
            return { available: false, reason: `circuit_open_cooling_down (${remainingSeconds}s remaining)` };
        }
        if (key.circuit_state === 'HALF_OPEN') {
            if (this.halfOpenProbingKeys.has(keyId)) {
                return { available: false, reason: 'probe_already_in_flight' };
            }
            this.halfOpenProbingKeys.add(keyId);
            return { available: true, isProbe: true };
        }
        return { available: true };
    }
    // DECISION: Compute rolling percentile latencies (p50, p95) using nearest-rank algorithm over sliding window.
    getKeyStats(keyId) {
        const key = ApiKeyRepo.getById(keyId);
        const history = this.getHistory(keyId);
        const now = Date.now();
        const currentMinute = Math.floor(now / 60000);
        const minBucket = this.minuteTokens.get(keyId);
        const currentRpm = (minBucket && minBucket.minute === currentMinute) ? minBucket.requests : 0;
        const currentTpm = (minBucket && minBucket.minute === currentMinute) ? minBucket.tokens : 0;
        if (history.length === 0) {
            return {
                key_id: keyId,
                provider_id: key?.provider_id || '',
                key_name: key?.key_name || '',
                key_prefix: key?.key_prefix || '',
                key_suffix: key?.key_suffix || '',
                is_active: key ? Boolean(key.is_active) : false,
                circuit_state: key?.circuit_state || 'CLOSED',
                cooldown_until: key?.cooldown_until || 0,
                consecutive_failures: key?.consecutive_failures || 0,
                disabled_reason: key?.disabled_reason || null,
                last_error: key?.last_error || null,
                rolling_success_rate: 100,
                latency_p50: 0,
                latency_p95: 0,
                total_calls_window: 0,
                rpm_cap: key?.rpm_cap || 0,
                current_rpm: currentRpm,
                tpm_cap: key?.tpm_cap || 0,
                current_tpm: currentTpm,
            };
        }
        const successfulCalls = history.filter((c) => c.success);
        const rolling_success_rate = Math.round((successfulCalls.length / history.length) * 100);
        const latencies = history.map((c) => c.latencyMs).sort((a, b) => a - b);
        const p50Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.5));
        const p95Index = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
        return {
            key_id: keyId,
            provider_id: key?.provider_id || '',
            key_name: key?.key_name || '',
            key_prefix: key?.key_prefix || '',
            key_suffix: key?.key_suffix || '',
            is_active: key ? Boolean(key.is_active) : false,
            circuit_state: key?.circuit_state || 'CLOSED',
            cooldown_until: key?.cooldown_until || 0,
            consecutive_failures: key?.consecutive_failures || 0,
            disabled_reason: key?.disabled_reason || null,
            last_error: key?.last_error || null,
            rolling_success_rate,
            latency_p50: latencies[p50Index] || 0,
            latency_p95: latencies[p95Index] || 0,
            total_calls_window: history.length,
            rpm_cap: key?.rpm_cap || 0,
            current_rpm: currentRpm,
            tpm_cap: key?.tpm_cap || 0,
            current_tpm: currentTpm,
        };
    }
    resetCircuit(keyId) {
        this.halfOpenProbingKeys.delete(keyId);
        ApiKeyRepo.updateCircuitState(keyId, 'CLOSED', 0, 0, undefined, undefined);
    }
}
