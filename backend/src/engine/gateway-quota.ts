import type { GatewayKeyRecord } from '../types/index.js';

export type QuotaDenialReason = 'rpm_limit_exceeded' | 'tpm_limit_exceeded';

interface Bucket {
  windowMinute: number;
  requests: number;
  tokens: number;
}

// DECISION: Gateway-key rpm/tpm limits are enforced with in-memory fixed 1-minute buckets,
// mirroring the upstream key rate limiter in circuit-breaker.ts. Limits are per KeyGate process
// (single-process deployment); they are deliberately not persisted, because counters reset on
// restart and callers are never harmed by an over-permissive restart window.
export class GatewayQuota {
  private static buckets = new Map<string, Bucket>();

  private static bucket(keyId: string): Bucket {
    const minute = Math.floor(Date.now() / 60_000);
    let b = GatewayQuota.buckets.get(keyId);

    if (!b || b.windowMinute !== minute) {
      b = { windowMinute: minute, requests: 0, tokens: 0 };
      GatewayQuota.buckets.set(keyId, b);
      // Opportunistic cleanup so revoked keys cannot accumulate stale windows forever.
      if (GatewayQuota.buckets.size > 512) {
        for (const [id, existing] of GatewayQuota.buckets) {
          if (existing.windowMinute < minute) GatewayQuota.buckets.delete(id);
        }
      }
    }
    return b;
  }

  // Atomically check and consume one request slot. Concurrency-safe because the
  // increment happens in the same synchronous call as the check.
  public static reserve(key: GatewayKeyRecord): QuotaDenialReason | null {
    const b = GatewayQuota.bucket(key.id);
    if (key.rpm_limit > 0 && b.requests >= key.rpm_limit) return 'rpm_limit_exceeded';
    if (key.tpm_limit > 0 && b.tokens >= key.tpm_limit) return 'tpm_limit_exceeded';
    b.requests += 1;
    return null;
  }

  public static addTokens(keyId: string, tokens: number): void {
    if (!(tokens > 0)) return;
    GatewayQuota.bucket(keyId).tokens += tokens;
  }

  public static peek(keyId: string): { requests: number; tokens: number } {
    const b = GatewayQuota.bucket(keyId);
    return { requests: b.requests, tokens: b.tokens };
  }

  // Test helper: clearing state keeps quota assertions deterministic across suites.
  public static reset(keyId?: string): void {
    if (keyId) GatewayQuota.buckets.delete(keyId);
    else GatewayQuota.buckets.clear();
  }
}
