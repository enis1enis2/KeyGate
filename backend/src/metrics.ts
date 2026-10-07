import client from 'prom-client';

// DECISION: The Prometheus registry lives outside routes/ so the auth layer can increment
// quota-rejection counters without importing HTTP plugin code.
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'keygate_' });

export const quotaRejections = new client.Counter({
  name: 'keygate_quota_rejections_total',
  help: 'Requests rejected by gateway-key pool scope, rpm or tpm enforcement',
  labelNames: ['scope'] as const,
  registers: [registry],
});

export const authRejections = new client.Counter({
  name: 'keygate_auth_rejections_total',
  help: 'Requests rejected during gateway or admin authentication',
  labelNames: ['scope'] as const,
  registers: [registry],
});

export const spendTodayGauge = new client.Gauge({
  name: 'keygate_spend_today_usd',
  help: 'USD spend recorded today (UTC day boundary) across all pools',
  registers: [registry],
});

export const poolSpendTodayGauge = new client.Gauge({
  name: 'keygate_pool_spend_today_usd',
  help: 'USD spend recorded today per AI pool (model alias)',
  labelNames: ['pool'] as const,
  registers: [registry],
});

export const poolTokensTodayGauge = new client.Gauge({
  name: 'keygate_pool_tokens_today',
  help: 'Token usage recorded today per AI pool (model alias)',
  labelNames: ['pool'] as const,
  registers: [registry],
});
