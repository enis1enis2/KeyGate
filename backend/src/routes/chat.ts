import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { authorizeGatewayKey, sendAuthError } from '../auth.js';
import { SmartRouter, type RouteAttemptResult } from '../engine/router.js';
import { TemplateMapper } from '../engine/mapper.js';
import { GatewayQuota } from '../engine/gateway-quota.js';
import { computeCost } from '../engine/pricing.js';
import {
  buildSearchDisabledNotice,
  buildSearchSystemPrompt,
  extractSearchQueries,
  formatSearchResults,
  stripSearchQueries,
  webSearch,
} from '../engine/search.js';
import { ApiKeyRepo, RequestLogRepo, ChatHistoryRepo, ModelAliasRepo } from '../db/index.js';
import { toErrorInfo, toOpenAIError } from '../errors.js';
import type { ModelAliasRecord, OpenAIChatRequest, OpenAIMessage, OpenAIChatResponse } from '../types/index.js';

// DECISION: Clients send stream_options.include_usage so the final SSE chunk carries real token
// counts. Without it the gateway could not meter streaming usage for TPM limits or daily budgets.
function ensureUsageReporting(body: OpenAIChatRequest): void {
  if (!body.stream) return;
  const existing = body.stream_options as unknown;
  if (existing && typeof existing === 'object') return;
  body.stream_options = { include_usage: true };
}

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function readStreamUsage(chunk: unknown): StreamUsage | null {
  if (!chunk || typeof chunk !== 'object' || !('usage' in chunk)) return null;
  const usage = (chunk as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  return usage as StreamUsage;
}

// Message content can be a plain string or an array of typed parts (text/image_url).
function messageText(message: OpenAIMessage | undefined): string | null {
  if (!message || message.content == null) return null;
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? ((part as { text: string }).text as string)
            : JSON.stringify(part)
      )
      .filter(Boolean);
    return parts.length ? parts.join('\n') : null;
  }
  return String(message.content);
}

function lastUserPrompt(messages: OpenAIMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messageText(messages[i]);
  }
  return null;
}

function assistantContent(response: OpenAIChatResponse | undefined): string | null {
  return messageText(response?.choices?.[0]?.message);
}

interface SearchedChatResult {
  result: RouteAttemptResult;
  content: string;
  promptTokens: number;
  completionTokens: number;
  queries: string[];
}

// DECISION: Search runs as a ReAct loop above the router: the model emits `SEARCH:` sentinels, the
// gateway executes the searches and appends results as a tool-result block, then calls the model
// again. Every round is a real routed request, so each is logged/metered by the router. When the
// client asked for a stream we buffer the loop and replay the final answer as SSE (a search cannot
// be streamed token-by-token deterministically).
async function runSearchedChat(args: {
  router: SmartRouter;
  alias: ModelAliasRecord;
  body: OpenAIChatRequest;
  traceId: string;
  gatewayKeyId?: string;
}): Promise<SearchedChatResult> {
  const { router, alias, body, traceId, gatewayKeyId } = args;
  const searchOn = Boolean(alias.search_enabled);
  const maxRounds = searchOn ? Math.max(0, Math.min(5, alias.search_max_rounds || 3)) : 0;
  const maxResults = Math.max(1, Math.min(10, alias.search_max_results || 3));

  const messages: OpenAIMessage[] = Array.isArray(body.messages)
    ? body.messages.map((m) => ({ ...m }))
    : [];
  messages.push({
    role: 'system',
    content: searchOn ? buildSearchSystemPrompt() : buildSearchDisabledNotice(),
  });

  let promptTokens = 0;
  let completionTokens = 0;
  let last: RouteAttemptResult | null = null;
  const queries: string[] = [];

  for (let round = 0; round <= maxRounds; round++) {
    const req: OpenAIChatRequest = { ...body, messages, stream: false };
    delete req.stream_options;

    const result = await router.routeChatCompletion(body.model, req, traceId, gatewayKeyId, 'chat');
    last = result;
    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;

    const content = assistantContent(result.response) || '';
    if (!searchOn || round === maxRounds) break;

    const found = extractSearchQueries(content);
    if (found.length === 0) break;

    messages.push({ role: 'assistant', content: stripSearchQueries(content) || '(searching the web)' });
    const blocks: string[] = [];
    for (const query of found.slice(0, 3)) {
      queries.push(query);
      const results = await webSearch(query, { provider: alias.search_provider, maxResults });
      blocks.push(formatSearchResults(query, results));
    }
    messages.push({ role: 'user', content: blocks.join('\n\n') });
  }

  if (!last) throw new Error('Search loop produced no upstream response.');

  return {
    result: last,
    content: stripSearchQueries(assistantContent(last.response) || ''),
    promptTokens,
    completionTokens,
    queries,
  };
}

