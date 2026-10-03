import { authenticateGatewayKey } from './chat.js';
import { SmartRouter } from '../engine/router.js';
import { decryptSecret } from '../crypto.js';
import { TemplateMapper } from '../engine/mapper.js';
import { CircuitBreakerManager } from '../engine/circuit-breaker.js';
export const passthroughRoutes = async (fastify) => {
    // DECISION: Support all HTTP methods for passthrough to accommodate arbitrary endpoints (images, audio, embeddings, fine-tuning).
    fastify.all('/v1/passthrough/:provider/*', async (request, reply) => {
        const auth = authenticateGatewayKey(request);
        if (!auth.authenticated) {
            return reply.status(401).send({ error: { message: auth.error || 'Unauthorized' } });
        }
        const { provider } = request.params;
        const wildcard = request.params['*'] || '';
        const router = SmartRouter.getInstance();
        const spec = router.getProviderSpec(provider);
        if (!spec) {
            return reply.status(404).send({ error: { message: `Provider '${provider}' not found or inactive.` } });
        }
        const candidateKeys = router.getCandidateKeys(provider);
        if (candidateKeys.length === 0) {
            return reply.status(503).send({ error: { message: `No healthy active keys available for provider '${provider}'.` } });
        }
        const selectedKey = candidateKeys[0].key;
        const decryptedKey = decryptSecret(selectedKey.encrypted_key, selectedKey.iv, selectedKey.tag);
        // Build target upstream URL
        const targetUrl = `${spec.base_url.replace(/\/+$/, '')}/${wildcard.replace(/^\/+/, '')}`;
        // Pass through headers while stripping host
        const forwardHeaders = {};
        for (const [k, v] of Object.entries(request.headers)) {
            const lower = k.toLowerCase();
            if (lower !== 'host' && lower !== 'authorization' && lower !== 'content-length' && v) {
                forwardHeaders[k] = Array.isArray(v) ? v[0] : v;
            }
        }
        // Apply upstream auth
        const authed = TemplateMapper.applyAuth(spec, decryptedKey, targetUrl, forwardHeaders, request.body);
        const startTime = Date.now();
        try {
            const fetchOpts = {
                method: request.method,
                headers: authed.headers,
            };
            if (['POST', 'PUT', 'PATCH'].includes(request.method.toUpperCase()) && authed.bodyObj !== undefined) {
                fetchOpts.body = typeof authed.bodyObj === 'string' ? authed.bodyObj : JSON.stringify(authed.bodyObj);
            }
            const upstreamRes = await fetch(authed.url, fetchOpts);
            const latencyMs = Date.now() - startTime;
            CircuitBreakerManager.getInstance().recordCallResult(selectedKey.id, upstreamRes.ok, latencyMs);
            // Copy response headers
            upstreamRes.headers.forEach((val, k) => {
                if (!['content-encoding', 'transfer-encoding'].includes(k.toLowerCase())) {
                    reply.header(k, val);
                }
            });
            const responseBuffer = await upstreamRes.arrayBuffer();
            return reply.status(upstreamRes.status).send(Buffer.from(responseBuffer));
        }
        catch (err) {
            CircuitBreakerManager.getInstance().recordCallResult(selectedKey.id, false, Date.now() - startTime);
            return reply.status(502).send({ error: { message: `Passthrough failed: ${err.message}` } });
        }
    });
};
