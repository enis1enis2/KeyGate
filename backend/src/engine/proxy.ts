import crypto from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/multipart';
import { CONFIG } from '../config.js';
import { authorizeGatewayKey, sendAuthError } from '../auth.js';
import { ApiKeyRepo, RequestLogRepo, StickyRouteRepo } from '../db/index.js';
import { decryptSecret } from '../crypto.js';
import { toErrorInfo, toOpenAIError } from '../errors.js';
import { quotaRejections } from '../metrics.js';
import { CircuitBreakerManager } from './circuit-breaker.js';
import { classifyError, type ClassifiedError } from './error-classifier.js';
import { GatewayQuota } from './gateway-quota.js';
import { TemplateMapper } from './mapper.js';
import { computeCost } from './pricing.js';
import {
  assertPoolBudget,
  loadProviderSpec,
  providerHealthScore,
  resolveTargets,
  selectCandidateKeys,
  sortTargets,
} from './targeting.js';
import {
  DEFAULT_ENDPOINT_PATHS,
  type ApiKeyRecord,
  type EndpointKind,
  type EndpointPathKey,
  type ProviderSpec,
} from '../types/index.js';

// DECISION: Every non-chat OpenAI surface shares one proxy pipeline (auth -> pool budget ->
// health-ranked failover -> usage metering -> error envelope). Chat keeps its own router because
// it additionally applies request/response mapping and hedging, but both delegate target
// resolution and key selection to engine/targeting.ts so pool semantics cannot diverge.

export interface ProxyEndpointOptions {
  endpoint: EndpointKind;
  pathKey: EndpointPathKey;
  request: FastifyRequest;
  reply: FastifyReply;
  method?: string;
  /** Body field that names the pool. Defaults to `model`. */
  modelField?: string;
  /** Query field that names the pool on GET routes. */
  modelQueryField?: string;
  /** Accept multipart/form-data bodies (images + audio). */
  allowMultipart?: boolean;
  /** Reject requests carrying no `model` parameter with a 400 before routing. */
  requireModel?: boolean;
  /** Reply with a streamed binary body instead of JSON (audio/speech, file content). */
  binary?: boolean;
  /** Path parameter naming an upstream resource that must stick to one upstream account. */
  stickyParam?: string;
  /** Static segment appended after the resource id, e.g. `/cancel` or `/content`. */
  pathSuffix?: string;
  /** After a successful create, pin the upstream resource id to this attempt's key. */
  stickyCreate?: boolean;
  /** Inject stream_options.include_usage for streaming bodies (chat-like endpoints). */
  ensureUsage?: boolean;
}

interface MultipartEntry {
  kind: 'field' | 'file';
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

const MULTIPART_BOUNDARY_PREFIX = 'keygate-boundary-';

async function readMultipart(request: FastifyRequest): Promise<MultipartEntry[]> {
  const entries: MultipartEntry[] = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const data = await part.toBuffer();
      entries.push({
        kind: 'file',
        name: part.fieldname,
        filename: part.filename,
        contentType: part.mimetype,
        data,
      });
    } else {
      entries.push({ kind: 'field', name: part.fieldname, value: String(part.value) });
    }
  }
  return entries;
}

// Re-serialized with a fresh boundary so auth/model fields can be rewritten per attempt.
function serializeMultipart(entries: MultipartEntry[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if (entry.kind === 'field') {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${entry.name}"\r\n\r\n${entry.value ?? ''}\r\n`,
          'utf8'
        )
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${entry.name}"; filename="${entry.filename ?? 'file'}"\r\n`,
          'utf8'
        )
      );
      chunks.push(
        Buffer.from(`Content-Type: ${entry.contentType || 'application/octet-stream'}\r\n\r\n`, 'utf8')
      );
      chunks.push(entry.data ?? Buffer.alloc(0));
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function findField(entries: MultipartEntry[], name: string): string | undefined {
  return entries.find((e) => e.kind === 'field' && e.name === name)?.value;
}

