import crypto from 'crypto';
import { CONFIG } from './config.js';

// DECISION: Use AES-256-GCM with a random 12-byte IV and 16-byte authentication tag for authenticated encryption at rest.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// New rows are always written with the current master key. The column marks the on-disk format
// generation; it is deliberately not used to choose a decryption key (the GCM tag does that).
export const CURRENT_KEY_VERSION = 1;

export function encryptSecret(plainText: string): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, CONFIG.masterKey, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag,
  };
}

function decryptWithKey(key: Buffer, encryptedHex: string, ivHex: string, tagHex: string): string {
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// DECISION: During a master-key rotation the new key cannot read existing rows. Try the current
// key first, then every key listed in KEYGATE_MASTER_KEY_PREVIOUS. A row is never silently
// decrypted with a wrong key because GCM authentication fails closed.
export function decryptSecret(encryptedHex: string, ivHex: string, tagHex: string): string {
  const candidates = [CONFIG.masterKey, ...CONFIG.previousMasterKeys];
  let lastError: unknown;

  for (const key of candidates) {
    try {
      return decryptWithKey(key, encryptedHex, ivHex, tagHex);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to decrypt secret with the configured master keys.');
}

// Re-encryption needs to know whether a row is already on the current key. `key_version` alone
// is not enough: it is a format generation, so a second rotation would otherwise skip rows that
// are still encrypted with the previous key and leave them unreadable once that key is removed.
export function decryptSecretWithCurrentKey(
  encryptedHex: string,
  ivHex: string,
  tagHex: string
): string {
  return decryptWithKey(CONFIG.masterKey, encryptedHex, ivHex, tagHex);
}

// DECISION: Mask sensitive upstream keys so only prefixes and suffixes are ever sent to UI or logged.
export function maskKey(key: string): { prefix: string; suffix: string; masked: string } {
  const trimmed = key.trim();
  if (trimmed.length <= 8) {
    return {
      prefix: trimmed.slice(0, 2),
      suffix: trimmed.slice(-2),
      masked: `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`,
    };
  }

  const prefix = trimmed.slice(0, 6);
  const suffix = trimmed.slice(-4);
  const masked = `${prefix}...${suffix}`;

  return { prefix, suffix, masked };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

export function generateGatewayToken(prefix: string = 'kg-live'): { rawToken: string; tokenHash: string; tokenPrefix: string; tokenSuffix: string } {
  const randomBytes = crypto.randomBytes(24).toString('base64url');
  const rawToken = `${prefix}_${randomBytes}`;
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);
  const tokenSuffix = rawToken.slice(-4);

  return {
    rawToken,
    tokenHash,
    tokenPrefix,
    tokenSuffix,
  };
}
