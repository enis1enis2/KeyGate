import type { FastifyPluginAsync } from 'fastify';
import { ChatHistoryRepo } from '../db/index.js';

// Per-pool chat history: prompt/answer pairs captured from gateway chat completions.
// Only message text is exposed here — no request headers, secrets, or raw bodies.
export const historyRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/history', async (request, reply) => {
    const query = request.query as { pool?: string; limit?: string };
    const poolName = typeof query.pool === 'string' && query.pool ? query.pool : undefined;
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));

    const entries = ChatHistoryRepo.getByPool(poolName, limit);
    const pools = poolName
      ? ChatHistoryRepo.getPools()
      : ChatHistoryRepo.getPools();

    return reply.send({ entries, pools });
  });

  fastify.get('/api/history/pools', async (request, reply) => {
    return reply.send(ChatHistoryRepo.getPools());
  });

  fastify.delete('/api/history/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = ChatHistoryRepo.deleteById(id);
    return reply.send({ success: deleted });
  });

  fastify.delete('/api/history', async (request, reply) => {
    const query = request.query as { pool?: string };
    if (typeof query.pool === 'string' && query.pool) {
      const removed = ChatHistoryRepo.deleteByPool(query.pool);
      return reply.send({ success: true, removed });
    }
    const removed = ChatHistoryRepo.clearAll();
    return reply.send({ success: true, removed });
  });
};