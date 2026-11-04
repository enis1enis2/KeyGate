// Master-key rotation helper.
//
// Rotation procedure:
//   1. Generate a new key:                     openssl rand -hex 32
//   2. Set KEYGATE_MASTER_KEY to the new key and KEYGATE_MASTER_KEY_PREVIOUS to the old key.
//   3. Restart KeyGate. Decryption of old rows keeps working because both keys are tried.
//   4. Run `npm run reencrypt` (this script) to rewrite every row with the new key.
//   5. Remove KEYGATE_MASTER_KEY_PREVIOUS and restart.
//
// The script is idempotent: rows already on the current version are skipped, and a row that
// cannot be decrypted is left untouched and reported instead of being destroyed.

import { getDb, closeDb } from './db/index.js';
import {
  CURRENT_KEY_VERSION,
  decryptSecret,
  decryptSecretWithCurrentKey,
  encryptSecret,
} from './crypto.js';

interface KeyRow {
  id: string;
  key_name: string;
  encrypted_key: string;
  iv: string;
  tag: string;
  key_version: number;
}

function main(): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, key_name, encrypted_key, iv, tag, key_version FROM api_keys`)
    .all() as KeyRow[];

  const update = db.prepare(
    `UPDATE api_keys
        SET encrypted_key = ?, iv = ?, tag = ?, key_version = ?, updated_at = datetime('now')
      WHERE id = ?`
  );

  let rewritten = 0;
  let skipped = 0;
  const failed: string[] = [];

  const rotate = db.transaction(() => {
    for (const row of rows) {
      // Test decryption with the current key: if it succeeds the row is already on it, even
      // if key_version is stale after a prior rotation or a partial run.
      try {
        decryptSecretWithCurrentKey(row.encrypted_key, row.iv, row.tag);
        skipped += 1;
        continue;
      } catch {
        // Fall through and try to rotate using any available key (current or previous).
      }

      try {
        const plainText = decryptSecret(row.encrypted_key, row.iv, row.tag);
        const next = encryptSecret(plainText);
        update.run(next.encrypted, next.iv, next.tag, CURRENT_KEY_VERSION, row.id);
        rewritten += 1;
      } catch {
        // Never log the secret or ciphertext. The key name is enough to locate the row.
        failed.push(`${row.key_name} (${row.id})`);
      }
    }
  });
  rotate();

  console.log(`Rows examined : ${rows.length}`);
  console.log(`Re-encrypted  : ${rewritten}`);
  console.log(`Already current: ${skipped}`);

  if (failed.length > 0) {
    console.error(`Could not decrypt ${failed.length} row(s):`);
    for (const name of failed) console.error(`  - ${name}`);
    console.error(
      'These rows still use an unknown key. Restore the previous master key in ' +
        'KEYGATE_MASTER_KEY_PREVIOUS and run this script again.'
    );
    process.exitCode = 1;
  }

  closeDb();
}

main();
