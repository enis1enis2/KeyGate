import yaml from 'yaml';
import { ProviderRepo, ModelAliasRepo, ApiKeyRepo, RequestLogRepo } from '../db/index.js';
import { CircuitBreakerManager } from './circuit-breaker.js';
import { quotaRejections } from '../metrics.js';
import type {
  ApiKeyRecord,
  EndpointPathKey,
  ModelAliasRecord,
  OpenAIMessage,
  ProviderSpec,
  RoutingStrategy,
  TargetConfig,
} from '../types/index.js';

// DECISION: Target resolution, health-based key selection and pool budget gating live in their
// own module so the chat router and the generic endpoint proxy share exactly one implementation.
// Neither module imports the other, which keeps the dependency graph acyclic.

export function loadProviderSpec(providerId: string): ProviderSpec | null {
  const p = ProviderRepo.getById(providerId);
  if (!p || !p.is_active) return null;
  try {
    return yaml.parse(p.spec_yaml) as ProviderSpec;
  } catch {
    return null;
  }
}

// Only counts providers that explicitly declare the path; defaults are not considered a
// declaration, so chat routing keeps its historical "first active provider" fallback.
function providerDeclaresPath(providerId: string, pathKey: EndpointPathKey): boolean {
  const spec = loadProviderSpec(providerId);
  return Boolean(spec?.endpoint_paths?.[pathKey]);
}

export interface ResolvedTargets {
  alias: ModelAliasRecord | null;
  aliasName: string;
  targets: TargetConfig[];
  specByProvider: Map<string, ProviderSpec>;
}

export function resolveTargets(
  aliasName: string,
  model: string,
  pathKey: EndpointPathKey
): ResolvedTargets {
  const alias = ModelAliasRepo.getByName(aliasName);
  let targets: TargetConfig[] = [];

  if (alias) {
    try {
      targets = JSON.parse(alias.targets_json) as TargetConfig[];
    } catch {
      targets = [];
    }
  }

  if (targets.length === 0) {
    const directProvider = ProviderRepo.getById(aliasName);
    if (directProvider) {
      targets = [{ provider_id: directProvider.id, model, weight: 1, priority: 1 }];
    } else {
      const active = ProviderRepo.getAll().filter((p) => p.is_active);
      const declared = active.filter((p) => providerDeclaresPath(p.id, pathKey));
      const pool = declared.length > 0 ? declared : active;
      if (pool.length > 0) {
        targets = [{ provider_id: pool[0]!.id, model, weight: 1, priority: 1 }];
      }
    }
  }

  return { alias, aliasName, targets, specByProvider: new Map() };
}

const roundRobinIndices: Map<string, number> = new Map();

// DECISION: Target selection supports weighted-by-health, round-robin, and priority strategies.
export function sortTargets(
  alias: ModelAliasRecord,
  targets: TargetConfig[],
  healthScore: (providerId: string) => number
): TargetConfig[] {
  if (targets.length <= 1) return targets;

  const strategy: RoutingStrategy = alias.strategy;

  if (strategy === 'priority') {
    return [...targets].sort((a, b) => a.priority - b.priority);
  }

  if (strategy === 'round-robin') {
    const idx = roundRobinIndices.get(alias.alias_name) || 0;
    const nextIdx = (idx + 1) % targets.length;
    roundRobinIndices.set(alias.alias_name, nextIdx);
    return [...targets.slice(idx), ...targets.slice(0, idx)];
  }

  const scored = targets.map((t) => ({
    target: t,
    score: (t.weight || 1) * healthScore(t.provider_id),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.target);
}

// ----------------- 'by-ai' complexity routing -----------------
// DECISION: The 'by-ai' strategy keeps a free, deterministic heuristic as its first pass and only
// spends a classifier call when the request is genuinely ambiguous. This keeps the common case
// (a greeting, a short factual question) at zero added latency and cost.

export type ComplexityTier = 'cheap' | 'medium' | 'strong';

const STRONG_SIGNALS = [
  'prove', 'derive', 'step by step', 'step-by-step', 'analyze', 'analyse', 'algorithm',
  'proof', 'theorem', 'complexity', 'optimize', 'optimise', 'refactor', 'debug', 'root cause',
  'architecture', 'design a', 'trade-off', 'tradeoff', 'compare in depth', 'in detail',
  'essay', 'comprehensive', 'multi-step', 'chain of thought',
];

const CODE_SIGNALS = ['```', 'function ', 'def ', 'class ', 'import ', 'select ', 'docker', 'regex', 'stack trace'];

const CHEAP_SIGNALS = [
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'good morning', 'good night', 'how are you',
  'what is', 'who is', 'whats', "what's", 'define ', 'capital of', 'translate', 'yes or no',
];

const MEDIUM_CHAR_THRESHOLD = 280;
const STRONG_CHAR_THRESHOLD = 2400;

export function lastUserText(messages: OpenAIMessage[] | undefined): string {
  if (!messages) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (typeof p === 'string' ? p : typeof (p as { text?: unknown }).text === 'string' ? String((p as { text: string }).text) : ''))
        .join(' ');
    }
  }
  return '';
}

