import yaml from 'yaml';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { ProviderRepo, ApiKeyRepo, ModelAliasRepo, RequestLogRepo } from '../db/index.js';
import { decryptSecret } from '../crypto.js';
import { TemplateMapper } from './mapper.js';
import { CircuitBreakerManager } from './circuit-breaker.js';
import { classifyError } from './error-classifier.js';
export class SmartRouter {
    static instance;
    roundRobinIndices = new Map();
    constructor() { }
    static getInstance() {
        if (!SmartRouter.instance) {
            SmartRouter.instance = new SmartRouter();
        }
        return SmartRouter.instance;
    }
    // Load and parse provider YAML spec
    getProviderSpec(providerId) {
        const p = ProviderRepo.getById(providerId);
        if (!p || !p.is_active)
            return null;
        try {
            return yaml.parse(p.spec_yaml);
        }
        catch {
            return null;
        }
    }
    // DECISION: Target selection supports weighted-by-health, round-robin, and priority strategies.
    sortTargets(alias, targets) {
        if (targets.length <= 1)
            return targets;
        if (alias.strategy === 'priority') {
            // Sort ascending by priority number (lowest number = highest priority)
            return [...targets].sort((a, b) => a.priority - b.priority);
        }
        if (alias.strategy === 'round-robin') {
            const idx = this.roundRobinIndices.get(alias.alias_name) || 0;
            const nextIdx = (idx + 1) % targets.length;
            this.roundRobinIndices.set(alias.alias_name, nextIdx);
            const rotated = [...targets.slice(idx), ...targets.slice(0, idx)];
            return rotated;
        }
        // Default: 'weighted-by-health'
        const cb = CircuitBreakerManager.getInstance();
        const scored = targets.map((t) => {
            const keys = ApiKeyRepo.getByProvider(t.provider_id);
            let bestKeyScore = 0;
            for (const k of keys) {
                const stats = cb.getKeyStats(k.id);
                const avail = cb.isKeyAvailable(k.id);
                if (avail.available) {
                    const successRatio = stats.rolling_success_rate / 100;
                    const latencyPenalty = Math.max(stats.latency_p50, 50);
                    const score = (t.weight || 1) * (successRatio * successRatio * 1000) / latencyPenalty;
                    if (score > bestKeyScore)
                        bestKeyScore = score;
                }
            }
            return { target: t, score: bestKeyScore };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.map((s) => s.target);
    }
    // Select healthy keys for a provider ordered by health score
    getCandidateKeys(providerId) {
        const keys = ApiKeyRepo.getByProvider(providerId);
        const cb = CircuitBreakerManager.getInstance();
        const healthy = [];
        for (const key of keys) {
            const availability = cb.isKeyAvailable(key.id);
            if (availability.available) {
                const stats = cb.getKeyStats(key.id);
                const successRatio = stats.rolling_success_rate / 100;
                const latencyPenalty = Math.max(stats.latency_p50, 50);
                const score = (successRatio * successRatio * 1000) / latencyPenalty;
                healthy.push({ key, score, isProbe: availability.isProbe });
            }
        }
        healthy.sort((a, b) => b.score - a.score);
        return healthy.map((h) => ({ key: h.key, isProbe: h.isProbe }));
    }
    // Dispatch a single request attempt to an upstream provider key
    async executeAttempt(spec, keyRecord, targetModel, req, timeoutMs, isHedged = false) {
        const decryptedKey = decryptSecret(keyRecord.encrypted_key, keyRecord.iv, keyRecord.tag);
        const prepared = await TemplateMapper.mapRequest(spec, req, decryptedKey, targetModel);
        const controller = new AbortController();
        const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);
        const startTime = Date.now();
        let upstreamRes;
        try {
            upstreamRes = await fetch(prepared.url, {
                method: prepared.method,
                headers: prepared.headers,
                body: prepared.body,
                signal: controller.signal,
            });
        }
        catch (err) {
            clearTimeout(timeoutTimer);
            const latencyMs = Date.now() - startTime;
            const isTimeout = err.name === 'AbortError';
            const classified = classifyError(isTimeout ? 504 : 500, {}, { message: err.message || (isTimeout ? 'Upstream request timed out' : 'Network error') }, spec.error_classification);
            throw {
                classified,
                latencyMs,
                statusCode: isTimeout ? 504 : 500,
            };
        }
        finally {
            clearTimeout(timeoutTimer);
        }
        const latencyMs = Date.now() - startTime;
        const statusCode = upstreamRes.status;
        // Handle HTTP error responses
        if (!upstreamRes.ok) {
            let rawErrorBody = null;
            try {
                const text = await upstreamRes.text();
                try {
                    rawErrorBody = JSON.parse(text);
                }
                catch {
                    rawErrorBody = text;
                }
            }
            catch {
                rawErrorBody = null;
            }
            // Extract response headers as record
            const respHeaders = {};
            upstreamRes.headers.forEach((val, k) => {
                respHeaders[k] = val;
            });
            const classified = classifyError(statusCode, respHeaders, rawErrorBody, spec.error_classification, spec.rate_limit_headers);
            throw {
                classified,
                latencyMs,
                statusCode,
                rawBody: rawErrorBody,
            };
        }
        // Success response: streaming or non-streaming
        if (prepared.stream) {
            return {
                streamResponse: upstreamRes,
                latencyMs,
                statusCode,
                promptTokens: 0,
                completionTokens: 0,
            };
        }
        const rawJson = await upstreamRes.json();
        const mappedResponse = await TemplateMapper.mapResponse(spec, rawJson, req.model);
        const promptTokens = mappedResponse.usage?.prompt_tokens || 0;
        const completionTokens = mappedResponse.usage?.completion_tokens || 0;
        return {
            response: mappedResponse,
            latencyMs,
            statusCode,
            promptTokens,
            completionTokens,
        };
    }
    // Execute chat completion with intelligent failover and optional hedged request
    async routeChatCompletion(aliasName, req, traceId = crypto.randomUUID(), gatewayKeyId) {
        const alias = ModelAliasRepo.getByName(aliasName);
        let targets = [];
        if (alias) {
            try {
                targets = JSON.parse(alias.targets_json);
            }
            catch {
                targets = [];
            }
        }
        // Fallback: If alias not found, try matching aliasName directly as a provider ID
        if (targets.length === 0) {
            const directProvider = ProviderRepo.getById(aliasName);
            if (directProvider) {
                targets = [{ provider_id: directProvider.id, model: req.model, weight: 1, priority: 1 }];
            }
            else {
                // Or find first active provider
                const allProviders = ProviderRepo.getAll().filter((p) => p.is_active);
                if (allProviders.length > 0) {
                    targets = [{ provider_id: allProviders[0].id, model: req.model, weight: 1, priority: 1 }];
                }
            }
        }
        if (targets.length === 0) {
            throw new Error(`No active provider targets configured for model alias '${aliasName}'.`);
        }
        const sortedTargets = alias ? this.sortTargets(alias, targets) : targets;
        const timeoutMs = alias?.timeout_ms || CONFIG.defaultTimeoutMs;
        const cb = CircuitBreakerManager.getInstance();
        let lastError = null;
        // Failover loop: iterate over targets, then candidate keys
        for (const target of sortedTargets) {
            const spec = this.getProviderSpec(target.provider_id);
            if (!spec)
                continue;
            const candidateKeys = this.getCandidateKeys(target.provider_id);
            if (candidateKeys.length === 0)
                continue;
            for (const { key } of candidateKeys) {
                // DECISION: Implement hedged requests if enabled for this alias. If primary does not return before hedged_delay_ms, launch speculative request.
                if (alias?.hedging_enabled && !req.stream && candidateKeys.length > 1) {
                    const secondaryKey = candidateKeys.find((k) => k.key.id !== key.id)?.key;
                    if (secondaryKey) {
                        try {
                            return await this.executeHedgedAttempt(spec, key, secondaryKey, target.model, req, timeoutMs, alias.hedged_delay_ms || 500, traceId, gatewayKeyId, aliasName);
                        }
                        catch (hedgeErr) {
                            lastError = hedgeErr;
                            continue;
                        }
                    }
                }
                try {
                    const attempt = await this.executeAttempt(spec, key, target.model, req, timeoutMs, false);
                    // Success: record in circuit breaker and logs
                    cb.recordCallResult(key.id, true, attempt.latencyMs, attempt.promptTokens, attempt.completionTokens);
                    RequestLogRepo.insert({
                        id: crypto.randomUUID(),
                        trace_id: traceId,
                        gateway_key_id: gatewayKeyId || null,
                        alias_name: aliasName,
                        provider_id: target.provider_id,
                        key_id: key.id,
                        model: target.model,
                        status: 'success',
                        status_code: attempt.statusCode,
                        error_type: null,
                        latency_ms: attempt.latencyMs,
                        prompt_tokens: attempt.promptTokens,
                        completion_tokens: attempt.completionTokens,
                        is_stream: req.stream ? 1 : 0,
                        is_hedged: 0,
                        request_snippet: JSON.stringify(req.messages?.slice(-1)),
                        response_snippet: typeof attempt.response?.choices?.[0]?.message?.content === 'string'
                            ? attempt.response.choices[0].message.content.slice(0, 300)
                            : attempt.response?.choices?.[0]?.message?.content ? JSON.stringify(attempt.response.choices[0].message.content).slice(0, 300) : null,
                        created_at: new Date().toISOString(),
                    });
                    return {
                        ...attempt,
                        providerId: target.provider_id,
                        keyId: key.id,
                        model: target.model,
                        isStream: Boolean(req.stream),
                        isHedged: false,
                        spec,
                    };
                }
                catch (err) {
                    const classified = err.classified || {
                        errorType: 'fatal',
                        statusCode: 500,
                        message: err.message || 'Unknown routing error',
                    };
                    cb.recordCallResult(key.id, false, err.latencyMs || 0, 0, 0, classified.errorType, classified.message, classified.retryAfterMs);
                    RequestLogRepo.insert({
                        id: crypto.randomUUID(),
                        trace_id: traceId,
                        gateway_key_id: gatewayKeyId || null,
                        alias_name: aliasName,
                        provider_id: target.provider_id,
                        key_id: key.id,
                        model: target.model,
                        status: 'error',
                        status_code: err.statusCode || 500,
                        error_type: classified.errorType,
                        latency_ms: err.latencyMs || 0,
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        is_stream: req.stream ? 1 : 0,
                        is_hedged: 0,
                        request_snippet: JSON.stringify(req.messages?.slice(-1)),
                        response_snippet: classified.message,
                        created_at: new Date().toISOString(),
                    });
                    lastError = err;
                    // DECISION: If error is retryable, rate_limit, or auth_fail, failover immediately to next key/target.
                    if (['retryable', 'rate_limit', 'auth_fail', 'quota_exhausted'].includes(classified.errorType)) {
                        continue; // Proceed to next key or target
                    }
                    else {
                        // Fatal error: abort chain unless other targets exist
                        continue;
                    }
                }
            }
        }
        throw lastError || new Error(`All provider targets and keys failed for alias '${aliasName}'.`);
    }
    // Hedged execution: races primary request against speculative delayed backup
    async executeHedgedAttempt(spec, primaryKey, secondaryKey, model, req, timeoutMs, hedgeDelayMs, traceId, gatewayKeyId, aliasName) {
        const cb = CircuitBreakerManager.getInstance();
        return new Promise((resolve, reject) => {
            let resolved = false;
            let primaryFinished = false;
            const finish = (result) => {
                if (!resolved) {
                    resolved = true;
                    resolve(result);
                }
            };
            // Launch primary
            this.executeAttempt(spec, primaryKey, model, req, timeoutMs, false)
                .then((res) => {
                primaryFinished = true;
                cb.recordCallResult(primaryKey.id, true, res.latencyMs, res.promptTokens, res.completionTokens);
                finish({
                    ...res,
                    providerId: spec.id,
                    keyId: primaryKey.id,
                    model,
                    isStream: false,
                    isHedged: false,
                    spec,
                });
            })
                .catch((err) => {
                primaryFinished = true;
                if (!resolved) {
                    // If primary fails quickly before hedge fires, hedge will still run or we reject
                }
            });
            // Launch speculative hedged request after delay
            setTimeout(() => {
                if (primaryFinished || resolved)
                    return;
                this.executeAttempt(spec, secondaryKey, model, req, timeoutMs, true)
                    .then((res) => {
                    cb.recordCallResult(secondaryKey.id, true, res.latencyMs, res.promptTokens, res.completionTokens);
                    finish({
                        ...res,
                        providerId: spec.id,
                        keyId: secondaryKey.id,
                        model,
                        isStream: false,
                        isHedged: true,
                        spec,
                    });
                })
                    .catch((err) => {
                    if (!resolved && primaryFinished) {
                        reject(err);
                    }
                });
            }, hedgeDelayMs);
        });
    }
}
