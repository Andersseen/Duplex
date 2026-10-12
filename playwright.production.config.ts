import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Exercises the production web build (Nitro `cloudflare_module` output served by `wrangler dev`)
 * against a local signaling Worker, so the security headers shipped to production are tested
 * against hydration, WebSocket signaling, microphone/camera permissions, and WebRTC.
 */
const apiPort = process.env.DUPLEX_E2E_API_PORT ?? '8787';
const webPort = process.env.DUPLEX_E2E_PRODUCTION_WEB_PORT ?? '4173';
const API_ORIGIN = `http://localhost:${apiPort}`;
const WEB_ORIGIN = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  ...base,
  testDir: './e2e/production',
  testIgnore: [],
  use: { ...base.use, baseURL: WEB_ORIGIN },
  webServer: [
    ...(Array.isArray(base.webServer) ? base.webServer.slice(0, 1) : []),
    {
      command: `pnpm --filter @duplex/web build:cloudflare && pnpm --filter @duplex/worker exec wrangler dev --config ../web/wrangler.jsonc --local --port ${webPort}`,
      env: { VITE_DUPLEX_API_ORIGIN: API_ORIGIN },
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 240_000,
    },
  ],
});
