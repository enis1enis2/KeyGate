import { PricingRepo } from '../db/index.js';
import type { ModelPricingRecord } from '../types/index.js';

// DECISION: Pricing rows are tiny and lookup is a single indexed query, so cost is computed
// straight from SQLite rather than cached in memory. That avoids stale prices right after an
// operator edits a rate, and costs well under a millisecond per request.
export function resolvePrice(providerId: string, model: string): ModelPricingRecord | null {
  return PricingRepo.findBest(providerId, model);
}

export function computeCost(
  providerId: string,
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const price = resolvePrice(providerId, model);
  if (!price) return 0;
  if (!(price.input_per_mtok > 0) && !(price.output_per_mtok > 0)) return 0;

  const input = ((promptTokens > 0 ? promptTokens : 0) * price.input_per_mtok) / 1_000_000;
  const output = ((completionTokens > 0 ? completionTokens : 0) * price.output_per_mtok) / 1_000_000;
  const cost = input + output;
  // Round to cents-scale so float noise never accumulates into the daily budget gate.
  return Math.round(cost * 1_000_000) / 1_000_000;
}