// Replay a buffered answer as a standards-compliant SSE stream (content, usage, finish, [DONE]).
function writeSynthesizedStream(
  reply: FastifyReply,
  args: { result: RouteAttemptResult; content: string; promptTokens: number; completionTokens: number; queries: string[] }
): void {
  const created = Math.floor(Date.now() / 1000);
  const id = args.result.response?.id || `chatcmpl-${Date.now()}`;
  const base = { id, object: 'chat.completion.chunk', created, model: args.result.model };
  const finish = args.result.response?.choices?.[0]?.finish_reason || 'stop';

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'x-trace-id': id,
    'x-keygate-provider': args.result.providerId,
    'x-keygate-model': args.result.model,
    'x-keygate-search': args.queries.join(' | '),
  });

  reply.raw.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: args.content }, finish_reason: null }] })}\n\n`
  );
  reply.raw.write(
    `data: ${JSON.stringify({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: args.promptTokens,
        completion_tokens: args.completionTokens,
        total_tokens: args.promptTokens + args.completionTokens,
      },
    })}\n\n`
  );
  reply.raw.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

// DECISION: Record only the prompt/answer pair into chat history. Never the raw request body
// or headers. Recording must never break the data plane, so failures are swallowed.
function recordChatHistory(args: {
  traceId: string;
  poolName: string;
  providerId: string;
  keyId: string;
  model: string;
  userMessage: string | null;
  assistantMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  isStream: boolean;
}): void {
  try {
    if (!args.userMessage && !args.assistantMessage) return;
    ChatHistoryRepo.add({
      id: crypto.randomUUID(),
      trace_id: args.traceId,
      pool_name: args.poolName,
      provider_id: args.providerId,
      key_id: args.keyId,
      model: args.model,
      role: 'user',
      content: args.userMessage,
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      is_stream: args.isStream,
    });
    ChatHistoryRepo.add({
      id: crypto.randomUUID(),
      trace_id: args.traceId,
      pool_name: args.poolName,
      provider_id: args.providerId,
      key_id: args.keyId,
      model: args.model,
      role: 'assistant',
      content: args.assistantMessage,
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      is_stream: args.isStream,
    });
  } catch (err) {
    console.error('[History] Failed to record chat history:', err instanceof Error ? err.message : err);
  }
}

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  // DECISION: Chat completions are the hottest path, so they carry their own stricter rate limit.
  fastify.post('/v1/chat/completions', {
    config: { rateLimit: { max: CONFIG.rateLimit.v1Max } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as OpenAIChatRequest | undefined;

    // Authenticate, enforce pool scope and reserve a gateway rate-limit slot in one pass.
    const auth = authorizeGatewayKey(request, {
      alias: typeof body?.model === 'string' ? body.model : undefined,
    });
    if (!auth.authenticated) {
      return sendAuthError(reply, auth);
    }

    if (!body || !body.model || !body.messages) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request body. Required fields: model, messages.',
          type: 'invalid_request_error',
          code: 'missing_required_fields',
        },
      });
    }

    ensureUsageReporting(body);

    const traceId = (request.headers['x-trace-id'] as string) || crypto.randomUUID();
    const router = SmartRouter.getInstance();

    // Agentic search path: only taken when the target pool has search enabled or asks for a
    // "search disabled" notice. Otherwise the plain streaming path below is used untouched.
    const alias = ModelAliasRepo.getByName(body.model);
    if (alias && (alias.search_enabled || alias.search_off_notice)) {
      try {
        const outcome = await runSearchedChat({
          router,
          alias,
          body,
          traceId,
          gatewayKeyId: auth.keyId,
        });
        const total = outcome.promptTokens + outcome.completionTokens;
        GatewayQuota.addTokens(auth.keyId || '', total);

        recordChatHistory({
          traceId,
          poolName: body.model,
          providerId: outcome.result.providerId,
          keyId: outcome.result.keyId,
          model: outcome.result.model,
          userMessage: lastUserPrompt(body.messages),
          assistantMessage: outcome.content,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          isStream: Boolean(body.stream),
        });

        if (!body.stream) {
          const response: OpenAIChatResponse = {
            id: outcome.result.response?.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: outcome.result.response?.created || Math.floor(Date.now() / 1000),
            model: outcome.result.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: outcome.content },
                finish_reason: outcome.result.response?.choices?.[0]?.finish_reason || 'stop',
              },
            ],
            usage: {
              prompt_tokens: outcome.promptTokens,
              completion_tokens: outcome.completionTokens,
              total_tokens: total,
            },
          };
          return reply
            .header('x-trace-id', traceId)
            .header('x-keygate-provider', outcome.result.providerId)
            .header('x-keygate-model', outcome.result.model)
            .header('x-keygate-search', outcome.queries.join(' | '))
            .send(response);
        }

        writeSynthesizedStream(reply, outcome);
        return reply;
      } catch (err) {
        const info = toErrorInfo(err);
        return reply.status(info.statusCode || 500).send(toOpenAIError(info));
      }
    }

    try {
      const result = await router.routeChatCompletion(
        body.model,
        body,
        traceId,
        auth.keyId,
        'chat'
      );

      // Handle non-streaming response (usage and cost were already logged by the router)
      if (!body.stream) {
        GatewayQuota.addTokens(auth.keyId || '', result.promptTokens + result.completionTokens);
        recordChatHistory({
          traceId,
          poolName: body.model,
          providerId: result.providerId,
          keyId: result.keyId,
          model: result.model,
          userMessage: lastUserPrompt(body.messages),
          assistantMessage: assistantContent(result.response),
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          isStream: false,
        });
        return reply
          .header('x-trace-id', traceId)
          .header('x-keygate-provider', result.providerId)
          .header('x-keygate-model', result.model)
          .send(result.response);
      }

      // Handle streaming SSE response
      if (result.streamResponse && result.streamResponse.body) {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'x-trace-id': traceId,
          'x-keygate-provider': result.providerId,
          'x-keygate-model': result.model,
        });

        const reader = result.streamResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamUsage: StreamUsage | null = null;
        let streamedContent = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(':')) continue; // Skip SSE comments or empty lines

              if (trimmed === 'data: [DONE]') {
                reply.raw.write('data: [DONE]\n\n');
                continue;
              }

              if (trimmed.startsWith('data: ')) {
                const dataContent = trimmed.slice(6).trim();
                try {
                  const parsed = JSON.parse(dataContent);
                  const usage = readStreamUsage(parsed);
                  if (usage) streamUsage = usage;
                  const mappedChunk = await TemplateMapper.mapChunk(result.spec, parsed, body.model);
                  if (mappedChunk) {
                    const delta = mappedChunk.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string') streamedContent += delta;
                    reply.raw.write(`data: ${JSON.stringify(mappedChunk)}\n\n`);
                  }
                } catch {
                  // Pass raw if non-json
                  reply.raw.write(`${trimmed}\n\n`);
                }
              } else {
                // NDJSON or raw text chunk
                try {
                  const parsed = JSON.parse(trimmed);
                  const usage = readStreamUsage(parsed);
                  if (usage) streamUsage = usage;
                  const mappedChunk = await TemplateMapper.mapChunk(result.spec, parsed, body.model);
                  if (mappedChunk) {
                    const delta = mappedChunk.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string') streamedContent += delta;
                    reply.raw.write(`data: ${JSON.stringify(mappedChunk)}\n\n`);
                  }
                } catch {
                  // Ignore parse error on partial chunks
                }
              }
            }
          }

          // Emit final standard [DONE] sentinel
          reply.raw.write('data: [DONE]\n\n');
        } finally {
          reader.releaseLock();
          reply.raw.end();
        }

        // Backfill real usage once the upstream stream is fully drained.
        const promptTokens = streamUsage?.prompt_tokens || 0;
        const completionTokens = streamUsage?.completion_tokens || 0;
        if (streamUsage || streamedContent) {
          const cost = computeCost(result.providerId, result.model, promptTokens, completionTokens);
          RequestLogRepo.finalizeUsage(traceId, promptTokens, completionTokens, cost);
          if (cost > 0) ApiKeyRepo.addDailyUsage(result.keyId, cost);
          GatewayQuota.addTokens(auth.keyId || '', promptTokens + completionTokens);
        }

        recordChatHistory({
          traceId,
          poolName: body.model,
          providerId: result.providerId,
          keyId: result.keyId,
          model: result.model,
          userMessage: lastUserPrompt(body.messages),
          assistantMessage: streamedContent || null,
          promptTokens,
          completionTokens,
          isStream: true,
        });

        return reply;
      }

      return reply.status(500).send({
        error: { message: 'Failed to establish upstream streaming response.', type: 'api_error' },
      });
    } catch (err) {
      const info = toErrorInfo(err);
      const statusCode = info.statusCode || info.classified?.statusCode || 500;
      return reply.status(statusCode).send(toOpenAIError(info));
    }
  });
};
