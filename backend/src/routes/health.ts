import type { FastifyPluginAsync } from 'fastify';
import { getDb, ApiKeyRepo } from '../db/index.js';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/healthz', async (request, reply) => {
    let dbStatus = 'ok';
    let activeKeys = 0;

    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      activeKeys = ApiKeyRepo.getAll().filter((k) => k.is_active).length;
    } catch {
      // DECISION: The probe stays unauthenticated, so it must not echo driver error text
      // (which can include filesystem paths) to an anonymous caller. Detail goes to the
      // server log only.
      dbStatus = 'error';
      console.error('[Health] Database probe failed on /healthz');
    }

    const isHealthy = dbStatus === 'ok';
    return reply.status(isHealthy ? 200 : 503).send({
      status: isHealthy ? 'healthy' : 'unhealthy',
      uptimeSeconds: Math.floor(process.uptime()),
      database: dbStatus,
      activeKeys,
      timestamp: new Date().toISOString(),
    });
  });
};
