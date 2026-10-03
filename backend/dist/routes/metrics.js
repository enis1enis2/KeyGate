import client from 'prom-client';
import { RequestLogRepo, ApiKeyRepo, ProviderRepo } from '../db/index.js';
import { CircuitBreakerManager } from '../engine/circuit-breaker.js';
// Setup Prometheus Registry and default metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'keygate_' });
// Custom Prometheus Gauges & Counters
const requestCounter = new client.Counter({
    name: 'keygate_requests_total',
    help: 'Total count of requests processed by KeyGate',
    labelNames: ['provider', 'model', 'status'],
    registers: [register],
});
const keyHealthGauge = new client.Gauge({
    name: 'keygate_key_success_rate_percent',
    help: 'Rolling success rate percent per API key',
    labelNames: ['key_id', 'provider'],
    registers: [register],
});
const circuitStateGauge = new client.Gauge({
    name: 'keygate_circuit_breaker_state',
    help: 'Circuit breaker state (0 = CLOSED, 1 = HALF_OPEN, 2 = OPEN)',
    labelNames: ['key_id', 'provider'],
    registers: [register],
});
export const metricsRoutes = async (fastify) => {
    // Prometheus exposition format endpoint
    fastify.get('/metrics', async (request, reply) => {
        // Update live metrics from circuit breaker before scraping
        const keys = ApiKeyRepo.getAll();
        const cb = CircuitBreakerManager.getInstance();
        for (const key of keys) {
            const stats = cb.getKeyStats(key.id);
            keyHealthGauge.set({ key_id: key.id, provider: key.provider_id }, stats.rolling_success_rate);
            const stateVal = stats.circuit_state === 'CLOSED' ? 0 : stats.circuit_state === 'HALF_OPEN' ? 1 : 2;
            circuitStateGauge.set({ key_id: key.id, provider: key.provider_id }, stateVal);
        }
        const metricsStr = await register.metrics();
        return reply.header('Content-Type', register.contentType).send(metricsStr);
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
        const allLatencies = [];
        for (const k of keys) {
            const stats = cb.getKeyStats(k.id);
            if (stats.circuit_state === 'OPEN')
                openCircuits++;
            else if (stats.circuit_state === 'HALF_OPEN')
                halfOpenCircuits++;
            else
                closedCircuits++;
            if (stats.latency_p50 > 0)
                allLatencies.push(stats.latency_p50);
        }
        allLatencies.sort((a, b) => a - b);
        const overallP50 = allLatencies.length > 0 ? allLatencies[Math.floor(allLatencies.length * 0.5)] || 0 : 0;
        const overallP95 = allLatencies.length > 0 ? allLatencies[Math.floor(allLatencies.length * 0.95)] || 0 : 0;
        const successPercent = summary.totalRequests > 0
            ? Math.round((summary.successRequests / summary.totalRequests) * 100)
            : 100;
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
            circuits: {
                closed: closedCircuits,
                halfOpen: halfOpenCircuits,
                open: openCircuits,
            },
        });
    });
};
