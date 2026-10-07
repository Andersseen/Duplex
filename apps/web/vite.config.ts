import analog from '@analogjs/platform';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The worker (`pnpm dev` runs it alongside) serves /health and /api/*. Analog's own
// server routes move to /_analog so they do not shadow the worker's /api.
const WORKER_ORIGIN = 'http://localhost:8787';

export default defineConfig(() => ({
  build: { target: ['es2022'] },
  resolve: { mainFields: ['module'] },
  server: {
    proxy: {
      '/health': WORKER_ORIGIN,
      '/api': { target: WORKER_ORIGIN, ws: true },
    },
  },
  plugins: [analog({ apiPrefix: '/_analog' }), tailwindcss()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
  },
}));