interface UsageCounts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// OpenAI chat/completions use prompt/completion, the Responses API uses input/output.
function readUsageObject(usage: unknown): UsageCounts | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const promptTokens = toNumber(u.prompt_tokens ?? u.input_tokens);
  const completionTokens = toNumber(u.completion_tokens ?? u.output_tokens);
  const totalTokens = toNumber(u.total_tokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function extractUsage(json: unknown): UsageCounts | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const direct = readUsageObject(record.usage);
  if (direct) return direct;
  const nested = readUsageObject((record.response as Record<string, unknown> | undefined)?.usage);
  return nested;
}

// Streams are metered incrementally: only `data:` lines are parsed, nothing is buffered whole.
class SseUsageReader {
  private decoder = new TextDecoder();
  private buffer = '';
  private counts: UsageCounts = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return;
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const usage = extractUsage(parsed);
    if (usage) this.counts = usage;
  }

  flush(): void {
    if (this.buffer.trim()) this.consumeLine(this.buffer.trim());
    this.buffer = '';
  }

  get usage(): UsageCounts {
    return this.counts;
  }
}

const FORWARDED_RESPONSE_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'retry-after', 'x-request-id'];

function pickResponseHeaders(upstream: Response): Record<string, string> {
  const picked: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (
      FORWARDED_RESPONSE_HEADERS.includes(lower) ||
      lower.startsWith('openai-') ||
      lower.startsWith('x-ratelimit-')
    ) {
      picked[lower] = value;
    }
  });
  return picked;
}

interface Attempt {
  spec: ProviderSpec;
  key: ApiKeyRecord;
  providerId: string;
  /** Client-facing model name, used for logs and pricing lookups. */
  model: string;
  fromSticky: boolean;
}

