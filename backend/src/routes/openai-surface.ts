import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { CONFIG } from '../config.js';
import { proxyEndpoint, sendProxyError, type ProxyEndpointOptions } from '../engine/proxy.js';

// DECISION: Every OpenAI surface except chat/chat-embeddings/models rides the shared
// engine/proxy.ts pipeline. Keeping the route table declarative means adding a surface is a
// one-line change (path + EndpointPathKey), not a new hand-rolled proxy.
type RouteOptions = Omit<ProxyEndpointOptions, 'request' | 'reply'>;

export const openaiSurfaceRoutes: FastifyPluginAsync = async (fastify) => {
  const rateLimitConfig = { rateLimit: { max: CONFIG.rateLimit.v1Max } };

  const handler = (options: RouteOptions) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await proxyEndpoint({ ...options, request, reply });
      } catch (err) {
        return sendProxyError(reply, err);
      }
    };
  };

  // ---- /v1/responses -----------------------------------------------------
  fastify.post(
    '/v1/responses',
    { config: rateLimitConfig },
    handler({ endpoint: 'responses', pathKey: 'responses', requireModel: true })
  );

  // ---- /v1/completions (legacy) ------------------------------------------
  fastify.post(
    '/v1/completions',
    { config: rateLimitConfig },
    handler({ endpoint: 'completions', pathKey: 'completions', ensureUsage: true, requireModel: true })
  );

  // ---- /v1/moderations ---------------------------------------------------
  fastify.post(
    '/v1/moderations',
    { config: rateLimitConfig },
    handler({ endpoint: 'moderations', pathKey: 'moderations', requireModel: true })
  );

  // ---- /v1/images --------------------------------------------------------
  fastify.post(
    '/v1/images/generations',
    { config: rateLimitConfig },
    handler({ endpoint: 'images', pathKey: 'images', requireModel: true })
  );
  fastify.post(
    '/v1/images/edits',
    { config: rateLimitConfig },
    handler({ endpoint: 'images', pathKey: 'images_edits', allowMultipart: true, requireModel: true })
  );
  fastify.post(
    '/v1/images/variations',
    { config: rateLimitConfig },
    handler({ endpoint: 'images', pathKey: 'images_variations', allowMultipart: true })
  );

  // ---- /v1/audio ---------------------------------------------------------
  fastify.post(
    '/v1/audio/transcriptions',
    { config: rateLimitConfig },
    handler({ endpoint: 'audio', pathKey: 'audio_transcriptions', allowMultipart: true, requireModel: true })
  );
  fastify.post(
    '/v1/audio/translations',
    { config: rateLimitConfig },
    handler({ endpoint: 'audio', pathKey: 'audio_translations', allowMultipart: true, requireModel: true })
  );
  fastify.post(
    '/v1/audio/speech',
    { config: rateLimitConfig },
    handler({ endpoint: 'audio', pathKey: 'audio_speech', binary: true, requireModel: true })
  );

  // ---- /v1/files (created files are pinned to one upstream account) ------
  fastify.post(
    '/v1/files',
    { config: rateLimitConfig },
    handler({ endpoint: 'files', pathKey: 'files', allowMultipart: true, stickyCreate: true })
  );
  fastify.get('/v1/files', { config: rateLimitConfig }, handler({ endpoint: 'files', pathKey: 'files', method: 'GET' }));
  fastify.get(
    '/v1/files/:file_id',
    { config: rateLimitConfig },
    handler({ endpoint: 'files', pathKey: 'files', method: 'GET', stickyParam: 'file_id' })
  );
  fastify.get(
    '/v1/files/:file_id/content',
    { config: rateLimitConfig },
    handler({
      endpoint: 'files',
      pathKey: 'files',
      method: 'GET',
      stickyParam: 'file_id',
      pathSuffix: '/content',
      binary: true,
    })
  );

  // ---- /v1/batches (jobs are pinned to one upstream account) -------------
  fastify.post(
    '/v1/batches',
    { config: rateLimitConfig },
    handler({ endpoint: 'batches', pathKey: 'batches', stickyCreate: true })
  );
  fastify.get('/v1/batches', { config: rateLimitConfig }, handler({ endpoint: 'batches', pathKey: 'batches', method: 'GET' }));
  fastify.get(
    '/v1/batches/:batch_id',
    { config: rateLimitConfig },
    handler({ endpoint: 'batches', pathKey: 'batches', method: 'GET', stickyParam: 'batch_id' })
  );
  fastify.post(
    '/v1/batches/:batch_id/cancel',
    { config: rateLimitConfig },
    handler({
      endpoint: 'batches',
      pathKey: 'batches',
      stickyParam: 'batch_id',
      pathSuffix: '/cancel',
    })
  );
};
