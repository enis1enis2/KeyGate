import { defineConfig } from 'vitest/config';

// DECISION: Tests never touch the real SQLite file. Each worker gets its own
// throwaway database in the OS temp directory plus an explicit test secret.
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
