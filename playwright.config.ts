import { defineConfig } from '@playwright/test';

const inCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // These have their own configs: production-header checks need the built Worker, and the
  // screenshot suite is a documentation tool rather than a test.
  testIgnore: ['production/**', 'screenshots/**'],
  fullyParallel: false,
  retries: inCi ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    browserName: 'chromium',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    permissions: ['microphone', 'camera'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec wrangler dev --local --var ENVIRONMENT:development --port 8787',
      cwd: 'apps/worker',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @duplex/web exec vite --host 127.0.0.1 --port 5173',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
