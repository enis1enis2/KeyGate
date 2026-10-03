import crypto from 'crypto';
import { GatewayKeyRepo } from '../db/index.js';
import { generateGatewayToken } from '../crypto.js';
export const gatewayKeysRoutes = async (fastify) => {
    // List all gateway keys
    fastify.get('/api/gateway-keys', async (request, reply) => {
        const list = GatewayKeyRepo.getAll();
        const mapped = list.map((k) => ({
            id: k.id,
            name: k.name,
            masked_token: `${k.token_prefix}...${k.token_suffix}`,
            is_active: Boolean(k.is_active),
            rpm_limit: k.rpm_limit,
            tpm_limit: k.tpm_limit,
            allowed_aliases: JSON.parse(k.allowed_aliases_json || '["*"]'),
            expires_at: k.expires_at,
            created_at: k.created_at,
        }));
        return reply.send(mapped);
    });
    // Generate new gateway key
    fastify.post('/api/gateway-keys', async (request, reply) => {
        const body = request.body;
        if (!body || !body.name) {
            return reply.status(400).send({ error: 'Missing key name.' });
        }
        const { rawToken, tokenHash, tokenPrefix, tokenSuffix } = generateGatewayToken('kg-live');
        const id = crypto.randomUUID();
        const expiresAt = body.expires_in_days ? Date.now() + body.expires_in_days * 86400000 : null;
        GatewayKeyRepo.create({
            id,
            name: body.name.trim(),
            token_hash: tokenHash,
            token_prefix: tokenPrefix,
            token_suffix: tokenSuffix,
            rpm_limit: body.rpm_limit || 0,
            tpm_limit: body.tpm_limit || 0,
            allowed_aliases_json: JSON.stringify(body.allowed_aliases || ['*']),
            expires_at: expiresAt,
        });
        // DECISION: Return raw secret token once to client on creation; only hashed token is stored.
        return reply.send({
            success: true,
            id,
            name: body.name,
            token: rawToken,
            masked_token: `${tokenPrefix}...${tokenSuffix}`,
        });
    });
    // Revoke key
    fastify.post('/api/gateway-keys/:id/revoke', async (request, reply) => {
        const { id } = request.params;
        const revoked = GatewayKeyRepo.revoke(id);
        return reply.send({ success: revoked });
    });
    // Delete key
    fastify.delete('/api/gateway-keys/:id', async (request, reply) => {
        const { id } = request.params;
        const deleted = GatewayKeyRepo.delete(id);
        return reply.send({ success: deleted });
    });
};
