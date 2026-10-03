import type { FastifyPluginAsync } from 'fastify';
import { ModelAliasRepo, ProviderRepo } from '../db/index.js';
import yaml from 'yaml';
import type { ProviderSpec } from '../types/index.js';

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/v1/models', async (request, reply) => {
    const aliases = ModelAliasRepo.getAll().filter((a) => a.is_active);
    const providers = ProviderRepo.getAll().filter((p) => p.is_active);

    const modelSet = new Set<string>();

    // Add configured aliases
    for (const a of aliases) {
      modelSet.add(a.alias_name);
    }

    // Add provider mapped models
    for (const p of providers) {
      try {
        const spec = yaml.parse(p.spec_yaml) as ProviderSpec;
        if (spec.model_name_map) {
          for (const key of Object.keys(spec.model_name_map)) {
            modelSet.add(key);
          }
        }
      } catch {
        // ignore parse error
      }
    }

    // Ensure at least default common models if none yet configured
    if (modelSet.size === 0) {
      modelSet.add('default');
    }

    const data = Array.from(modelSet).map((m) => ({
      id: m,
      object: 'model',
      created: 1700000000,
      owned_by: 'keygate',
      permission: [],
      root: m,
      parent: null,
    }));

    return reply.send({
      object: 'list',
      data,
    });
  });
};
