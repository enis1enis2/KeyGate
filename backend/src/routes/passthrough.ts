import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { CONFIG } from '../config.js';
import { authorizeGatewayKey, sendAuthError } from '../auth.js';
import { SmartRouter } from '../engine/router.js';
import { decryptSecret } from '../crypto.js';
import { TemplateMapper } from '../engine/mapper.js';
import { CircuitBreakerManager } from '../engine/circuit-breaker.js';
import { errorMessage } from '../errors.js';

export const passthroughRoutes: FastifyPluginAsync = async (fastify) => {
  // DECISION: Support all HTTP methods for passthrough to accommodate arbitrary endpoints (images, audio, embeddings, fine-tuning).
  fastify.all('/v1/passthrough/:provider/*', {
    config: { rateLimit: { max: CONFIG.rateLimit.v1Max } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    // No pool alias to scope against here: the path selects the provider directly,
    // but rpm/tpm limits on the gateway key still apply.
    const auth = authorizeGatewayKey(request);
    if (!auth.authenticated) {
      return sendAuthError(reply, auth);
    }

    const { provider } = request.params as { provider: string };
    const wildcard = (request.params as { '*'?: string })['*'] || '';

    const router = SmartRouter.getInstance();
    const spec = router.getProviderSpec(provider);
    if (!spec) {
      return reply.status(404).send({
        error: {
          message: `Provider '${provider}' not found or inactive.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
    }

    const candidateKeys = router.getCandidateKeys(provider);
    if (candidateKeys.length === 0) {
      return reply.status(503).send({
        error: {
          message: `No healthy active keys available for provider '${provider}'.`,
          type: 'api_error',
          code: 'upstream_unavailable',
        },
      });
    }

    const selectedKey = candidateKeys[0]!.key;
    const decryptedKey = decryptSecret(selectedKey.encrypted_key, selectedKey.iv, selectedKey.tag);

    // Build target upstream URL
    const targetUrl = `${spec.base_url.replace(/\/+$/, '')}/${wildcard.replace(/^\/+/, '')}`;

    // Pass through headers while stripping host
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(request.headers)) {
      const lower = k.toLowerCase();
      if (lower !== 'host' && lower !== 'authorization' && lower !== 'content-length' && v) {
        forwardHeaders[k] = Array.isArray(v) ? v[0]! : v;
      }
    }

    // Apply upstream auth
    const authed = TemplateMapper.applyAuth(spec, decryptedKey, targetUrl, forwardHeaders, request.body);

    const startTime = Date.now();
    const traceId = crypto.randomUUID();
    let clientCommitted = false;
    try {
      const fetchOpts: RequestInit = {
        method: request.method,
        headers: authed.headers,
      };

      if (['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase()) && authed.bodyObj !== undefined) {
        fetchOpts.body = typeof authed.bodyObj === 'string' ? authed.bodyObj : JSON.stringify(authed.bodyObj);
      }

      const upstreamRes = await fetch(authed.url, fetchOpts);
      const latencyMs = Date.now() - startTime;

      CircuitBreakerManager.getInstance().recordCallResult(selectedKey.id, upstreamRes.ok, latencyMs);

      // DECISION: The response is streamed chunk-by-chunk instead of buffered, so large files
      // and SSE streams pass through with bounded memory. Length/encoding headers are dropped
      // because fetch already decoded the body: keeping them would desync the client.
      const forwarded: Record<string, string> = {};
      upstreamRes.headers.forEach((val, k) => {
        const lower = k.toLowerCase();
        if (['content-encoding', 'transfer-encoding', 'content-length', 'connection'].includes(lower)) {
          return;
        }
        forwarded[lower] = val;
      });
      forwarded['x-trace-id'] = traceId;

      reply.raw.writeHead(upstreamRes.status, forwarded);
      clientCommitted = true;

      const body = upstreamRes.body;
      if (body) {
        const asyncBody = body as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of asyncBody) {
          if (!reply.raw.write(Buffer.from(chunk))) {
            await new Promise<void>((resolve) => reply.raw.once('drain', () => resolve()));
          }
        }
      }
      reply.raw.end();
      return reply;
    } catch (err) {
      CircuitBreakerManager.getInstance().recordCallResult(selectedKey.id, false, Date.now() - startTime);
      if (clientCommitted) {
        reply.raw.end();
        return reply;
      }
      return reply.status(502).send({ error: { message: `Passthrough failed: ${errorMessage(err)}` } });
    }
  });
};
