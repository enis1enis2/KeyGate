import { defineConfig, devices } from '@playwright/test';

// The suite drives a real KeyGate instance. Point it at a disposable deployment:
//   KEYGATE_E2E_URL=http://192.168.1.12:3000 KEYGATE_E2E_ADMIN_TOKEN=... npm run test:e2e
const baseURL = process.env.KEYGATE_E2E_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
