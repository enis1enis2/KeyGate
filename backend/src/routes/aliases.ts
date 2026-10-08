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
      let tiers: unknown[] = [];
      try {
        tiers = JSON.parse(a.tiers_json || '[]');
      } catch {
        // Malformed persisted JSON: fall back to an empty tier list.
      }
      return {
        ...a,
        targets,
        tiers,
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
      search_enabled?: boolean;
      search_provider?: string;
      search_max_results?: number;
      search_max_rounds?: number;
      search_off_notice?: boolean;
      classifier_provider_id?: string | null;
      classifier_model?: string | null;
      tiers?: unknown;
    };

    if (!body || !body.alias_name || !body.targets || !Array.isArray(body.targets)) {
      return reply.status(400).send({ error: 'Missing alias_name or targets array.' });
    }

    const SEARCH_PROVIDERS = ['duckduckgo', 'wikipedia'];
    const searchProvider = SEARCH_PROVIDERS.includes(body.search_provider as string)
      ? (body.search_provider as string)
      : 'duckduckgo';

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
      search_enabled: body.search_enabled || false,
      search_provider: searchProvider,
      search_max_results: Math.max(1, Math.min(10, Number(body.search_max_results) || 3)),
      search_max_rounds: Math.max(0, Math.min(5, Number(body.search_max_rounds) || 3)),
      search_off_notice: body.search_off_notice || false,
      classifier_provider_id: body.classifier_provider_id ? String(body.classifier_provider_id) : null,
      classifier_model: body.classifier_model ? String(body.classifier_model) : null,
      tiers_json: Array.isArray(body.tiers) ? JSON.stringify(body.tiers) : '[]',
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
