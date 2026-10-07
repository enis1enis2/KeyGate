import type { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { ModelAliasRepo } from '../db/index.js';
import type { TargetConfig, RoutingStrategy, EndpointKind } from '../types/index.js';

const ENDPOINT_KINDS: readonly EndpointKind[] = [
  'chat',
  'responses',
  'completions',
  'embeddings',
  'images',
  'audio',
  'moderations',
  'batches',
];

function toEndpointKind(value: unknown): EndpointKind {
  return ENDPOINT_KINDS.includes(value as EndpointKind) ? (value as EndpointKind) : 'chat';
}

export const aliasesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all aliases
  fastify.get('/api/aliases', async (request, reply) => {
    const list = ModelAliasRepo.getAll();
    const parsed = list.map((a) => {
      let targets: TargetConfig[] = [];
      try {
        targets = JSON.parse(a.targets_json);
      } catch {
        // Malformed persisted JSON: fall back to an empty target list.
      }
      return {
        ...a,
        targets,
      };
    });
    return reply.send(parsed);
  });

  // Upsert alias
  fastify.post('/api/aliases', async (request, reply) => {
    const body = request.body as {
      id?: string;
      alias_name: string;
      strategy?: RoutingStrategy;
      targets: TargetConfig[];
      description?: string | null;
      endpoint_kind?: string;
      daily_token_cap?: number;
      daily_spend_cap?: number;
      hedging_enabled?: boolean;
      hedged_delay_ms?: number;
      timeout_ms?: number;
      is_active?: boolean;
    };

    if (!body || !body.alias_name || !body.targets || !Array.isArray(body.targets)) {
      return reply.status(400).send({ error: 'Missing alias_name or targets array.' });
    }

    const id = body.id || crypto.randomUUID();
    ModelAliasRepo.upsert({
      id,
      alias_name: body.alias_name.trim(),
      strategy: body.strategy || 'weighted-by-health',
      targets_json: JSON.stringify(body.targets),
      description: body.description ? String(body.description).slice(0, 500) : null,
      endpoint_kind: toEndpointKind(body.endpoint_kind),
      daily_token_cap: Math.max(0, Number(body.daily_token_cap) || 0),
      daily_spend_cap: Math.max(0, Number(body.daily_spend_cap) || 0),
      hedging_enabled: body.hedging_enabled || false,
      hedged_delay_ms: body.hedged_delay_ms || 500,
      timeout_ms: body.timeout_ms || 30000,
      is_active: body.is_active !== undefined ? body.is_active : true,
    });

    return reply.send({ success: true, id });
  });

  // Delete alias
  fastify.delete('/api/aliases/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = ModelAliasRepo.delete(id);
    return reply.send({ success: deleted });
  });
};
