import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config();

const DEV_FALLBACK_MASTER_KEY = 'keygate_dev_only_master_key_never_use_in_production';
const DEV_FALLBACK_ADMIN_TOKEN = 'keygate_dev_only_admin_token';
const MIN_SECRET_LENGTH = 16;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

// DECISION: Secrets are required in production and fail fast at boot rather than
// silently falling back to a predictable value that would make stored keys decryptable.
function requireSecret(envName: string, devFallback: string, purpose: string): string {
  const raw = process.env[envName]?.trim();

  if (!raw) {
    if (isProduction()) {
      throw new Error(
        `[KeyGate] ${envName} must be set when NODE_ENV=production. ` +
        `Refusing to start ${purpose} with a publicly known default.`
      );
    }
    console.warn(
      `[KeyGate] WARNING: ${envName} is not set. Using an insecure development fallback for ${purpose}. ` +
      `Set ${envName} before deploying.`
    );
    return devFallback;
  }

  if (raw.length < MIN_SECRET_LENGTH) {
    throw new Error(`[KeyGate] ${envName} must be at least ${MIN_SECRET_LENGTH} characters long.`);
  }

  return raw;
}

const rawMasterKey = requireSecret('KEYGATE_MASTER_KEY', DEV_FALLBACK_MASTER_KEY, 'encryption at rest');
const derivedMasterKey = crypto.createHash('sha256').update(rawMasterKey).digest();

const adminToken = requireSecret('KEYGATE_ADMIN_TOKEN', DEV_FALLBACK_ADMIN_TOKEN, 'management API authentication');

function parsePositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export const CONFIG = {
  port: parsePositiveInt('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  masterKey: derivedMasterKey,
  adminToken,
  dbPath: process.env.KEYGATE_DB_PATH || path.resolve(process.cwd(), 'data', 'keygate.sqlite'),
  requireAuth: process.env.KEYGATE_REQUIRE_AUTH !== 'false',
  logLevel: process.env.LOG_LEVEL || 'info',
  metricsRetentionDays: parsePositiveInt('METRICS_RETENTION_DAYS', 30),
  // Empty list means "same-origin only": no CORS headers are emitted.
  corsOrigins: parseCsv('CORS_ORIGINS'),
  rateLimit: {
    globalMax: parsePositiveInt('RATE_LIMIT_MAX', 300),
    v1Max: parsePositiveInt('RATE_LIMIT_V1_MAX', 120),
    timeWindowMs: parsePositiveInt('RATE_LIMIT_WINDOW_MS', 60_000),
  },
  circuitBreaker: {
    failureThreshold: parsePositiveInt('CB_FAILURE_THRESHOLD', 3),
    successRateThreshold: parseNumber('CB_SUCCESS_RATE_THRESHOLD', 0.7),
    baseCooldownMs: parsePositiveInt('CB_BASE_COOLDOWN_MS', 5000),
    maxCooldownMs: parsePositiveInt('CB_MAX_COOLDOWN_MS', 300_000),
    quotaCooldownMs: parsePositiveInt('CB_QUOTA_COOLDOWN_MS', 86_400_000), // 24 hours
  },
  defaultTimeoutMs: parsePositiveInt('DEFAULT_TIMEOUT_MS', 30_000),
  // Largest multipart upload the gateway will buffer for image/audio endpoints.
  maxUploadBytes: parsePositiveInt('MAX_UPLOAD_BYTES', 64 * 1024 * 1024),
};
