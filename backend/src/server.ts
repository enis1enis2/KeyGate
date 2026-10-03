import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { CONFIG } from './config.js';
import { chatRoutes } from './routes/chat.js';
import { modelsRoutes } from './routes/models.js';
import { embeddingsRoutes } from './routes/embeddings.js';
import { passthroughRoutes } from './routes/passthrough.js';
import { providersRoutes } from './routes/providers.js';
import { keysRoutes } from './routes/keys.js';
import { aliasesRoutes } from './routes/aliases.js';
import { gatewayKeysRoutes } from './routes/gateway-keys.js';
import { logsRoutes } from './routes/logs.js';
import { metricsRoutes } from './routes/metrics.js';
import { healthRoutes } from './routes/health.js';
import { RequestLogRepo, closeDb } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: CONFIG.logLevel,
    },
  });

  // Enable CORS
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  await fastify.register(sensible);

  // Register API Routes
  await fastify.register(healthRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(modelsRoutes);
  await fastify.register(embeddingsRoutes);
  await fastify.register(passthroughRoutes);
  await fastify.register(providersRoutes);
  await fastify.register(keysRoutes);
  await fastify.register(aliasesRoutes);
  await fastify.register(gatewayKeysRoutes);
  await fastify.register(logsRoutes);

  // DECISION: Serve built frontend SPA statically from public/ with SPA HTML fallback for seamless single-binary deployment.
  const publicDir = path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    await fastify.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
    });

    // SPA fallback: any non-API route serves index.html
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/v1')) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return fastify;
}

// DECISION: Schedule automatic 30-day retention cleanup routine running once every 24 hours.
export function startRetentionCron(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const purged = RequestLogRepo.purgeOldLogs(CONFIG.metricsRetentionDays);
      if (purged > 0) {
        console.log(`[Retention] Purged ${purged} logs older than ${CONFIG.metricsRetentionDays} days.`);
      }
    } catch (err: any) {
      console.error('[Retention] Failed to purge old logs:', err.message);
    }
  }, 24 * 60 * 60 * 1000);
}
