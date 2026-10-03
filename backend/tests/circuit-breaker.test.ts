import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreakerManager } from '../src/engine/circuit-breaker.js';
import { ApiKeyRepo, ProviderRepo, getDb } from '../src/db/index.js';
import { encryptSecret } from '../src/crypto.js';

describe('CircuitBreakerManager', () => {
  const cb = CircuitBreakerManager.getInstance();
  const testProviderId = 'cb-test-provider';
  const testKeyId = 'cb-test-key-1';

  beforeEach(() => {
    getDb();
    ProviderRepo.create({
      id: testProviderId,
      name: 'CB Test Provider',
      base_url: 'https://example.com',
      spec_yaml: 'id: cb-test-provider\nname: CB Test Provider\nbase_url: https://example.com',
    });

    const enc = encryptSecret('test-secret-key-1234');
    ApiKeyRepo.delete(testKeyId);
    ApiKeyRepo.create({
      id: testKeyId,
      provider_id: testProviderId,
      key_name: 'Primary Key',
      encrypted_key: enc.encrypted,
      iv: enc.iv,
      tag: enc.tag,
      key_prefix: 'test-s',
      key_suffix: '1234',
    });
    cb.resetCircuit(testKeyId);
  });

  it('tracks rolling success rate and p50/p95 latency', () => {
    // Record 10 successful calls with varying latencies
    const latencies = [50, 60, 70, 80, 90, 100, 110, 120, 130, 200];
    for (const lat of latencies) {
      cb.recordCallResult(testKeyId, true, lat, 10, 20);
    }

    let stats = cb.getKeyStats(testKeyId);
    expect(stats.rolling_success_rate).toBe(100);
    expect(stats.total_calls_window).toBe(10);
    expect(stats.latency_p50).toBe(100);
    expect(stats.latency_p95).toBe(200);

    // Record 2 failed calls
    cb.recordCallResult(testKeyId, false, 300, 0, 0, 'retryable', 'Network timeout');
    cb.recordCallResult(testKeyId, false, 300, 0, 0, 'retryable', 'Network timeout');

    stats = cb.getKeyStats(testKeyId);
    // 10 success out of 12 calls = 83%
    expect(stats.rolling_success_rate).toBe(83);
    expect(stats.total_calls_window).toBe(12);
  });

  it('trips circuit breaker to OPEN after consecutive failures threshold', () => {
    expect(cb.isKeyAvailable(testKeyId).available).toBe(true);

    // Threshold is 3 consecutive failures
    cb.recordCallResult(testKeyId, false, 100, 0, 0, 'retryable', 'Timeout 1');
    expect(cb.isKeyAvailable(testKeyId).available).toBe(true);

    cb.recordCallResult(testKeyId, false, 100, 0, 0, 'retryable', 'Timeout 2');
    expect(cb.isKeyAvailable(testKeyId).available).toBe(true);

    cb.recordCallResult(testKeyId, false, 100, 0, 0, 'retryable', 'Timeout 3');
    const avail = cb.isKeyAvailable(testKeyId);
    expect(avail.available).toBe(false);
    expect(avail.reason).toContain('circuit_open_cooling_down');

    const key = ApiKeyRepo.getById(testKeyId);
    expect(key?.circuit_state).toBe('OPEN');
    expect(key?.consecutive_failures).toBe(3);
    expect(key?.cooldown_until).toBeGreaterThan(Date.now());
  });

  it('honors Retry-After header duration', () => {
    // 429 rate limit with 45 seconds Retry-After
    const retryAfterMs = 45000;
    cb.recordCallResult(testKeyId, false, 50, 0, 0, 'rate_limit', 'Rate limit reached', retryAfterMs);

    const key = ApiKeyRepo.getById(testKeyId);
    expect(key?.circuit_state).toBe('OPEN');
    // Cooldown should be at least ~44-45 seconds in future
    expect(key!.cooldown_until - Date.now()).toBeGreaterThan(40000);
  });

  it('disables key immediately on auth_fail pending human review', () => {
    cb.recordCallResult(testKeyId, false, 50, 0, 0, 'auth_fail', 'Invalid API key');

    const key = ApiKeyRepo.getById(testKeyId);
    expect(key?.is_active).toBe(0);
    expect(key?.disabled_reason).toBe('auth_failed_pending_review');

    const avail = cb.isKeyAvailable(testKeyId);
    expect(avail.available).toBe(false);
    expect(avail.reason).toBe('auth_failed_pending_review');
  });

  it('applies long cooldown on quota_exhausted', () => {
    cb.recordCallResult(testKeyId, false, 50, 0, 0, 'quota_exhausted', 'Out of credits');

    const key = ApiKeyRepo.getById(testKeyId);
    expect(key?.circuit_state).toBe('OPEN');
    expect(key?.disabled_reason).toBe('quota_exhausted_cooling_down');
    // Cooldown is 24h by default (> 80,000,000 ms)
    expect(key!.cooldown_until - Date.now()).toBeGreaterThan(80000000);
  });

  it('allows single half-open probe after cooldown and recovers on success', () => {
    // Force circuit into OPEN with cooldown in the past
    ApiKeyRepo.updateCircuitState(testKeyId, 'OPEN', Date.now() - 1000, 3, 'Timeout');

    // First check should transition to HALF_OPEN probe
    const probeCheck = cb.isKeyAvailable(testKeyId);
    expect(probeCheck.available).toBe(true);
    expect(probeCheck.isProbe).toBe(true);

    // Concurrent check while probe is in flight should be rejected
    const concurrentCheck = cb.isKeyAvailable(testKeyId);
    expect(concurrentCheck.available).toBe(false);
    expect(concurrentCheck.reason).toBe('probe_already_in_flight');

    // Successful probe call resets circuit to CLOSED
    cb.recordCallResult(testKeyId, true, 80);
    const postProbeKey = ApiKeyRepo.getById(testKeyId);
    expect(postProbeKey?.circuit_state).toBe('CLOSED');
    expect(postProbeKey?.consecutive_failures).toBe(0);
    expect(cb.isKeyAvailable(testKeyId).available).toBe(true);
  });
});
