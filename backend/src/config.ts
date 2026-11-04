import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config();

const DEV_FALLBACK_MASTER_KEY = 'keygate_dev_only_master_key_never_use_in_production';
const DEV_FALLBACK_ADMIN_TOKEN = 'keygate_dev_only_admin_token';
const MIN_SECRET_LENGTH = 16;
const MIN_SECRET_DISTINCT_CHARS = 12;

// DECISION: The quickstart used to ship plausible-looking placeholders in .env.example.
// Those are longer than MIN_SECRET_LENGTH, so a copied .env booted with publicly known
// secrets. Reject anything that still looks like documentation text, at every NODE_ENV.
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /generate[_-]?a[_-]?random/i,
  /change[_-]?me/i,
  /placeholder/i,
  /example/i,
  /dev[_-]?only/i,
  /your[_-]?(master|admin|token|secret|key)/i,
  /insert[_-]?(a[_-]?)?(random|secret|token|key)/i,
  /replace[_-]?(me|with)/i,
  /(^|[^a-z0-9])x{6,}([^a-z0-9]|$)/i,
];

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function looksLikePlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

function distinctCharacterCount(value: string): number {
  return new Set(value).size;
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

  if (looksLikePlaceholder(raw)) {
    throw new Error(
      `[KeyGate] Placeholder secret detected in ${envName}. ` +
        `Generate a real value, e.g. \`openssl rand -hex 32\`, before starting KeyGate.`
    );
  }

  if (raw.length < MIN_SECRET_LENGTH) {
    throw new Error(`[KeyGate] ${envName} must be at least ${MIN_SECRET_LENGTH} characters long.`);
  }

  // Low entropy is a warning in development but a hard failure in production: a 16-character
  // secret made of two repeating characters is trivially guessable.
  if (distinctCharacterCount(raw) < MIN_SECRET_DISTINCT_CHARS) {
    const message =
      `[KeyGate] ${envName} has very low entropy (${distinctCharacterCount(raw)} distinct characters). ` +
      `Use a randomly generated secret (e.g. \`openssl rand -hex 32\`).`;
    if (isProduction()) throw new Error(message);
    console.warn(`WARNING: ${message}`);
  }

  return raw;
}

const rawMasterKey = requireSecret('KEYGATE_MASTER_KEY', DEV_FALLBACK_MASTER_KEY, 'encryption at rest');
const derivedMasterKey = crypto.createHash('sha256').update(rawMasterKey).digest();

// DECISION: Master-key rotation needs the old key while rows are re-encrypted. Previous keys
// are accepted for decryption only; every new write uses the current KEYGATE_MASTER_KEY.
const previousMasterKeys = (process.env.KEYGATE_MASTER_KEY_PREVIOUS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length >= MIN_SECRET_LENGTH && !looksLikePlaceholder(entry))
  .map((entry) => crypto.createHash('sha256').update(entry).digest());

const adminToken = requireSecret('KEYGATE_ADMIN_TOKEN', DEV_FALLBACK_ADMIN_TOKEN, 'management API authentication');

function parsePositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNumber(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function parseCsv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Fastify accepts `true` (trust every hop) or a list of proxy CIDRs/addresses.
// Trusting every hop is only safe when KeyGate is the only ingress on the host.
function parseTrustProxy(): boolean | string | string[] {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;

  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return false;
  return entries.length === 1 ? entries[0]! : entries;
}

const requireAuth = parseBool('KEYGATE_REQUIRE_AUTH', true);
if (isProduction() && !requireAuth) {
  throw new Error(
    '[KeyGate] KEYGATE_REQUIRE_AUTH=false is refused when NODE_ENV=production. ' +
      'It disables gateway-key authentication and attribution entirely. ' +
      'Set KEYGATE_REQUIRE_AUTH=true, or run with NODE_ENV=development for offline debugging.'
  );
}

export const CONFIG = {
  port: parsePositiveInt('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',
  masterKey: derivedMasterKey,
  previousMasterKeys,
  adminToken,
  dbPath: process.env.KEYGATE_DB_PATH || path.resolve(process.cwd(), 'data', 'keygate.sqlite'),
  requireAuth,
  // Empty list means "same-origin only": no CORS headers are emitted.
  corsOrigins: parseCsv('CORS_ORIGINS'),
  trustProxy: parseTrustProxy(),
  logLevel: process.env.LOG_LEVEL || 'info',
  metricsRetentionDays: parsePositiveInt('METRICS_RETENTION_DAYS', 30),
  // DECISION: Chat prompt/response history is opt-out because it may contain private data.
  // Disable it in shared deployments with HISTORY_ENABLED=false.
  historyEnabled: parseBool('HISTORY_ENABLED', true),
  // HSTS is only meaningful over TLS; enable it in production by default, opt out with ENABLE_HSTS=false.
  enableHsts: parseBool('ENABLE_HSTS', isProduction()),
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
