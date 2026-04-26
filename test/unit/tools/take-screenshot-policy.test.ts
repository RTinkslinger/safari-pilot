/**
 * T59 handler-wiring tests — verifies ExtractionTools integrates ScreenshotPolicy
 * before invoking screencapture.
 *
 * SCOPE: handler-level wiring only (ExtractionTools in isolation).
 * Policy-logic unit tests live in test/unit/security/screenshot-policy.test.ts.
 * Full MCP-path wiring is in test/e2e/security-layers.test.ts.
 *
 * ExtractionTools accepts an optional third constructor arg (screencaptureRunner)
 * for dependency injection. Tests pass a vi.fn() stub — no Node module mocking
 * needed. Production code uses defaultScreencaptureRunner (childProcess.execFile).
 *
 * Isolation note: Vitest runs with singleFork + isolate:false, so all test files
 * share a module cache. If another test file loads extraction.ts first, its top-level
 * `import { readFile }` binding captures the real node:fs/promises — a subsequent
 * vi.mock('node:fs/promises') cannot retroactively update that reference.
 *
 * Tests 3–5 therefore use a try-catch pattern: they assert the runner was called
 * (the wiring we're verifying) and that any thrown error is NOT ScreenshotBlockedError
 * (policy did not fire). Whether the handler ultimately succeeds depends on whether
 * the vi.mock intercept lands — irrelevant to wiring correctness.
 *
 * These 5 tests cover the wiring code paths:
 *   1. Blocked tabUrl → handler throws ScreenshotBlockedError.
 *   2. Blocked tabUrl → screencaptureRunner is NOT called (policy runs before screencapture).
 *   3. Unblocked tabUrl → screencaptureRunner IS called (not ScreenshotBlockedError).
 *   4. No policy configured → screencaptureRunner IS called for seed-list domain (chase.com).
 *   5. Policy configured, tabUrl absent or non-string → screencaptureRunner IS called
 *      (fail-open on missing URL; typeof guard, not 'in' guard).
 *
 * Discrimination:
 *   - Move policy check after screencaptureRunner → test 2 fails (runner was called).
 *   - Omit policy check entirely → tests 1 and 2 fail.
 *   - Default to new ScreenshotPolicy() when constructor arg omitted → test 4 fails
 *     (chase.com is in seed, so runner would NOT be called).
 *   - Use 'tabUrl' in params instead of typeof tabUrl === 'string' → test 5 fails
 *     (the null key triggers checkDomain, which may throw).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import { ScreenshotBlockedError } from '../../../src/errors.js';
import type { IEngine } from '../../../src/engines/engine.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const fakeEngine = {} as IEngine;
const blockPolicy = new ScreenshotPolicy({ blockedPatterns: ['^blocked\\.example\\.com$'] });

function makeTools(policy?: ScreenshotPolicy) {
  const runner = vi.fn().mockResolvedValue(undefined);
  const tools = new ExtractionTools(fakeEngine, policy, runner);
  return { tools, runner };
}

async function callHandler(tools: ExtractionTools, params: Record<string, unknown>) {
  const handler = tools.getHandler('safari_take_screenshot');
  if (!handler) throw new Error('safari_take_screenshot handler must be registered');
  return handler(params);
}

describe('safari_take_screenshot — ScreenshotPolicy handler wiring (T59)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ScreenshotBlockedError when tabUrl matches a blocked domain', async () => {
    const { tools } = makeTools(blockPolicy);
    await expect(
      callHandler(tools, { tabUrl: 'https://blocked.example.com/page' }),
    ).rejects.toBeInstanceOf(ScreenshotBlockedError);
  });

  it('does NOT call screencaptureRunner when domain is blocked', async () => {
    const { tools, runner } = makeTools(blockPolicy);
    await expect(
      callHandler(tools, { tabUrl: 'https://blocked.example.com/page' }),
    ).rejects.toBeInstanceOf(ScreenshotBlockedError);
    expect(runner).not.toHaveBeenCalled();
  });

  it('calls screencaptureRunner when tabUrl is unblocked', async () => {
    const { tools, runner } = makeTools(blockPolicy);
    try {
      await callHandler(tools, { tabUrl: 'https://safe.example.com/page' });
    } catch (err) {
      // readFile ENOENT is acceptable in full-suite mode (see isolation note above).
      // We only care that the runner ran and that policy did not fire.
      expect(err).not.toBeInstanceOf(ScreenshotBlockedError);
    }
    expect(runner).toHaveBeenCalledWith('png', expect.any(String));
  });

  it('calls screencaptureRunner for seed-list domain when no policy is configured', async () => {
    // Uses chase.com (in BANKING_DOMAIN_SEED) to ensure a wrong implementation that
    // defaults to new ScreenshotPolicy() would fail — the seed would block chase.com.
    const { tools, runner } = makeTools(); // no policy — second arg omitted
    try {
      await callHandler(tools, { tabUrl: 'https://chase.com/' });
    } catch (err) {
      expect(err).not.toBeInstanceOf(ScreenshotBlockedError);
    }
    expect(runner).toHaveBeenCalled();
  });

  it('calls screencaptureRunner when tabUrl is absent or non-string even with policy configured', async () => {
    // Spec: "tabUrl not provided → fail-open". Policy cannot block what it cannot inspect.
    // { tabUrl: null } discriminates typeof-string guard from 'tabUrl' in params guard:
    // a guard written as `'tabUrl' in params` would run checkDomain(null) — a `typeof`
    // guard correctly skips it.
    const { tools: tools1, runner: runner1 } = makeTools(blockPolicy);
    try {
      await callHandler(tools1, {}); // no tabUrl key
    } catch (err) {
      expect(err).not.toBeInstanceOf(ScreenshotBlockedError);
    }
    expect(runner1).toHaveBeenCalledTimes(1);

    const { tools: tools2, runner: runner2 } = makeTools(blockPolicy);
    try {
      await callHandler(tools2, { tabUrl: null }); // key present but non-string
    } catch (err) {
      expect(err).not.toBeInstanceOf(ScreenshotBlockedError);
    }
    expect(runner2).toHaveBeenCalledTimes(1);
  });
});
