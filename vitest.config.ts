import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: `test-results/junit/${Date.now()}.xml` }],
      ['json', { outputFile: `test-results/json/${Date.now()}.json` }],
    ],
    globalSetup: ['./test/setup-retention.ts', './test/e2e/setup-production.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    // E2E tests share Safari — multiple MCP servers creating tabs simultaneously
    // causes tab URL matching failures. Run test files sequentially.
    fileParallelism: false,
  },
});
