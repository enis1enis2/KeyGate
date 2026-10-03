import { describe, it, expect, beforeEach } from 'vitest';
import { SmartRouter } from '../src/engine/router.js';
import { CircuitBreakerManager } from '../src/engine/circuit-breaker.js';
import { ModelAliasRepo, ProviderRepo, ApiKeyRepo, getDb } from '../src/db/index.js';
import { encryptSecret } from '../src/crypto.js';
import type { TargetConfig, ModelAliasRecord } from '../src/types/index.js';

describe('SmartRouter & Failover', () => {
  const router = SmartRouter.getInstance();
  const cb = CircuitBreakerManager.getInstance();

  beforeEach(() => {
    getDb();
  });

  it('sorts targets by priority strategy', () => {
    const alias: ModelAliasRecord = {
      id: 'alias-priority',
      alias_name: 'priority-model',
      strategy: 'priority',
      targets_json: '[]',
      hedging_enabled: 0,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: 1,
      created_at: '',
      updated_at: '',
    };

    const targets: TargetConfig[] = [
      { provider_id: 'provider-c', model: 'c', weight: 1, priority: 3 },
      { provider_id: 'provider-a', model: 'a', weight: 1, priority: 1 },
      { provider_id: 'provider-b', model: 'b', weight: 1, priority: 2 },
    ];

    const sorted = router.sortTargets(alias, targets);
    expect(sorted[0]?.provider_id).toBe('provider-a');
    expect(sorted[1]?.provider_id).toBe('provider-b');
    expect(sorted[2]?.provider_id).toBe('provider-c');
  });

  it('rotates targets with round-robin strategy', () => {
    const alias: ModelAliasRecord = {
      id: 'alias-rr',
      alias_name: 'rr-model',
      strategy: 'round-robin',
      targets_json: '[]',
      hedging_enabled: 0,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: 1,
      created_at: '',
      updated_at: '',
    };

    const targets: TargetConfig[] = [
      { provider_id: 'provider-1', model: 'm1', weight: 1, priority: 1 },
      { provider_id: 'provider-2', model: 'm2', weight: 1, priority: 2 },
    ];

    const pass1 = router.sortTargets(alias, targets);
    expect(pass1[0]?.provider_id).toBe('provider-1');

    const pass2 = router.sortTargets(alias, targets);
    expect(pass2[0]?.provider_id).toBe('provider-2');
  });

  it('ranks keys and targets by health score in weighted-by-health mode', () => {
    // Setup providers and keys
    ProviderRepo.create({
      id: 'p-fast',
      name: 'Fast Provider',
      spec_yaml: 'id: p-fast\nname: Fast\nbase_url: https://fast.example.com',
    });
    ProviderRepo.create({
      id: 'p-slow',
      name: 'Slow Provider',
      spec_yaml: 'id: p-slow\nname: Slow\nbase_url: https://slow.example.com',
    });

    const enc1 = encryptSecret('key-fast');
    const enc2 = encryptSecret('key-slow');

    ApiKeyRepo.delete('k-fast');
    ApiKeyRepo.delete('k-slow');

    ApiKeyRepo.create({
      id: 'k-fast',
      provider_id: 'p-fast',
      key_name: 'Fast Key',
      encrypted_key: enc1.encrypted,
      iv: enc1.iv,
      tag: enc1.tag,
      key_prefix: 'k-f',
      key_suffix: 'ast',
    });

    ApiKeyRepo.create({
      id: 'k-slow',
      provider_id: 'p-slow',
      key_name: 'Slow Key',
      encrypted_key: enc2.encrypted,
      iv: enc2.iv,
      tag: enc2.tag,
      key_prefix: 'k-s',
      key_suffix: 'low',
    });

    // Record 10 fast calls (50ms)
    for (let i = 0; i < 10; i++) cb.recordCallResult('k-fast', true, 50);
    // Record 10 slow calls with 30% errors (500ms)
    for (let i = 0; i < 7; i++) cb.recordCallResult('k-slow', true, 500);
    for (let i = 0; i < 3; i++) cb.recordCallResult('k-slow', false, 500, 0, 0, 'retryable', 'timeout');

    const alias: ModelAliasRecord = {
      id: 'alias-health',
      alias_name: 'health-model',
      strategy: 'weighted-by-health',
      targets_json: '[]',
      hedging_enabled: 0,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: 1,
      created_at: '',
      updated_at: '',
    };

    const targets: TargetConfig[] = [
      { provider_id: 'p-slow', model: 'slow-m', weight: 1, priority: 1 },
      { provider_id: 'p-fast', model: 'fast-m', weight: 1, priority: 2 },
    ];

    const sorted = router.sortTargets(alias, targets);
    expect(sorted[0]?.provider_id).toBe('p-fast');
  });
});
