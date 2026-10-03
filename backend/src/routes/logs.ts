import type { FastifyPluginAsync } from 'fastify';
import { RequestLogRepo } from '../db/index.js';

export const logsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/logs', async (request, reply) => {
    const query = request.query as {
      limit?: string;
      status?: string;
      provider_id?: string;
      model?: string;
    };

    const limit = query.limit ? parseInt(query.limit, 10) : 100;
    const logs = RequestLogRepo.getRecent(limit, {
      status: query.status,
      provider_id: query.provider_id,
      model: query.model,
    });

    return reply.send(logs);
  });
};
