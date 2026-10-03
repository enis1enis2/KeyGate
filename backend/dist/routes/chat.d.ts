import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
export declare function authenticateGatewayKey(req: FastifyRequest): {
    authenticated: boolean;
    keyId?: string;
    error?: string;
};
export declare const chatRoutes: FastifyPluginAsync;
