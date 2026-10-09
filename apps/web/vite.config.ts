import analog from '@analogjs/platform';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The worker (`pnpm dev` runs it alongside) serves /health and /api/*. Analog's own
// server routes move to /_analog so they do not shadow the worker's /api.
const WORKER_ORIGIN = 'http://localhost:8787';

/**
 * Response headers for the production web Worker. They are applied by Nitro route rules (SSR
 * responses) and written to the static `_headers` file (prerendered assets). Development keeps
 * none of them: Vite's HMR needs inline scripts and its own WebSocket.
 *
 * Content-Security-Policy keeps `'unsafe-inline'` for scripts because Angular's SSR output embeds
 * two inline bootstrap scripts (event-replay contract and hydration state) that have no nonce yet.
 * Everything else is locked down; see docs/security.md for the remaining gap.
 */
function securityHeaders(apiOrigin: string | undefined): Record<string, string> {
  const connect = ["'self'"];
  if (apiOrigin) {
    const url = new URL(apiOrigin);
    connect.push(url.origin, `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`);
  }
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob: mediastream:",
      `connect-src ${connect.join(' ')}`,
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // The room URL is a bearer capability, so it must never leak through a Referer header.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=(self)',
  };
}

export default defineConfig(({ command }) => ({
  build: { target: ['es2022'] },
  resolve: { mainFields: ['module'] },
  server: {
    proxy: {
      '/health': WORKER_ORIGIN,
      '/api': { target: WORKER_ORIGIN, ws: true },
    },
  },
  plugins: [
    analog({
      apiPrefix: '/_analog',
      nitro:
        command === 'build'
          ? {
              routeRules: {
                '/**': { headers: securityHeaders(process.env['VITE_DUPLEX_API_ORIGIN']) },
              },
            }
          : {},
    }),
    tailwindcss(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8' as const,
      include: ['src/app/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/app/app.config*.ts'],
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      // General application code target, set just under the measured baseline to block regressions.
      thresholds: { statements: 85, lines: 88, functions: 85, branches: 75 },
    },
  },
}));
