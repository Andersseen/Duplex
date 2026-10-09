import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Regenerates the README screenshots in docs/assets with `pnpm docs:screenshots`.
 * Kept out of the normal E2E run: it is a documentation tool, not a test of behavior.
 */
export default defineConfig({
  ...base,
  testDir: './e2e/screenshots',
  testIgnore: [],
  retries: 0,
  use: {
    ...base.use,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  webServer: [
    ...(Array.isArray(base.webServer) ? base.webServer : []),
    {
      command: 'pnpm --filter @duplex/helper exec ng serve --port 4200 --host 127.0.0.1',
      url: 'http://127.0.0.1:4200',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