export async function proxyEndpoint(opts: ProxyEndpointOptions): Promise<FastifyReply> {
  const { request, reply } = opts;
  const method = (opts.method || 'POST').toUpperCase();
  const modelField = opts.modelField ?? 'model';
  const sendsBody = method !== 'GET' && method !== 'HEAD';
  const contentTypeHeader = String(request.headers['content-type'] ?? '');
  const isMultipart = contentTypeHeader.includes('multipart/form-data');

  if (isMultipart && !opts.allowMultipart) {
    return reply.status(415).send({
      error: {
        message: `Content type 'multipart/form-data' is not supported on this endpoint.`,
        type: 'invalid_request_error',
        param: null,
        code: 'unsupported_media_type',
      },
    });
  }

  // ---- Body acquisition -------------------------------------------------
  let entries: MultipartEntry[] | null = null;
  let jsonBody: Record<string, unknown> | null = null;
  let jsonText: string | null = null;

  if (isMultipart) {
    try {
      entries = await readMultipart(request);
    } catch (err) {
      const info = toErrorInfo(err);
      return reply.status(413).send({
        error: {
          message: info.message || 'Uploaded file exceeds the configured size limit.',
          type: 'invalid_request_error',
          param: null,
          code: 'file_too_large',
        },
      });
    }
  } else if (sendsBody && request.body !== undefined && request.body !== null) {
    const raw = request.body;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      jsonBody = raw as Record<string, unknown>;
    }
    try {
      jsonText = JSON.stringify(raw);
    } catch {
      jsonText = null;
    }
  }

  const requestSnippet = (
    jsonText ??
    (entries
      ? JSON.stringify(
          entries.map((e) => (e.kind === 'file' ? `${e.name}:${e.filename ?? ''}` : e.name))
        )
      : '')
  ).slice(0, 300);

  // ---- Pool name + sticky resource --------------------------------------
  let poolName: string | undefined;
  if (entries) poolName = findField(entries, modelField);
  if (!poolName && jsonBody && typeof jsonBody[modelField] === 'string') {
    poolName = jsonBody[modelField] as string;
  }
  if (!poolName && opts.modelQueryField) {
    const query = request.query as Record<string, unknown>;
    const queryValue = query[opts.modelQueryField];
    if (typeof queryValue === 'string') poolName = queryValue;
  }

  let resourceId: string | undefined;
  if (opts.stickyParam) {
    const params = request.params as Record<string, string | undefined>;
    resourceId = params[opts.stickyParam];
  }
  // Follow-up routes (`/v1/batches/:id`, `/v1/files/:id/content`) must address the same
  // resource upstream that the create call produced.
  const resourcePath = resourceId ? `/${encodeURIComponent(resourceId)}` : '';
  const pathSuffix = opts.pathSuffix || '';

  const sticky = resourceId ? StickyRouteRepo.get(resourceId) : null;

  // ---- Auth: identity, pool scope, rate slots (once per inbound request) --
  const auth = authorizeGatewayKey(request, { alias: sticky?.pool_name || poolName });
  if (!auth.authenticated) return sendAuthError(reply, auth);

  if (opts.requireModel && !poolName) {
    return reply.status(400).send({
      error: {
        message: 'Missing model in request body.',
        type: 'invalid_request_error',
        code: 'missing_required_fields',
      },
    });
  }

  const traceId = crypto.randomUUID();
  const wantsStream = Boolean(jsonBody?.stream === true);

  if (opts.ensureUsage && jsonBody && wantsStream && !jsonBody.stream_options) {
    jsonBody.stream_options = { include_usage: true };
    try {
      jsonText = JSON.stringify(jsonBody);
    } catch {
      jsonText = null;
    }
  }

  // ---- Resolve targets ---------------------------------------------------
  const resolved = resolveTargets(poolName ?? '', poolName ?? '', opts.pathKey);
  const { alias } = resolved;

  try {
    if (alias && !sticky) assertPoolBudget(alias);
  } catch (err) {
    const info = toErrorInfo(err);
    return reply.status(info.statusCode || 500).send(toOpenAIError(info));
  }

  const attempts: Attempt[] = [];
  let budgetBlocked = 0;

  if (sticky) {
    const spec = loadProviderSpec(sticky.provider_id);
    const key = ApiKeyRepo.getById(sticky.key_id);
    if (spec && key) {
      attempts.push({
        spec,
        key,
        providerId: sticky.provider_id,
        model: poolName || sticky.pool_name || '',
        fromSticky: true,
      });
    }
  } else {
    const sorted = alias ? sortTargets(alias, resolved.targets, providerHealthScore) : resolved.targets;
    for (const target of sorted) {
      const spec = loadProviderSpec(target.provider_id);
      if (!spec) continue;
      const selection = selectCandidateKeys(target.provider_id);
      budgetBlocked += selection.budgetBlocked;
      for (const { key } of selection.available) {
        attempts.push({
          spec,
          key,
          providerId: target.provider_id,
          model: target.model || poolName || '',
          fromSticky: false,
        });
      }
    }
  }

  if (attempts.length === 0) {
    if (budgetBlocked > 0) {
      quotaRejections.inc({ scope: 'key_budget_cap' });
      return reply.status(429).send(
        toOpenAIError({
          message: `Daily budget exhausted for every upstream key behind model '${poolName || opts.pathKey}'. Resets at the next UTC midnight.`,
          classified: { errorType: 'quota_exhausted', statusCode: 429, message: 'Daily upstream key budget exhausted.' },
        })
      );
    }
    return reply.status(503).send({
      error: {
        message: `No active provider targets are configured for model '${poolName || opts.pathKey}'.`,
        type: 'api_error',
        code: 'no_upstream_targets',
      },
    });
  }

  const cb = CircuitBreakerManager.getInstance();
  const effectiveTimeoutMs = alias?.timeout_ms || CONFIG.defaultTimeoutMs;
  const boundary = `${MULTIPART_BOUNDARY_PREFIX}${crypto.randomUUID()}`;

  const writeLog = (fields: {
    attempt: Attempt;
    status: 'success' | 'error';
    statusCode: number;
    errorType?: ClassifiedError['errorType'] | null;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
    responseSnippet: string | null;
    isStream: boolean;
  }): void => {
    RequestLogRepo.insert({
      id: crypto.randomUUID(),
      trace_id: traceId,
      gateway_key_id: auth.keyId || null,
      alias_name: poolName || null,
      provider_id: fields.attempt.providerId,
      key_id: fields.attempt.key.id,
      model: fields.attempt.model,
      status: fields.status,
      status_code: fields.statusCode,
      error_type: fields.errorType || null,
      latency_ms: fields.latencyMs,
      prompt_tokens: fields.promptTokens,
      completion_tokens: fields.completionTokens,
      is_stream: fields.isStream ? 1 : 0,
      is_hedged: 0,
      request_snippet: requestSnippet || null,
      response_snippet: fields.responseSnippet,
      endpoint: opts.endpoint,
      cost: fields.cost,
      pool_name: poolName || null,
      created_at: new Date().toISOString(),
    });
  };

  let lastError: unknown = null;
  let clientCommitted = false;

  for (const attempt of attempts) {
    let upstream: Response;
    let latencyMs: number;

    try {
      const dispatched = await dispatchAttempt({
        attempt,
        method,
        url: buildUpstreamUrl(attempt.spec, opts.pathKey, resourcePath, pathSuffix),
        headers: { Accept: wantsStream ? 'text/event-stream, application/json' : '*/*' },
        jsonBody,
        jsonText,
        modelField,
        poolName,
        resolvedModel: poolName ? TemplateMapper.resolveModel(attempt.spec, attempt.model) : '',
        entries,
        boundary,
        timeoutMs: effectiveTimeoutMs,
      });
      upstream = dispatched.upstream;
      latencyMs = dispatched.latencyMs;
    } catch (err) {
      const info = toErrorInfo(err);
      const classified: ClassifiedError = info.classified ?? {
        errorType: 'fatal',
        statusCode: 500,
        message: info.message || 'Unknown upstream error',
      };

      cb.recordCallResult(
        attempt.key.id,
        false,
        info.latencyMs || 0,
        0,
        0,
        classified.errorType,
        classified.message,
        classified.retryAfterMs
      );
      writeLog({
        attempt,
        status: 'error',
        statusCode: info.statusCode || classified.statusCode || 500,
        errorType: classified.errorType,
        latencyMs: info.latencyMs || 0,
        promptTokens: 0,
        completionTokens: 0,
        cost: 0,
        responseSnippet: classified.message,
        isStream: wantsStream,
      });

      lastError = err;
      continue;
    }

    const isEventStream = String(upstream.headers.get('content-type') ?? '').includes('text/event-stream');
    const mode: 'stream' | 'binary' | 'json' = isEventStream ? 'stream' : opts.binary ? 'binary' : 'json';

    if (mode === 'json') {
      let text: string;
      try {
        text = await upstream.text();
      } catch (err) {
        lastError = err;
        continue;
      }

      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }

      const usage = extractUsage(parsed);
      const promptTokens = usage?.promptTokens ?? 0;
      const completionTokens = usage?.completionTokens ?? 0;
      const cost = computeCost(attempt.providerId, attempt.model, promptTokens, completionTokens);

      cb.recordCallResult(attempt.key.id, true, latencyMs, promptTokens, completionTokens);
      if (cost > 0) ApiKeyRepo.addDailyUsage(attempt.key.id, cost);
      GatewayQuota.addTokens(auth.keyId || '', usage?.totalTokens ?? promptTokens + completionTokens);

      writeLog({
        attempt,
        status: 'success',
        statusCode: upstream.status,
        latencyMs,
        promptTokens,
        completionTokens,
        cost,
        responseSnippet: text.slice(0, 300),
        isStream: false,
      });

      if (opts.stickyCreate && parsed && typeof parsed === 'object') {
        const resourceId = (parsed as Record<string, unknown>).id;
        if (typeof resourceId === 'string' && resourceId) {
          StickyRouteRepo.record({
            resource_id: resourceId,
            pool_name: poolName || null,
            endpoint: opts.endpoint,
            provider_id: attempt.providerId,
            key_id: attempt.key.id,
          });
        }
      }

      const responseHeaders = pickResponseHeaders(upstream);
      reply.status(upstream.status);
      for (const [name, value] of Object.entries(responseHeaders)) reply.header(name, value);
      reply.header('x-trace-id', traceId);
      reply.header('x-keygate-provider', attempt.providerId);
      reply.header('x-keygate-model', attempt.model);

      if (parsed !== undefined) return reply.send(parsed);
      return reply.send(text);
    }

    // Stream / binary modes write straight to the socket, so the failover chain ends here.
    clientCommitted = true;
    cb.recordCallResult(attempt.key.id, true, latencyMs, 0, 0);
    writeLog({
      attempt,
      status: 'success',
      statusCode: upstream.status,
      latencyMs,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      responseSnippet: mode === 'stream' ? 'stream' : 'binary',
      isStream: mode === 'stream',
    });

    if (mode === 'binary') {
      await pipeBinary(upstream, reply, attempt.providerId, attempt.model, traceId);
      finalizeGatewayUsage(auth.keyId, 0);
      return reply;
    }

    reply.raw.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'x-trace-id': traceId,
      'x-keygate-provider': attempt.providerId,
      'x-keygate-model': attempt.model,
    });

    const usageReader = new SseUsageReader();
    try {
      const body = upstream.body;
      if (body) {
        const asyncBody = body as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of asyncBody) {
          usageReader.push(chunk);
          if (!reply.raw.write(Buffer.from(chunk))) {
            await waitForDrain(reply.raw);
          }
        }
      }
      usageReader.flush();
      const usage = usageReader.usage;
      if (usage.totalTokens > 0 || usage.promptTokens > 0) {
        const cost = computeCost(
          attempt.providerId,
          attempt.model,
          usage.promptTokens,
          usage.completionTokens
        );
        RequestLogRepo.finalizeUsage(traceId, usage.promptTokens, usage.completionTokens, cost);
        if (cost > 0) ApiKeyRepo.addDailyUsage(attempt.key.id, cost);
        finalizeGatewayUsage(auth.keyId, usage.totalTokens);
      }
    } finally {
      reply.raw.end();
    }

    return reply;
  }

  if (clientCommitted) {
    throw lastError || new Error('Upstream stream ended before a response could be delivered.');
  }
  throw lastError || new Error(`All upstream targets failed for ${opts.pathKey}.`);
}

