import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      // Wire contracts and room/helper validation are security boundaries: hold them to the strictest bar.
      thresholds: { statements: 90, lines: 90, functions: 85, branches: 80 },
    },
  },
});