export function classifyComplexity(prompt: string): ComplexityTier {
  const text = prompt.toLowerCase();
  const length = prompt.length;
  const hasQuestionMarks = (prompt.match(/\?/g) || []).length;
  const hasStrong = STRONG_SIGNALS.some((s) => text.includes(s));
  const hasCode = CODE_SIGNALS.some((s) => text.includes(s));

  if (hasStrong || hasCode || length >= STRONG_CHAR_THRESHOLD) return 'strong';
  if (length <= MEDIUM_CHAR_THRESHOLD && hasQuestionMarks <= 2) {
    const shortSimple = length <= 80;
    if (shortSimple || CHEAP_SIGNALS.some((s) => text.includes(s))) return 'cheap';
  }
  return 'medium';
}

export function targetTierNames(targets: TargetConfig[]): string[] {
  const names: string[] = [];
  for (const t of targets) {
    if (t.tier && !names.includes(t.tier)) names.push(t.tier);
  }
  return names;
}

function sortByHealth(targets: TargetConfig[], healthScore: (providerId: string) => number): TargetConfig[] {
  return [...targets].sort(
    (a, b) => (b.weight || 1) * healthScore(b.provider_id) - (a.weight || 1) * healthScore(a.provider_id)
  );
}

// Put the targets tagged with the chosen tier first (health-ordered), then the rest so normal
// failover still has somewhere to go.
export function orderTargetsByTier(
  targets: TargetConfig[],
  tier: string,
  healthScore: (providerId: string) => number
): TargetConfig[] {
  const preferred = sortByHealth(targets.filter((t) => t.tier === tier), healthScore);
  const rest = sortByHealth(targets.filter((t) => t.tier !== tier), healthScore);
  return [...preferred, ...rest];
}

// Bring a classifier-chosen target to the front while preserving failover over the remainder.
export function orderTargetsByPick(
  targets: TargetConfig[],
  chosen: TargetConfig,
  healthScore: (providerId: string) => number
): TargetConfig[] {
  const rest = sortByHealth(
    targets.filter((t) => !(t.provider_id === chosen.provider_id && t.model === chosen.model)),
    healthScore
  );
  return [chosen, ...rest];
}

// DECISION: A key with a non-zero daily_budget_cap that already spent it today is treated as
// unavailable, so normal failover moves traffic to the next key instead of failing the request.
export function selectCandidateKeys(providerId: string): {
  available: { key: ApiKeyRecord; isProbe?: boolean }[];
  budgetBlocked: number;
} {
  const keys = ApiKeyRepo.getByProvider(providerId);
  const cb = CircuitBreakerManager.getInstance();

  const healthy: { key: ApiKeyRecord; score: number; isProbe?: boolean }[] = [];
  let budgetBlocked = 0;

  for (const key of keys) {
    if (key.daily_budget_cap > 0 && RequestLogRepo.getSpendByKeyToday(key.id) >= key.daily_budget_cap) {
      budgetBlocked++;
      continue;
    }

    const availability = cb.isKeyAvailable(key.id);
    if (availability.available) {
      const stats = cb.getKeyStats(key.id);
      const successRatio = stats.rolling_success_rate / 100;
      const latencyPenalty = Math.max(stats.latency_p50, 50);
      healthy.push({ key, score: (successRatio * successRatio * 1000) / latencyPenalty, isProbe: availability.isProbe });
    }
  }

  healthy.sort((a, b) => b.score - a.score);
  return { available: healthy.map((h) => ({ key: h.key, isProbe: h.isProbe })), budgetBlocked };
}

// Pool-level daily caps: when a pool is over budget, reject before dispatching upstream.
export function assertPoolBudget(alias: ModelAliasRecord): void {
  if (!(alias.daily_token_cap > 0) && !(alias.daily_spend_cap > 0)) return;

  const usage = RequestLogRepo.getUsageTodayByPool(alias.alias_name);

  if (alias.daily_token_cap > 0 && usage.tokens >= alias.daily_token_cap) {
    quotaRejections.inc({ scope: 'pool_token_cap' });
    throw {
      classified: {
        errorType: 'quota_exhausted',
        statusCode: 429,
        message: `Daily token cap reached for model '${alias.alias_name}' (${usage.tokens}/${alias.daily_token_cap} tokens today).`,
      },
      statusCode: 429,
      latencyMs: 0,
    };
  }

  if (alias.daily_spend_cap > 0 && usage.spend >= alias.daily_spend_cap) {
    quotaRejections.inc({ scope: 'pool_spend_cap' });
    throw {
      classified: {
        errorType: 'quota_exhausted',
        statusCode: 429,
        message: `Daily spend cap reached for model '${alias.alias_name}' ($${usage.spend.toFixed(4)} of $${alias.daily_spend_cap} today).`,
      },
      statusCode: 429,
      latencyMs: 0,
    };
  }
}

// Highest health score across a provider's available keys, used by weighted-by-health sorting.
export function providerHealthScore(providerId: string): number {
  const cb = CircuitBreakerManager.getInstance();
  let best = 0;
  for (const { key } of selectCandidateKeys(providerId).available) {
    const stats = cb.getKeyStats(key.id);
    const successRatio = stats.rolling_success_rate / 100;
    const latencyPenalty = Math.max(stats.latency_p50, 50);
    const score = (successRatio * successRatio * 1000) / latencyPenalty;
    if (score > best) best = score;
  }
  return best;
}
