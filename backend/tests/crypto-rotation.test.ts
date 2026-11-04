import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { CONFIG } from '../src/config.js';
import {
  decryptSecret,
  decryptSecretWithCurrentKey,
  encryptSecret,
} from '../src/crypto.js';

// Regression coverage for M-12 (master-key rotation): a row written with a retired key must still
// decrypt while that key is listed in KEYGATE_MASTER_KEY_PREVIOUS, and it must stop decrypting when
// the retired key is removed. `decryptSecretWithCurrentKey` is what the rotation script uses to tell
// "already re-encrypted" apart from "still on an older key".
const ALGORITHM = 'aes-256-gcm';
const PREVIOUS_SECRET = 'previous_master_key_at_least_16_chars';

function encryptWith(
  key: Buffer,
  plainText: string
): { encrypted: string; iv: string; tag: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

describe('master key rotation', () => {
  const pushedKeys: Array<Buffer> = [];

  afterEach(() => {
    while (pushedKeys.length > 0) {
      const key = pushedKeys.shift()!;
      const index = CONFIG.previousMasterKeys.findIndex((candidate) => candidate.equals(key));
      if (index >= 0) CONFIG.previousMasterKeys.splice(index, 1);
    }
  });

  it('decrypts rows written with a retired key, then fails closed once it is removed', () => {
    const previousKey = crypto.createHash('sha256').update(PREVIOUS_SECRET).digest();
    const sealed = encryptWith(previousKey, 'sk-retired-upstream-key');

    expect(() =>
      decryptSecretWithCurrentKey(sealed.encrypted, sealed.iv, sealed.tag)
    ).toThrow();

    CONFIG.previousMasterKeys.push(previousKey);
    pushedKeys.push(previousKey);
    expect(decryptSecret(sealed.encrypted, sealed.iv, sealed.tag)).toBe(
      'sk-retired-upstream-key'
    );

    CONFIG.previousMasterKeys.pop();
    pushedKeys.pop();
    expect(() => decryptSecret(sealed.encrypted, sealed.iv, sealed.tag)).toThrow();
  });

  it('recognises rows already written with the current key', () => {
    const sealed = encryptSecret('sk-current-upstream-key');

    expect(
      decryptSecretWithCurrentKey(sealed.encrypted, sealed.iv, sealed.tag)
    ).toBe('sk-current-upstream-key');
    // A fresh row must not require a previous key.
    expect(decryptSecret(sealed.encrypted, sealed.iv, sealed.tag)).toBe(
      'sk-current-upstream-key'
    );
  });

  it('uses a fresh random IV for every write', () => {
    const first = encryptSecret('sk-same-value');
    const second = encryptSecret('sk-same-value');

    expect(first.iv).not.toBe(second.iv);
    expect(first.encrypted).not.toBe(second.encrypted);
  });
});
