import crypto from 'crypto';
import { CONFIG } from './config.js';
// DECISION: Use AES-256-GCM with a random 12-byte IV and 16-byte authentication tag for authenticated encryption at rest.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
export function encryptSecret(plainText) {
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
export function decryptSecret(encryptedHex, ivHex, tagHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, CONFIG.masterKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
// DECISION: Mask sensitive upstream keys so only prefixes and suffixes are ever sent to UI or logged.
export function maskKey(key) {
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
export function hashToken(token) {
    return crypto.createHash('sha256').update(token.trim()).digest('hex');
}
export function generateGatewayToken(prefix = 'kg-live') {
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
