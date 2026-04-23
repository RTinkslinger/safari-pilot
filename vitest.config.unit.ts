import { defineConfig } from 'vitest/config';

/**
 * Unit test config — fast, no Safari, no daemon, no extension.
 *
 * Unit tests cover pure logic in src/ (escaping, state machines, engine
 * selection, error shapes) that can be validated without running the
 * shipped product. They are allowed to mock NODE boundaries (fs, net,
 * child_process) but MUST NOT mock internal modules, Safari, the
 * extension, the daemon, or the MCP SDK — that would fake the shipped
 * architecture, which is exactly the failure mode that got the previous
 * 104 tests purged on 2026-04-23.
 *
 * This config deliberately does NOT share globalSetup with e2e: unit runs
 * must not require Safari or the daemon, and they parallelize freely
 * since nothing is process-global.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: `test-results/junit-unit/${Date.now()}.xml` }],
      ['json', { outputFile: `test-results/json-unit/${Date.now()}.json` }],
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reportsDirectory: './coverage/unit',
    },
  },
});