function buildUpstreamUrl(
  spec: ProviderSpec,
  pathKey: EndpointPathKey,
  resourcePath: string,
  pathSuffix: string
): string {
  const path = spec.endpoint_paths[pathKey] || DEFAULT_ENDPOINT_PATHS[pathKey];
  return `${spec.base_url.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}${resourcePath}${pathSuffix}`;
}

function finalizeGatewayUsage(keyId: string | undefined, tokens: number): void {
  if (keyId && tokens > 0) GatewayQuota.addTokens(keyId, tokens);
}

function waitForDrain(socket: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => socket.once('drain', () => resolve()));
}

async function pipeBinary(
  upstream: Response,
  reply: FastifyReply,
  providerId: string,
  model: string,
  traceId: string
): Promise<void> {
  reply.raw.writeHead(upstream.status, {
    ...(upstream.headers.get('content-type')
      ? { 'content-type': upstream.headers.get('content-type')! }
      : {}),
    ...(upstream.headers.get('content-disposition')
      ? { 'content-disposition': upstream.headers.get('content-disposition')! }
      : {}),
    'x-trace-id': traceId,
    'x-keygate-provider': providerId,
    'x-keygate-model': model,
  });

  const body = upstream.body;
  if (!body) {
    reply.raw.end();
    return;
  }

  const asyncBody = body as unknown as AsyncIterable<Uint8Array>;
  try {
    for await (const chunk of asyncBody) {
      if (!reply.raw.write(Buffer.from(chunk))) {
        await waitForDrain(reply.raw);
      }
    }
  } finally {
    reply.raw.end();
  }
}

