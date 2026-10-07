import type { FastifyPluginAsync } from 'fastify';
import { CONFIG } from '../config.js';
import { proxyEndpoint, sendProxyError } from '../engine/proxy.js';

// DECISION: Embeddings ride the shared proxy pipeline instead of a bespoke one, so they get
// pool budgets, budget-aware key failover, cost metering and OpenAI error envelopes for free.
export const embeddingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/embeddings', {
    config: { rateLimit: { max: CONFIG.rateLimit.v1Max } },
  }, async (request, reply) => {
    const body = request.body as { model?: unknown; input?: unknown } | undefined;

    if (!body || typeof body.model !== 'string' || !body.model || body.input === undefined) {
      return reply.status(400).send({
        error: {
          message: 'Missing model or input in request body.',
          type: 'invalid_request_error',
          code: 'missing_required_fields',
        },
      });
    }

    try {
      return await proxyEndpoint({
        endpoint: 'embeddings',
        pathKey: 'embeddings',
        request,
        reply,
      });
    } catch (err) {
      return sendProxyError(reply, err);
    }
  });
};
