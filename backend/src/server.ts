import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import multipart from '@fastify/multipart';
import path from 'path';
import fs from 'fs';

import { CONFIG } from './config.js';
import {
  authenticateAdmin,
  authenticateGatewayKey,
  isDataPlanePath,
  isManagementPath,
  sendAuthError,
} from './auth.js';
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
import { historyRoutes } from './routes/history.js';
import { metricsRoutes } from './routes/metrics.js';
import { healthRoutes } from './routes/health.js';
import { RequestLogRepo, StickyRouteRepo, ChatHistoryRepo } from './db/index.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: CONFIG.logLevel,
    },
    // DECISION: Behind a reverse proxy the socket address is the proxy, so rate limiting and
    // request logs would all share one bucket. Trust is opt-in via TRUST_PROXY because trusting
    // every hop on a directly exposed server lets clients spoof X-Forwarded-For.
    trustProxy: CONFIG.trustProxy,
  });

  // DECISION: Security headers are set centrally instead of pulling in helmet. The console is a
  // same-origin SPA with no third-party scripts, so a tight CSP is compatible and removes a whole
  // class of XSS impact even if a rendering bug slips through.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');

  fastify.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
    // HSTS is only meaningful (and only safe) on a TLS connection.
    if (CONFIG.enableHsts && request.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // DECISION: Errors raised by Fastify itself (validation, rate limit, not found) bypass the route
  // handlers, so a dedicated handler keeps the /v1 surface speaking the OpenAI error envelope and
  // stops internal exception messages from leaking to data-plane callers.
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' && error.statusCode >= 400
      ? error.statusCode
      : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error, url: request.url }, 'Unhandled request error');
    }

    if (request.url.startsWith('/v1')) {
      const type =
        statusCode >= 500 ? 'api_error'
          : statusCode === 429 ? 'rate_limit_error'
            : 'invalid_request_error';
      const code =
        statusCode === 429 ? 'rate_limit_exceeded'
          : statusCode === 400 ? 'invalid_request_error'
            : 'internal_error';
      const message =
        statusCode >= 500
          ? 'Internal server error.'
          : statusCode === 429
            ? 'Rate limit exceeded. Try again later.'
            : error.message;

      return reply.status(statusCode).send({
        error: { message, type, param: null, code },
      });
    }

    return reply.status(statusCode).send({ error: error.message });
  });

  await fastify.register(sensible);

  // DECISION: The route JSON Schemas are the API contract, so the OpenAPI document is generated
  // from them instead of a hand-maintained file that drifts. It is served behind the admin auth
  // hook at /api/openapi.json rather than being world-readable.
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'KeyGate API',
        version: '1.0.0',
        description:
          'Self-hosted AI API pool gateway. /v1/* is the OpenAI-compatible data plane and uses ' +
          'a gateway key (kg-live-...); /api/* is the management plane and uses the admin token.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          adminToken: { type: 'http', scheme: 'bearer' },
          gatewayToken: { type: 'http', scheme: 'bearer' },
        },
      },
      tags: [
        { name: 'management', description: 'Admin console API (admin bearer token).' },
        { name: 'gateway', description: 'OpenAI-compatible data plane (gateway bearer token).' },
      ],
    },
  });

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
  // The hook compares the *normalized* pathname because the router accepts percent-encoded
  // and absolute-form request targets that a raw-string check would miss.
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

  // DECISION: Authenticate the gateway bearer token before Fastify parses or buffers any
  // request body. Pool scope and rpm/tpm quotas still run inside each route (they need the
  // parsed body), but an unauthenticated caller can no longer force JSON parsing or up to
  // MAX_UPLOAD_BYTES × files of multipart buffering per request.
  fastify.addHook('onRequest', async (request, reply) => {
    if (!isDataPlanePath(request.url)) return;

    const auth = authenticateGatewayKey(request);
    if (!auth.authenticated) {
      return sendAuthError(reply, auth);
    }
  });

  // DECISION: Baseline hardening headers for the SPA and JSON responses. Streaming/binary
  // responses that write to reply.raw bypass these, which is harmless for SSE/audio bodies.
  fastify.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
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
  await fastify.register(historyRoutes);

  // Generated after every route is registered: fastify.swagger() reads the collected schemas.
  fastify.get('/api/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    return reply.send(fastify.swagger());
  });

  // DECISION: Serve built frontend SPA statically from public/ with SPA HTML fallback for seamless single-binary deployment.
  const publicDir = path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    await fastify.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      setHeaders: (reply, filePath) => {
        // Vite emits content-hashed asset filenames, so they can be cached forever. The HTML
        // shell must never be cached or clients keep loading stale bundle references.
        if (filePath.endsWith('index.html')) {
          reply.header('Cache-Control', 'no-cache');
        } else if (/\.(?:js|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|map)$/i.test(filePath)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
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
      const oldHistory = ChatHistoryRepo.purgeOlderThan(CONFIG.metricsRetentionDays);
      if (oldHistory > 0) {
        console.log(`[Retention] Purged ${oldHistory} chat history entries older than ${CONFIG.metricsRetentionDays} days.`);
      }
    } catch (err) {
      console.error('[Retention] Failed to purge old logs:', err instanceof Error ? err.message : err);
    }
  }, 24 * 60 * 60 * 1000);
}
