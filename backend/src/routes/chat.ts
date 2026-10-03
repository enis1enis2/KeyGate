import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { GatewayKeyRepo } from '../db/index.js';
import { hashToken } from '../crypto.js';
import { SmartRouter } from '../engine/router.js';
import { TemplateMapper } from '../engine/mapper.js';
import type { OpenAIChatRequest } from '../types/index.js';

// DECISION: Authenticate gateway tokens via SHA-256 hash lookup against database, allowing optional unauthenticated local mode when configured.
export function authenticateGatewayKey(req: FastifyRequest): { authenticated: boolean; keyId?: string; error?: string } {
  if (!CONFIG.requireAuth) {
    return { authenticated: true };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Missing or malformed Authorization header. Expected: Bearer <keygate_token>' };
  }

  const rawToken = authHeader.slice(7).trim();
  const tokenHash = hashToken(rawToken);
  const keyRecord = GatewayKeyRepo.getByHash(tokenHash);

  if (!keyRecord) {
    return { authenticated: false, error: 'Invalid or revoked Gateway API key.' };
  }

  if (keyRecord.expires_at && Date.now() > keyRecord.expires_at) {
    return { authenticated: false, error: 'Gateway API key has expired.' };
  }

  return { authenticated: true, keyId: keyRecord.id };
}

export const chatRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/chat/completions', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticateGatewayKey(request);
    if (!auth.authenticated) {
      return reply.status(401).send({
        error: {
          message: auth.error || 'Unauthorized',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }

    const body = request.body as OpenAIChatRequest;
    if (!body || !body.model || !body.messages) {
      return reply.status(400).send({
        error: {
          message: 'Invalid request body. Required fields: model, messages.',
          type: 'invalid_request_error',
          code: 'missing_required_fields',
        },
      });
    }

    const traceId = (request.headers['x-trace-id'] as string) || crypto.randomUUID();
    const router = SmartRouter.getInstance();

    try {
      const result = await router.routeChatCompletion(
        body.model,
        body,
        traceId,
        auth.keyId
      );

      // Handle non-streaming response
      if (!body.stream) {
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

        return reply;
      }

      return reply.status(500).send({
        error: { message: 'Failed to establish upstream streaming response.', type: 'api_error' },
      });
    } catch (err: any) {
      const statusCode = err.statusCode || (err.classified?.statusCode) || 500;
      const message = err.classified?.message || err.message || 'Internal gateway error';
      return reply.status(statusCode).send({
        error: {
          message,
          type: err.classified?.errorType || 'api_error',
          code: err.classified?.errorType || 'internal_error',
        },
      });
    }
  });
};
