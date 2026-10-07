import type { FastifyPluginAsync } from 'fastify';
import { ModelAliasRepo, ProviderRepo } from '../db/index.js';
import { authorizeGatewayKey, isAliasAllowed, sendAuthError } from '../auth.js';
import { CONFIG } from '../config.js';
import yaml from 'yaml';
import type { ProviderSpec, GatewayKeyRecord } from '../types/index.js';

export const modelsRoutes: FastifyPluginAsync = async (fastify) => {
  // DECISION: The model list is scoped per gateway key, so a key restricted to certain pools
  // never even learns that other pools exist.
  fastify.get('/v1/models', {
    config: { rateLimit: { max: CONFIG.rateLimit.v1Max } },
  }, async (request, reply) => {
    const auth = authorizeGatewayKey(request);
    if (!auth.authenticated) {
      return sendAuthError(reply, auth);
    }

    const key: GatewayKeyRecord | undefined = auth.key;
    const visible = (name: string): boolean => (key ? isAliasAllowed(key, name) : true);

    const aliases = ModelAliasRepo.getAll().filter((a) => a.is_active && visible(a.alias_name));
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
            if (visible(key)) modelSet.add(key);
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
