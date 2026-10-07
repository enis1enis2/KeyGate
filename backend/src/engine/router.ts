import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { ApiKeyRepo, RequestLogRepo } from '../db/index.js';
import { decryptSecret } from '../crypto.js';
import { TemplateMapper } from './mapper.js';
import { CircuitBreakerManager } from './circuit-breaker.js';
import { classifyError, type ClassifiedError } from './error-classifier.js';
import { computeCost } from './pricing.js';
import { toErrorInfo } from '../errors.js';
import { quotaRejections } from '../metrics.js';
import {
  assertPoolBudget,
  loadProviderSpec,
  providerHealthScore,
  resolveTargets,
  selectCandidateKeys,
  sortTargets,
} from './targeting.js';
import type { 
  ProviderSpec, 
  ApiKeyRecord, 
  TargetConfig,
  ModelAliasRecord, 
  OpenAIChatRequest, 
  OpenAIChatResponse
} from '../types/index.js';

export interface RouteAttemptResult {
  response?: OpenAIChatResponse;
  streamResponse?: Response; // For streaming passthrough
  providerId: string;
  keyId: string;
  model: string;
  latencyMs: number;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  isStream: boolean;
  isHedged: boolean;
  spec: ProviderSpec;
}

export class SmartRouter {
  private static instance: SmartRouter;

  private constructor() {}

  public static getInstance(): SmartRouter {
    if (!SmartRouter.instance) {
      SmartRouter.instance = new SmartRouter();
    }
    return SmartRouter.instance;
  }

  // Load and parse provider YAML spec
  public getProviderSpec(providerId: string): ProviderSpec | null {
    return loadProviderSpec(providerId);
  }

  // DECISION: Target selection supports weighted-by-health, round-robin, and priority strategies.
  // Shared with engine/proxy.ts via engine/targeting.ts.
  public sortTargets(alias: ModelAliasRecord, targets: TargetConfig[]): TargetConfig[] {
    return sortTargets(alias, targets, providerHealthScore);
  }

  // Select healthy keys for a provider ordered by health score.
  // Keys whose daily budget is already exhausted are excluded so they can never be dispatched to.
  public getCandidateKeys(providerId: string): { key: ApiKeyRecord; isProbe?: boolean }[] {
    return selectCandidateKeys(providerId).available;
  }

