import type { FastifyPluginAsync } from 'fastify';
import { PricingRepo } from '../db/index.js';
import type { ModelPricingRecord } from '../types/index.js';

// DECISION: Pricing rows are admin-managed data under /api, so they inherit the admin
// onRequest hook registered in server.ts and are never reachable from gateway keys.
export const pricingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/pricing', async (request, reply) => {
    return reply.send(PricingRepo.getAll());
  });

  fastify.post('/api/pricing', async (request, reply) => {
    const body = request.body as Partial<ModelPricingRecord>;

    if (!body || !body.provider_id || !body.model) {
      return reply.status(400).send({ error: 'provider_id and model are required.' });
    }

    const input = Number(body.input_per_mtok);
    const output = Number(body.output_per_mtok);
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      return reply.status(400).send({ error: 'input_per_mtok and output_per_mtok must be non-negative numbers.' });
    }

    const id = PricingRepo.upsert({
      id: body.id,
      provider_id: String(body.provider_id).trim(),
      model: String(body.model).trim(),
      input_per_mtok: input,
      output_per_mtok: output,
    });

    return reply.send({ success: true, id });
  });

  fastify.delete('/api/pricing/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ success: PricingRepo.delete(id) });
  });
};
