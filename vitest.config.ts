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
    setupFiles: ['./test/helpers/shared-teardown.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    // Single-fork, no module isolation: every test file runs in the SAME
    // worker process, so the shared-client.ts module singleton survives
    // across files. Removing either setting makes every file get its own
    // worker, which means every file gets its own "singleton" — i.e. one
    // MCP server per file, which is the pre-T-Harness bug. Both settings
    // are load-bearing.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    isolate: false,
    // Belt-and-suspenders against concurrent test files: even if pool config
    // were relaxed, serial file execution would keep Safari state predictable.
    fileParallelism: false,
  },
});
