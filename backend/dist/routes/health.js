import { getDb, ApiKeyRepo } from '../db/index.js';
export const healthRoutes = async (fastify) => {
    fastify.get('/healthz', async (request, reply) => {
        let dbStatus = 'ok';
        let activeKeys = 0;
        try {
            const db = getDb();
            db.prepare('SELECT 1').get();
            activeKeys = ApiKeyRepo.getAll().filter((k) => k.is_active).length;
        }
        catch (err) {
            dbStatus = `error: ${err.message}`;
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
