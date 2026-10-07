import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { authorizeGatewayKey, sendAuthError } from '../auth.js';
import { SmartRouter } from '../engine/router.js';
import { TemplateMapper } from '../engine/mapper.js';
import { GatewayQuota } from '../engine/gateway-quota.js';
import { computeCost } from '../engine/pricing.js';
import { ApiKeyRepo, RequestLogRepo } from '../db/index.js';
import { toErrorInfo, toOpenAIError } from '../errors.js';
import type { OpenAIChatRequest } from '../types/index.js';

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
        if (streamUsage) {
          const promptTokens = streamUsage.prompt_tokens || 0;
          const completionTokens = streamUsage.completion_tokens || 0;
          const cost = computeCost(result.providerId, result.model, promptTokens, completionTokens);
          RequestLogRepo.finalizeUsage(traceId, promptTokens, completionTokens, cost);
          ApiKeyRepo.addDailyUsage(result.keyId, cost);
          GatewayQuota.addTokens(auth.keyId || '', promptTokens + completionTokens);
        }

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
