import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import path from 'path';
import fs from 'fs';

import { CONFIG } from './config.js';
import { authenticateAdmin, isManagementPath } from './auth.js';
import { chatRoutes } from './routes/chat.js';
import { modelsRoutes } from './routes/models.js';
import { embeddingsRoutes } from './routes/embeddings.js';
import { passthroughRoutes } from './routes/passthrough.js';
import { openaiSurfaceRoutes } from './routes/openai-surface.js';
import { providersRoutes } from './routes/providers.js';
import { keysRoutes } from './routes/keys.js';
import { aliasesRoutes } from './routes/aliases.js';
import { pricingRoutes } from './routes/pricing.js';
import { gatewayKeysRoutes } from './routes/gateway-keys.js';
import { logsRoutes } from './routes/logs.js';
import { metricsRoutes } from './routes/metrics.js';
import { healthRoutes } from './routes/health.js';
import { RequestLogRepo, StickyRouteRepo } from './db/index.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: CONFIG.logLevel,
    },
  });

  await fastify.register(sensible);

  // DECISION: Rate limit every route by client IP, with a tighter budget on the /v1 data plane.
  await fastify.register(rateLimit, {
    global: true,
    max: CONFIG.rateLimit.globalMax,
    timeWindow: CONFIG.rateLimit.timeWindowMs,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (request, context) => ({
      error: `Rate limit exceeded: retry in ${context.after}`,
    }),
  });

  // DECISION: CORS defaults to same-origin only. The SPA is served by this same Fastify
  // instance, so no cross-origin access is needed unless CORS_ORIGINS is explicitly set.
  // Credentials are disabled because both auth schemes use Bearer tokens, not cookies.
  await fastify.register(cors, {
    origin: CONFIG.corsOrigins.length > 0 ? CONFIG.corsOrigins : false,
    credentials: false,
  });

  // DECISION: The management API is a separate trust boundary from /v1. Registering the
  // hook before any route guarantees every /api/* and /metrics request is authenticated.
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isManagementPath(request.url)) return;

    const auth = authenticateAdmin(request);
    if (!auth.authenticated) {
      return reply
        .header('WWW-Authenticate', 'Bearer')
        .status(401)
        .send({ error: auth.error || 'Unauthorized' });
    }
  });

  // DECISION: Multipart bodies are parsed so pool scope can be enforced on image/audio
  // requests, then re-serialized by engine/proxy.ts; the size cap bounds gateway memory.
  await fastify.register(multipart, {
    limits: {
      fileSize: CONFIG.maxUploadBytes,
      files: 8,
      fields: 64,
    },
  });

  // Register API Routes
  await fastify.register(healthRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(chatRoutes);
  await fastify.register(modelsRoutes);
  await fastify.register(embeddingsRoutes);
  await fastify.register(passthroughRoutes);
  await fastify.register(openaiSurfaceRoutes);
  await fastify.register(providersRoutes);
  await fastify.register(keysRoutes);
  await fastify.register(aliasesRoutes);
  await fastify.register(pricingRoutes);
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
      const unpinned = StickyRouteRepo.purgeOlderThan(CONFIG.metricsRetentionDays);
      if (unpinned > 0) {
        console.log(`[Retention] Purged ${unpinned} expired upstream resource routes.`);
      }
    } catch (err) {
      console.error('[Retention] Failed to purge old logs:', err instanceof Error ? err.message : err);
    }
  }, 24 * 60 * 60 * 1000);
}
