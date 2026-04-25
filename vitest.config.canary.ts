import { defineConfig } from 'vitest/config';

/**
 * Canary test config — static-config probes (npm-pack file shape, release.yml
 * text, preuninstall.sh existence) that need NEITHER Safari, the daemon, nor
 * the extension. Deliberately declares no globalSetup hook.
 *
 * Pre-SD-02 (2026-04-25), the canary suite ran under the default e2e config
 * which loads the production-stack precondition probes — TCP connect to the
 * daemon, NDJSON extension health round-trip, osascript shell-out, dist
 * binary existsSync — adding a hidden dependency on Safari being installed
 * and accruing up to ~8s of latency on machines where probes time out
 * instead of succeeding fast.
 *
 * Canary is meant to be a cheap packaging gate (sub-second on a clean CI
 * runner). This split keeps it that way. The regression guard at
 * `test/canary/config-isolation.test.ts` enforces the contract.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/canary/**/*.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: `test-results/junit-canary/${Date.now()}.xml` }],
      ['json', { outputFile: `test-results/json-canary/${Date.now()}.json` }],
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['scripts/**/*.sh', '.github/workflows/*.yml', 'package.json'],
      reportsDirectory: './coverage/canary',
    },
  },
});