interface DispatchArgs {
  attempt: Attempt;
  method: string;
  url: string;
  headers: Record<string, string>;
  jsonBody: Record<string, unknown> | null;
  jsonText: string | null;
  modelField: string;
  poolName?: string;
  resolvedModel: string;
  entries: MultipartEntry[] | null;
  boundary: string;
  timeoutMs: number;
}

// Build one upstream attempt: decrypt the key, apply provider auth, rewrite the pool model,
// then fetch with a hard timeout. Throws a structured {classified, statusCode, latencyMs}
// object on any failure so the caller can classify, meter the breaker and fail over.
async function dispatchAttempt(
  args: DispatchArgs
): Promise<{ upstream: Response; latencyMs: number }> {
  const { attempt } = args;
  const decryptedKey = decryptSecret(
    attempt.key.encrypted_key,
    attempt.key.iv,
    attempt.key.tag
  );

  const authType = attempt.spec.auth.type;
  const authTemplate = attempt.spec.auth.template.replace(/\{\{\s*key\s*\}\}/g, decryptedKey);
  let url = args.url;
  const headers: Record<string, string> = { ...args.headers };
  let body: BodyInit | undefined;

  if (args.entries) {
    let entries = args.entries;
    if (authType === 'body') {
      entries = [
        ...entries,
        { kind: 'field', name: attempt.spec.auth.name || 'api_key', value: authTemplate },
      ];
    }
    if (args.poolName) {
      entries = entries.map((entry) =>
        entry.kind === 'field' && entry.name === args.modelField
          ? { ...entry, value: args.resolvedModel }
          : entry
      );
    }
    const authed = TemplateMapper.applyAuth(attempt.spec, decryptedKey, url, headers, undefined);
    url = authed.url;
    Object.assign(headers, authed.headers);
    headers['Content-Type'] = `multipart/form-data; boundary=${args.boundary}`;
    body = serializeMultipart(entries, args.boundary) as unknown as BodyInit;
  } else {
    let outbound: unknown;
    if (args.jsonBody) {
      outbound =
        args.poolName && typeof args.jsonBody[args.modelField] === 'string'
          ? { ...args.jsonBody, [args.modelField]: args.resolvedModel }
          : args.jsonBody;
    } else if (args.jsonText !== null) {
      try {
        outbound = JSON.parse(args.jsonText);
      } catch {
        outbound = args.jsonText;
      }
    }

    const authed = TemplateMapper.applyAuth(
      attempt.spec,
      decryptedKey,
      url,
      headers,
      outbound
    );
    url = authed.url;
    Object.assign(headers, authed.headers);
    if (args.method !== 'GET' && args.method !== 'HEAD' && authed.bodyObj !== undefined) {
      const asText = typeof authed.bodyObj === 'string';
      body = asText ? (authed.bodyObj as string) : JSON.stringify(authed.bodyObj);
      // `fetch` would otherwise fall back to `text/plain` for string bodies, which upstreams
      // reject as an unparseable payload.
      const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
      if (!hasContentType) headers['Content-Type'] = asText ? 'text/plain; charset=UTF-8' : 'application/json';
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const startedAt = Date.now();
  let upstream: Response;

  try {
    upstream = await fetch(url, {
      method: args.method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const info = toErrorInfo(err);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    const classified = classifyError(
      isTimeout ? 504 : 500,
      {},
      { message: info.message || (isTimeout ? 'Upstream request timed out' : 'Network error') },
      attempt.spec.error_classification
    );
    throw { classified, latencyMs, statusCode: isTimeout ? 504 : 500 };
  } finally {
    clearTimeout(timer);
  }

  const latencyMs = Date.now() - startedAt;

  if (!upstream.ok) {
    let rawErrorBody: unknown = null;
    try {
      const text = await upstream.text();
      try {
        rawErrorBody = JSON.parse(text);
      } catch {
        rawErrorBody = text;
      }
    } catch {
      rawErrorBody = null;
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });

    const classified = classifyError(
      upstream.status,
      responseHeaders,
      rawErrorBody,
      attempt.spec.error_classification,
      attempt.spec.rate_limit_headers
    );

    throw { classified, latencyMs, statusCode: upstream.status, rawBody: rawErrorBody };
  }

  return { upstream, latencyMs };
}

// Serialize a routing failure into the OpenAI error envelope. Routes catch everything that
// proxyEndpoint throws (no-target, budget exhaustion, exhausted failover chain).
export function sendProxyError(reply: FastifyReply, err: unknown): FastifyReply {
  const info = toErrorInfo(err);
  const statusCode = info.statusCode || info.classified?.statusCode || 500;
  return reply.status(statusCode).send(toOpenAIError(info));
}

