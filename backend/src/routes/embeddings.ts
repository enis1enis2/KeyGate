import type { FastifyPluginAsync } from 'fastify';
import { authenticateGatewayKey } from './chat.js';
import { SmartRouter } from '../engine/router.js';
import { ProviderRepo, ApiKeyRepo } from '../db/index.js';
import { decryptSecret } from '../crypto.js';
import { TemplateMapper } from '../engine/mapper.js';
import { CircuitBreakerManager } from '../engine/circuit-breaker.js';

export const embeddingsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/v1/embeddings', async (request, reply) => {
    const auth = authenticateGatewayKey(request);
    if (!auth.authenticated) {
      return reply.status(401).send({ error: { message: auth.error || 'Unauthorized' } });
    }

    const body = request.body as { model: string; input: string | string[] };
    if (!body || !body.model || !body.input) {
      return reply.status(400).send({ error: { message: 'Missing model or input in request body.' } });
    }

    const router = SmartRouter.getInstance();
    const providers = ProviderRepo.getAll().filter((p) => p.is_active);

    // Look for a provider supporting embeddings
    let targetSpec: any = null;
    let targetKey: any = null;

    for (const p of providers) {
      const spec = router.getProviderSpec(p.id);
      if (spec && spec.endpoint_paths?.embeddings) {
        const candidateKeys = router.getCandidateKeys(spec.id);
        if (candidateKeys.length > 0) {
          targetSpec = spec;
          targetKey = candidateKeys[0]!.key;
          break;
        }
      }
    }

    if (!targetSpec || !targetKey) {
      return reply.status(503).send({
        error: { message: 'No healthy provider found configured with an embeddings endpoint.' },
      });
    }

    const decryptedKey = decryptSecret(targetKey.encrypted_key, targetKey.iv, targetKey.tag);
    const embPath = targetSpec.endpoint_paths.embeddings || '/embeddings';
    const targetUrl = targetSpec.base_url.replace(/\/+$/, '') + '/' + embPath.replace(/^\/+/, '');

    const authed = TemplateMapper.applyAuth(
      targetSpec,
      decryptedKey,
      targetUrl,
      { 'Content-Type': 'application/json' },
      body
    );

    const startTime = Date.now();
    try {
      const resp = await fetch(authed.url, {
        method: 'POST',
        headers: authed.headers,
        body: JSON.stringify(authed.bodyObj),
      });

      const latencyMs = Date.now() - startTime;
      const json = await resp.json();

      CircuitBreakerManager.getInstance().recordCallResult(targetKey.id, resp.ok, latencyMs);
      return reply.status(resp.status).send(json);
    } catch (err: any) {
      CircuitBreakerManager.getInstance().recordCallResult(targetKey.id, false, Date.now() - startTime);
      return reply.status(502).send({ error: { message: err.message || 'Upstream error' } });
    }
  });
};
