import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll } from 'vitest';

// Must run before any test file imports src/config.ts.
process.env.NODE_ENV = 'test';
process.env.KEYGATE_MASTER_KEY = 'keygate_test_master_key_at_least_16_chars';
process.env.KEYGATE_ADMIN_TOKEN = 'keygate_test_admin_token_at_least_16_chars';
process.env.LOG_LEVEL = 'silent';

const dbPath = path.join(os.tmpdir(), `keygate-test-${process.pid}.sqlite`);

function removeDbFiles(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${dbPath}${suffix}`);
    } catch {
      // File may not exist yet.
    }
  }
}

removeDbFiles();
process.env.KEYGATE_DB_PATH = dbPath;

afterAll(async () => {
  // Close the open SQLite handle first so Windows can unlink the file.
  const { closeDb } = await import('../src/db/index.js');
  closeDb();
  removeDbFiles();
});
