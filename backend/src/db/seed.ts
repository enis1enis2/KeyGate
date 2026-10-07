import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { ProviderRepo, ModelAliasRepo, GatewayKeyRepo } from './index.js';
import { generateGatewayToken } from '../crypto.js';
import { errorMessage } from '../errors.js';
import type { ProviderSpec } from '../types/index.js';

export function seedInitialData(): { defaultGatewayToken?: string } {
  let defaultGatewayToken: string | undefined;

  // 1. Seed providers from ../providers/*.yaml
  const providersDir = path.resolve(process.cwd(), '..', 'providers');

  if (fs.existsSync(providersDir)) {
    const files = fs.readdirSync(providersDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const filePath = path.join(providersDir, file);
        const yamlContent = fs.readFileSync(filePath, 'utf-8');
        const spec = yaml.parse(yamlContent) as ProviderSpec;
        if (spec && spec.id) {
          ProviderRepo.create({
            id: spec.id,
            name: spec.name,
            description: spec.description,
            preset: spec.preset || 'custom',
            spec_yaml: yamlContent,
          });
        }
      } catch (err) {
        console.error(`Failed to seed provider from ${file}:`, errorMessage(err));
      }
    }
  }

  // 2. Seed default model aliases if none exist
  const existingAliases = ModelAliasRepo.getAll();
  if (existingAliases.length === 0) {
    ModelAliasRepo.upsert({
      id: 'alias-gpt-4o',
      alias_name: 'gpt-4o',
      strategy: 'weighted-by-health',
      targets_json: JSON.stringify([
        { provider_id: 'openai-compatible', model: 'llama-3.3-70b-versatile', weight: 3, priority: 1 },
        { provider_id: 'anthropic-messages', model: 'claude-3-5-sonnet-20241022', weight: 2, priority: 2 },
      ]),
      hedging_enabled: false,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: true,
    });

    ModelAliasRepo.upsert({
      id: 'alias-default',
      alias_name: 'default',
      strategy: 'weighted-by-health',
      targets_json: JSON.stringify([
        { provider_id: 'openai-compatible', model: 'llama-3.3-70b-versatile', weight: 1, priority: 1 },
      ]),
      hedging_enabled: false,
      hedged_delay_ms: 500,
      timeout_ms: 30000,
      is_active: true,
    });
  }

  // 3. Seed default gateway key if none exist
  const existingGatewayKeys = GatewayKeyRepo.getAll();
  if (existingGatewayKeys.length === 0) {
    const { rawToken, tokenHash, tokenPrefix, tokenSuffix } = generateGatewayToken('kg-live');
    GatewayKeyRepo.create({
      id: 'gwk-default',
      name: 'Default Gateway Key',
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      token_suffix: tokenSuffix,
      rpm_limit: 0,
      tpm_limit: 0,
      allowed_aliases_json: '["*"]',
      expires_at: null,
    });
    defaultGatewayToken = rawToken;
    console.log(`\n========================================================`);
    console.log(`[KeyGate] Generated Initial Gateway Bearer Token:`);
    console.log(`  Token: ${rawToken}`);
    console.log(`  Use this Bearer token in any OpenAI-compatible client.`);
    console.log(`========================================================\n`);
  }

  return { defaultGatewayToken };
}
