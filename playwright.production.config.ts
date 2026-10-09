import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Exercises the production web build (Nitro `cloudflare_module` output served by `wrangler dev`)
 * against a local signaling Worker, so the security headers shipped to production are tested
 * against hydration, WebSocket signaling, microphone/camera permissions, and WebRTC.
 */
const API_ORIGIN = 'http://localhost:8787';

export default defineConfig({
  ...base,
  testDir: './e2e/production',
  testIgnore: [],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    ...(Array.isArray(base.webServer) ? base.webServer.slice(0, 1) : []),
    {
      command:
        'pnpm --filter @duplex/web build:cloudflare && pnpm --filter @duplex/worker exec wrangler dev --config ../web/wrangler.jsonc --local --port 4173',
      env: { VITE_DUPLEX_API_ORIGIN: API_ORIGIN },
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
