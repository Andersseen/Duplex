import { defineConfig } from '@playwright/test';

const inCi = Boolean(process.env.CI);
const apiPort = process.env.DUPLEX_E2E_API_PORT ?? '8787';
const webPort = process.env.DUPLEX_E2E_WEB_PORT ?? '5173';
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;

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
    baseURL: webOrigin,
    browserName: 'chromium',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    permissions: ['microphone', 'camera'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm exec wrangler dev --local --var ENVIRONMENT:development --port ${apiPort}`,
      cwd: 'apps/worker',
      url: `${apiOrigin}/health`,
      reuseExistingServer: !inCi,
      timeout: 60_000,
    },
    {
      command: `pnpm --filter @duplex/web exec vite --host 127.0.0.1 --port ${webPort}`,
      env: { VITE_DUPLEX_API_ORIGIN: apiOrigin },
      url: webOrigin,
      reuseExistingServer: !inCi,
      timeout: 60_000,
    },
  ],
});
