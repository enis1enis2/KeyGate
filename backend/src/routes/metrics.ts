import type { FastifyPluginAsync } from 'fastify';
import client from 'prom-client';
import { RequestLogRepo, ApiKeyRepo, ProviderRepo } from '../db/index.js';
import { CircuitBreakerManager } from '../engine/circuit-breaker.js';
import {
  registry,
  spendTodayGauge,
  poolSpendTodayGauge,
  poolTokensTodayGauge,
} from '../metrics.js';

const keyHealthGauge = new client.Gauge({
  name: 'keygate_key_success_rate_percent',
  help: 'Rolling success rate percent per API key',
  labelNames: ['key_id', 'provider'],
  registers: [registry],
});

const circuitStateGauge = new client.Gauge({
  name: 'keygate_circuit_breaker_state',
  help: 'Circuit breaker state (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)',
  labelNames: ['key_id', 'provider'],
  registers: [registry],
});

export const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  // Prometheus exposition format endpoint
  fastify.get('/metrics', async (request, reply) => {
    // Update live metrics from circuit breaker before scraping
    const keys = ApiKeyRepo.getAll();
    const cb = CircuitBreakerManager.getInstance();

    for (const key of keys) {
      const stats = cb.getKeyStats(key.id);
      keyHealthGauge.set(
        { key_id: key.id, provider: key.provider_id },
        stats.rolling_success_rate
      );

      const stateVal = stats.circuit_state === 'CLOSED' ? 0 : stats.circuit_state === 'HALF_OPEN' ? 1 : 2;
      circuitStateGauge.set(
        { key_id: key.id, provider: key.provider_id },
        stateVal
      );
    }

    // Spend gauges are derived from request_logs so they survive a process restart.
    spendTodayGauge.set(RequestLogRepo.getSpendTodayTotal());
    poolSpendTodayGauge.reset();
    poolTokensTodayGauge.reset();
    for (const row of RequestLogRepo.getPoolUsageTodayAll()) {
      poolSpendTodayGauge.set({ pool: row.pool }, row.spend);
      poolTokensTodayGauge.set({ pool: row.pool }, row.tokens);
    }

    const metricsStr = await registry.metrics();
    return reply.header('Content-Type', registry.contentType).send(metricsStr);
  });

  // Management UI Dashboard stats
  fastify.get('/api/dashboard/stats', async (request, reply) => {
    const summary = RequestLogRepo.getStatsSummary();
    const keys = ApiKeyRepo.getAll();
    const providers = ProviderRepo.getAll();
    const cb = CircuitBreakerManager.getInstance();

    let openCircuits = 0;
    let halfOpenCircuits = 0;
    let closedCircuits = 0;

    const allLatencies: number[] = [];

    for (const k of keys) {
      const stats = cb.getKeyStats(k.id);
      if (stats.circuit_state === 'OPEN') openCircuits++;
      else if (stats.circuit_state === 'HALF_OPEN') halfOpenCircuits++;
      else closedCircuits++;

      if (stats.latency_p50 > 0) allLatencies.push(stats.latency_p50);
    }

    allLatencies.sort((a, b) => a - b);
    const overallP50 = allLatencies.length > 0 ? allLatencies[Math.floor(allLatencies.length * 0.5)] || 0 : 0;
    const overallP95 = allLatencies.length > 0 ? allLatencies[Math.floor(allLatencies.length * 0.95)] || 0 : 0;

    const successPercent = summary.totalRequests > 0
      ? Math.round((summary.successRequests / summary.totalRequests) * 100)
      : 100;

    const budgetedKeys = keys
      .filter((k) => k.daily_budget_cap > 0)
      .map((k) => ({
        id: k.id,
        name: k.key_name,
        provider: k.provider_id,
        daily_budget_cap: k.daily_budget_cap,
        spend_today: RequestLogRepo.getSpendByKeyToday(k.id),
      }));

    return reply.send({
      totalRequests: summary.totalRequests,
      successRequests: summary.successRequests,
      errorRequests: summary.errorRequests,
      successRate: successPercent,
      avgLatencyMs: summary.avgLatencyMs,
      p50LatencyMs: overallP50,
      p95LatencyMs: overallP95,
      totalPromptTokens: summary.totalPromptTokens,
      totalCompletionTokens: summary.totalCompletionTokens,
      totalKeys: keys.length,
      activeKeys: keys.filter((k) => k.is_active).length,
      totalProviders: providers.length,
      spendToday: RequestLogRepo.getSpendTodayTotal(),
      poolUsageToday: RequestLogRepo.getPoolUsageTodayAll(),
      budgetedKeys,
      circuits: {
        closed: closedCircuits,
        halfOpen: halfOpenCircuits,
        open: openCircuits,
      },
    });
  });
};