  // Dispatch a single request attempt to an upstream provider key
  private async executeAttempt(
    spec: ProviderSpec,
    keyRecord: ApiKeyRecord,
    targetModel: string,
    req: OpenAIChatRequest,
    timeoutMs: number,
    _isHedged: boolean = false
  ): Promise<{ response?: OpenAIChatResponse; streamResponse?: Response; latencyMs: number; statusCode: number; promptTokens: number; completionTokens: number }> {
    const decryptedKey = decryptSecret(keyRecord.encrypted_key, keyRecord.iv, keyRecord.tag);
    const prepared = await TemplateMapper.mapRequest(spec, req, decryptedKey, targetModel);

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = Date.now();
    let upstreamRes: Response;

    try {
      upstreamRes = await fetch(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutTimer);
      const latencyMs = Date.now() - startTime;
      const info = toErrorInfo(err);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const classified = classifyError(
        isTimeout ? 504 : 500,
        {},
        { message: info.message || (isTimeout ? 'Upstream request timed out' : 'Network error') },
        spec.error_classification
      );
      throw {
        classified,
        latencyMs,
        statusCode: isTimeout ? 504 : 500,
      };
    } finally {
      clearTimeout(timeoutTimer);
    }

    const latencyMs = Date.now() - startTime;
    const statusCode = upstreamRes.status;

    // Handle HTTP error responses
    if (!upstreamRes.ok) {
      let rawErrorBody: unknown = null;
      try {
        const text = await upstreamRes.text();
        try {
          rawErrorBody = JSON.parse(text);
        } catch {
          rawErrorBody = text;
        }
      } catch {
        rawErrorBody = null;
      }

      // Extract response headers as record
      const respHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((val, k) => {
        respHeaders[k] = val;
      });

      const classified = classifyError(
        statusCode,
        respHeaders,
        rawErrorBody,
        spec.error_classification,
        spec.rate_limit_headers
      );

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
  public async routeChatCompletion(
    aliasName: string,
    req: OpenAIChatRequest,
    traceId: string = crypto.randomUUID(),
    gatewayKeyId?: string,
    endpoint: string = 'chat'
  ): Promise<RouteAttemptResult> {
    // Pool resolution + health/ranking logic shared with engine/proxy.ts (engine/targeting.ts).
    const resolved = resolveTargets(aliasName, req.model, 'chat');
    const { alias, targets } = resolved;

    if (alias) {
      assertPoolBudget(alias);
    }

    if (targets.length === 0) {
      throw new Error(`No active provider targets configured for model alias '${aliasName}'.`);
    }

    const sortedTargets = alias ? sortTargets(alias, targets, providerHealthScore) : targets;
    const timeoutMs = alias?.timeout_ms || CONFIG.defaultTimeoutMs;
    const cb = CircuitBreakerManager.getInstance();

    let lastError: unknown = null;
    let budgetBlockedCount = 0;

    // Failover loop: iterate over targets, then candidate keys
    for (const target of sortedTargets) {
      const spec = this.getProviderSpec(target.provider_id);
      if (!spec) continue;

      const selection = selectCandidateKeys(target.provider_id);
      budgetBlockedCount += selection.budgetBlocked;
      const candidateKeys = selection.available;
      if (candidateKeys.length === 0) continue;

      for (const { key } of candidateKeys) {
        // DECISION: Implement hedged requests if enabled for this alias. If primary does not return before hedged_delay_ms, launch speculative request.
        if (alias?.hedging_enabled && !req.stream && candidateKeys.length > 1) {
          const secondaryKey = candidateKeys.find((k) => k.key.id !== key.id)?.key;
          if (secondaryKey) {
            try {
              return await this.executeHedgedAttempt(
                spec,
                key,
                secondaryKey,
                target.model,
                req,
                timeoutMs,
                alias.hedged_delay_ms || 500,
                traceId,
                gatewayKeyId,
                aliasName
              );
            } catch (hedgeErr) {
              lastError = hedgeErr;
              continue;
            }
          }
        }

        try {
          const attempt = await this.executeAttempt(spec, key, target.model, req, timeoutMs, false);

          // Success: record in circuit breaker and logs
          cb.recordCallResult(
            key.id,
            true,
            attempt.latencyMs,
            attempt.promptTokens,
            attempt.completionTokens
          );

          const cost = computeCost(
            target.provider_id,
            target.model,
            attempt.promptTokens,
            attempt.completionTokens
          );
          ApiKeyRepo.addDailyUsage(key.id, cost);

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
            endpoint,
            cost,
            pool_name: aliasName,
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
        } catch (err) {
          const info = toErrorInfo(err);
          const classified: ClassifiedError = info.classified ?? {
            errorType: 'fatal',
            statusCode: 500,
            message: info.message || 'Unknown routing error',
          };

          cb.recordCallResult(
            key.id,
            false,
            info.latencyMs || 0,
            0,
            0,
            classified.errorType,
            classified.message,
            classified.retryAfterMs
          );

          RequestLogRepo.insert({
            id: crypto.randomUUID(),
            trace_id: traceId,
            gateway_key_id: gatewayKeyId || null,
            alias_name: aliasName,
            provider_id: target.provider_id,
            key_id: key.id,
            model: target.model,
            status: 'error',
            status_code: info.statusCode || 500,
            error_type: classified.errorType,
            latency_ms: info.latencyMs || 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            is_stream: req.stream ? 1 : 0,
            is_hedged: 0,
            request_snippet: JSON.stringify(req.messages?.slice(-1)),
            response_snippet: classified.message,
            endpoint,
            cost: 0,
            pool_name: aliasName,
            created_at: new Date().toISOString(),
          });

          lastError = err;

          // DECISION: If error is retryable, rate_limit, or auth_fail, failover immediately to next key/target.
          if (['retryable', 'rate_limit', 'auth_fail', 'quota_exhausted'].includes(classified.errorType)) {
            continue; // Proceed to next key or target
          } else {
            // Fatal error: abort chain unless other targets exist
            continue;
          }
        }
      }
    }

    // If nothing was dispatched only because every key is over its daily budget, surface that
    // as a quota failure rather than a generic "all targets failed".
    if (!lastError && budgetBlockedCount > 0) {
      quotaRejections.inc({ scope: 'key_budget_cap' });
      throw {
        classified: {
          errorType: 'quota_exhausted',
          statusCode: 429,
          message: `Daily budget exhausted for every upstream key behind model '${aliasName}'. Resets at the next UTC midnight.`,
        },
        statusCode: 429,
        latencyMs: 0,
      };
    }

    throw lastError || new Error(`All provider targets and keys failed for alias '${aliasName}'.`);
  }

  // Hedged execution: races primary request against speculative delayed backup
  private async executeHedgedAttempt(
    spec: ProviderSpec,
    primaryKey: ApiKeyRecord,
    secondaryKey: ApiKeyRecord,
    model: string,
    req: OpenAIChatRequest,
    timeoutMs: number,
    hedgeDelayMs: number,
    _traceId: string,
    _gatewayKeyId: string | undefined,
    _aliasName: string
  ): Promise<RouteAttemptResult> {
    const cb = CircuitBreakerManager.getInstance();

    return new Promise<RouteAttemptResult>((resolve, reject) => {
      let resolved = false;
      let primaryFinished = false;

      const finish = (result: RouteAttemptResult) => {
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
        .catch((_err) => {
          primaryFinished = true;
          if (!resolved) {
            // If primary fails quickly before hedge fires, hedge will still run or we reject
          }
        });

      // Launch speculative hedged request after delay
      setTimeout(() => {
        if (primaryFinished || resolved) return;

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
