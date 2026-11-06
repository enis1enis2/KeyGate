import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest is configured separately from vite.config.ts so the production build never
// pulls in the test environment or coverage provider.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // The demo router and its seed data only run in the Pages build; they are
      // excluded so the coverage floor still measures the console's real API
      // client and shared UI rather than ~1.5k lines of mock fixtures.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/types.ts', 'src/main.tsx', 'src/demo/**'],
      // Ratchet: the suite currently covers the shared dialogs and the API client deeply but not
      // the tab screens, so the floor sits just below today's numbers to catch regressions
      // without pretending the UI is fully covered.
      thresholds: {
        statements: 7,
        branches: 4,
        functions: 6,
        lines: 7,
      },
    },
  },
});
