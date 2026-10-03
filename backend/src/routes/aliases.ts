import type { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { ModelAliasRepo } from '../db/index.js';
import type { TargetConfig, RoutingStrategy } from '../types/index.js';

export const aliasesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all aliases
  fastify.get('/api/aliases', async (request, reply) => {
    const list = ModelAliasRepo.getAll();
    const parsed = list.map((a) => {
      let targets: TargetConfig[] = [];
      try {
        targets = JSON.parse(a.targets_json);
      } catch {}
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
