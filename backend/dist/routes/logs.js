import { RequestLogRepo } from '../db/index.js';
export const logsRoutes = async (fastify) => {
    fastify.get('/api/logs', async (request, reply) => {
        const query = request.query;
        const limit = query.limit ? parseInt(query.limit, 10) : 100;
        const logs = RequestLogRepo.getRecent(limit, {
            status: query.status,
            provider_id: query.provider_id,
            model: query.model,
        });
        return reply.send(logs);
    });
};
