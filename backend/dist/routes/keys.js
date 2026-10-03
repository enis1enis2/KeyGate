import crypto from 'crypto';
import { ApiKeyRepo, ProviderRepo } from '../db/index.js';
import { encryptSecret, maskKey } from '../crypto.js';
import { CircuitBreakerManager } from '../engine/circuit-breaker.js';
export const keysRoutes = async (fastify) => {
    // List all keys with masked values and real-time health stats
    fastify.get('/api/keys', async (request, reply) => {
        const keys = ApiKeyRepo.getAll();
        const cb = CircuitBreakerManager.getInstance();
        const enriched = keys.map((k) => {
            const stats = cb.getKeyStats(k.id);
            return {
                ...stats,
                id: k.id,
                provider_id: k.provider_id,
                key_name: k.key_name,
                masked_key: `${k.key_prefix}...${k.key_suffix}`,
                rpm_cap: k.rpm_cap,
                tpm_cap: k.tpm_cap,
                daily_budget_cap: k.daily_budget_cap,
                daily_usage: k.daily_usage,
                created_at: k.created_at,
                updated_at: k.updated_at,
            };
        });
        return reply.send(enriched);
    });
    // Create upstream key (encrypted with AES-256-GCM)
    fastify.post('/api/keys', async (request, reply) => {
        const body = request.body;
        if (!body || !body.provider_id || !body.key_name || !body.api_key) {
            return reply.status(400).send({ error: 'Missing provider_id, key_name, or api_key.' });
        }
        const provider = ProviderRepo.getById(body.provider_id);
        if (!provider) {
            return reply.status(404).send({ error: 'Provider not found.' });
        }
        // Encrypt key with AES-256-GCM
        const encrypted = encryptSecret(body.api_key.trim());
        const mask = maskKey(body.api_key.trim());
        const keyId = crypto.randomUUID();
        ApiKeyRepo.create({
            id: keyId,
            provider_id: body.provider_id,
            key_name: body.key_name,
            encrypted_key: encrypted.encrypted,
            iv: encrypted.iv,
            tag: encrypted.tag,
            key_prefix: mask.prefix,
            key_suffix: mask.suffix,
            rpm_cap: body.rpm_cap || 0,
            tpm_cap: body.tpm_cap || 0,
            daily_budget_cap: body.daily_budget_cap || 0,
        });
        return reply.send({
            success: true,
            id: keyId,
            masked_key: mask.masked,
        });
    });
    // Update key status or caps
    fastify.put('/api/keys/:id', async (request, reply) => {
        const { id } = request.params;
        const body = request.body;
        const key = ApiKeyRepo.getById(id);
        if (!key)
            return reply.status(404).send({ error: 'Key not found' });
        if (body.reset_circuit) {
            CircuitBreakerManager.getInstance().resetCircuit(id);
        }
        if (body.is_active !== undefined) {
            ApiKeyRepo.toggleActive(id, body.is_active, body.is_active ? undefined : 'manually_disabled');
        }
        if (body.rpm_cap !== undefined || body.tpm_cap !== undefined || body.daily_budget_cap !== undefined) {
            ApiKeyRepo.updateCaps(id, body.rpm_cap !== undefined ? body.rpm_cap : key.rpm_cap, body.tpm_cap !== undefined ? body.tpm_cap : key.tpm_cap, body.daily_budget_cap !== undefined ? body.daily_budget_cap : key.daily_budget_cap);
        }
        return reply.send({ success: true });
    });
    // Delete key
    fastify.delete('/api/keys/:id', async (request, reply) => {
        const { id } = request.params;
        const deleted = ApiKeyRepo.delete(id);
        return reply.send({ success: deleted });
    });
};
