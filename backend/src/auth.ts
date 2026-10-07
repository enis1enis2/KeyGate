import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { CONFIG } from './config.js';
import { GatewayKeyRepo } from './db/index.js';
import { hashToken } from './crypto.js';
import { GatewayQuota, type QuotaDenialReason } from './engine/gateway-quota.js';
import { quotaRejections, authRejections } from './metrics.js';
import type { GatewayKeyRecord } from './types/index.js';

export type AuthDenial =
  | 'missing_token'
  | 'invalid_token'
  | 'expired_token'
  | 'model_not_allowed'
  | QuotaDenialReason;

export interface AuthResult {
  authenticated: boolean;
  keyId?: string;
  key?: GatewayKeyRecord;
  error?: string;
  denial?: AuthDenial;
}

function readBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

// DECISION: Compare digests instead of the raw strings so token comparison does not leak length/timing information.
function constantTimeEquals(a: string, b: string): boolean {
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

const QUOTA_DENIALS: ReadonlySet<string> = new Set<AuthDenial>([
  'model_not_allowed',
  'rpm_limit_exceeded',
  'tpm_limit_exceeded',
]);

function denialResult(denial: AuthDenial, error: string): AuthResult {
  if (QUOTA_DENIALS.has(denial)) quotaRejections.inc({ scope: denial });
  else authRejections.inc({ scope: denial });
  return { authenticated: false, denial, error };
}

// DECISION: Authenticate gateway tokens via SHA-256 hash lookup against the database,
// allowing optional unauthenticated local mode when KEYGATE_REQUIRE_AUTH=false.
export function authenticateGatewayKey(request: FastifyRequest): AuthResult {
  if (!CONFIG.requireAuth) {
    return { authenticated: true };
  }

  const rawToken = readBearerToken(request);
  if (!rawToken) {
    return {
      authenticated: false,
      denial: 'missing_token',
      error: 'Missing or malformed Authorization header. Expected: Bearer <keygate_token>',
    };
  }

  const keyRecord = GatewayKeyRepo.getByHash(hashToken(rawToken));
  if (!keyRecord) {
    return denialResult('invalid_token', 'Invalid or revoked Gateway API key.');
  }

  if (keyRecord.expires_at && Date.now() > keyRecord.expires_at) {
    return denialResult('expired_token', 'Gateway API key has expired.');
  }

  return { authenticated: true, keyId: keyRecord.id, key: keyRecord };
}

// Scope: a gateway key may only reach the pools named in allowed_aliases_json,
// where ["*"] (the default) means "every pool".
export function isAliasAllowed(key: GatewayKeyRecord, aliasName: string): boolean {
  let allowed: unknown;
  try {
    allowed = JSON.parse(key.allowed_aliases_json);
  } catch {
    return false;
  }
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  if (allowed.includes('*')) return true;
  return allowed.includes(aliasName);
}

// Full data-plane authorization: authenticate, verify pool scope, then atomically
// reserve a rate-limit slot. Call exactly once per inbound /v1 request.
export function authorizeGatewayKey(
  request: FastifyRequest,
  opts?: { alias?: string }
): AuthResult {
  const auth = authenticateGatewayKey(request);
  if (!auth.authenticated || !auth.key) return auth;

  const key = auth.key;

  if (opts?.alias && !isAliasAllowed(key, opts.alias)) {
    return denialResult(
      'model_not_allowed',
      `Gateway API key is not permitted to use model '${opts.alias}'.`
    );
  }

  const quotaDenial = GatewayQuota.reserve(key);
  if (quotaDenial) {
    return denialResult(
      quotaDenial,
      quotaDenial === 'rpm_limit_exceeded'
        ? `Rate limit exceeded: this key allows ${key.rpm_limit} requests per minute.`
        : `Token limit exceeded: this key allows ${key.tpm_limit} tokens per minute.`
    );
  }

  return auth;
}

interface AuthErrorMapping {
  status: number;
  type: string;
  code: string;
  retryAfterSec?: number;
}

const DENIAL_MAPPING: Record<AuthDenial, AuthErrorMapping> = {
  missing_token: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key' },
  invalid_token: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key' },
  expired_token: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key' },
  model_not_allowed: { status: 403, type: 'invalid_request_error', code: 'model_not_allowed' },
  rpm_limit_exceeded: { status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  tpm_limit_exceeded: { status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded' },
};

// Serialize an authorization failure in the OpenAI error envelope so any stock client can read it.
export function sendAuthError(reply: FastifyReply, auth: AuthResult): FastifyReply {
  const denial: AuthDenial = auth.denial || 'invalid_token';
  const mapping = DENIAL_MAPPING[denial];

  const headers: Record<string, string> = {};
  if (mapping.status === 429) {
    const retryAfterSec = Math.max(1, Math.ceil((60_000 - (Date.now() % 60_000)) / 1000));
    headers['retry-after'] = String(retryAfterSec);
  }

  return reply
    .status(mapping.status)
    .headers(headers)
    .send({
      error: {
        message: auth.error || 'Unauthorized.',
        type: mapping.type,
        param: null,
        code: mapping.code,
      },
    });
}

// DECISION: The management API is a separate trust boundary from the /v1 data plane.
// Gateway keys are handed to downstream clients, so they must never be able to manage
// providers, upstream keys or issue further gateway keys.
export function authenticateAdmin(request: FastifyRequest): AuthResult {
  const rawToken = readBearerToken(request);
  if (!rawToken) {
    return {
      authenticated: false,
      denial: 'missing_token',
      error: 'Missing Authorization header. Expected: Bearer <KEYGATE_ADMIN_TOKEN>',
    };
  }

  if (!constantTimeEquals(rawToken, CONFIG.adminToken)) {
    return denialResult('invalid_token', 'Invalid admin token.');
  }

  return { authenticated: true };
}

export function isManagementPath(url: string): boolean {
  const pathname = url.split('?')[0] ?? url;
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/metrics';
}
