import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      // workerd cannot run V8 coverage, so the Worker is instrumented with Istanbul instead.
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      // Room authorization, origin checks and helper pairing live here: security-critical bar.
      thresholds: { statements: 90, lines: 90, functions: 90, branches: 80 },
    },
  },
});
