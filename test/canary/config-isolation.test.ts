/**
 * SD-02 regression guard: the canary suite MUST run with its own vitest
 * config and NOT load `test/e2e/setup-production.ts` via globalSetup.
 *
 * Pre-fix: `npm run test:canary` used the default `vitest.config.ts`, which
 * runs setup-production.ts. That file returns early for non-e2e runs but
 * still executes its precondition probes (TCP connect to 19474, NDJSON
 * extension_health round-trip with 5s timeout, osascript shell-out, dist/
 * existsSync) — adding a hidden dependency on Safari + daemon being
 * installed and accruing up to ~8s of latency on machines where the probes
 * time out instead of succeeding fast.
 *
 * Post-fix: `vitest.config.canary.ts` exists, declares no globalSetup, and
 * `package.json scripts.test:canary` points at it.
 *
 * Discrimination: revert package.json or remove vitest.config.canary.ts →
 * the corresponding test below fails. Restore → passes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('canary suite config isolation (SD-02)', () => {
  it('vitest.config.canary.ts exists at the project root', () => {
    expect(existsSync(join(PROJECT_ROOT, 'vitest.config.canary.ts'))).toBe(true);
  });

  it('vitest.config.canary.ts MUST NOT declare a globalSetup hook', () => {
    // This is the load-bearing assertion. Whatever else the canary config
    // does, it must keep the e2e precondition probes out of the canary path.
    // Match `globalSetup` only when it appears as a config key (`key:` form),
    // not when discussed in explanatory comments.
    const content = readFileSync(join(PROJECT_ROOT, 'vitest.config.canary.ts'), 'utf-8');
    expect(content).not.toMatch(/^\s*globalSetup\s*:/m);
  });

  it('vitest.config.canary.ts MUST NOT reference setup-production', () => {
    // Defense in depth — even if globalSetup is absent, a `setupFiles` or
    // import of `test/e2e/setup-production.ts` would re-introduce the probes.
    const content = readFileSync(join(PROJECT_ROOT, 'vitest.config.canary.ts'), 'utf-8');
    expect(content).not.toMatch(/setup-production/);
  });

  it('vitest.config.canary.ts include path covers canary, not e2e', () => {
    // Negative form is more durable than asserting an exact include array
    // shape: anything that picks up e2e files would re-import setup-production
    // via vitest's globalSetup discovery. Anything in test/canary is fine.
    const content = readFileSync(join(PROJECT_ROOT, 'vitest.config.canary.ts'), 'utf-8');
    expect(content).toMatch(/test\/canary/);
    expect(content).not.toMatch(/test\/e2e/);
  });

  it('package.json scripts.test:canary MUST invoke vitest with the canary config', () => {
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:canary']).toMatch(/vitest\.config\.canary\.ts/);
  });

  it('package.json scripts.test:all MUST run canary BEFORE the expensive e2e suite', () => {
    // Order matters: canary is the cheap packaging gate. If it ran AFTER
    // e2e, a packaging regression would only surface after ~30+ min of e2e.
    // The chain MUST be unit → canary → e2e.
    const pkg = JSON.parse(
      readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:all']).toMatch(/test:unit[^&]*&&[^&]*test:canary[^&]*&&[^&]*test:e2e/);
  });

  it('canary config invocation does not run the e2e production probes', () => {
    // Behavioural guard (the litmus from CLAUDE.md "delete a critical
    // component, does any test fail?"): even if all static checks above
    // were satisfied by accident, this asserts canary's config file path
    // actually runs without hitting setup-production.ts. The e2e setup
    // logs "E2E preconditions passed" on success and "E2E setup: ..." on
    // its early-return paths; neither phrase must appear when the canary
    // config drives a vitest run.
    //
    // Invoke vitest directly against ONE other canary test file (not this
    // one — that would recurse) using the canary config explicitly.
    const output = execSync(
      'npx vitest run -c vitest.config.canary.ts test/canary/preuninstall.test.ts',
      { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).not.toMatch(/E2E preconditions passed/);
    expect(output).not.toMatch(/E2E setup:/);
  }, 20_000);
});
