/**
 * T59 handler-wiring tests — verifies ExtractionTools integrates ScreenshotPolicy
 * before invoking screencapture.
 *
 * SCOPE: handler-level wiring only (ExtractionTools in isolation).
 * Policy-logic unit tests live in test/unit/security/screenshot-policy.test.ts.
 * Full MCP-path wiring is in test/e2e/security-layers.test.ts.
 *
 * Node boundaries mocked:
 *   - node:child_process (execFile) — prevents real screencapture invocation
 *   - node:fs/promises (readFile, unlink) — prevents file I/O on fake tmp path
 *
 * These 5 tests cover the wiring code paths:
 *   1. Blocked tabUrl → handler throws ScreenshotBlockedError.
 *   2. Blocked tabUrl → execFile is NOT called (policy runs before screencapture).
 *   3. Unblocked tabUrl → execFile IS called (handler completes normally).
 *   4. No policy configured → execFile IS called even for a seed-list domain (chase.com).
 *   5. Policy configured, tabUrl absent → execFile IS called (fail-open on missing URL).
 *
 * Discrimination:
 *   - Move policy check after execFile call → test 2 fails (execFile was called).
 *   - Omit policy check entirely → tests 1 and 2 fail.
 *   - Default to new ScreenshotPolicy() when constructor arg omitted → test 4 fails
 *     (chase.com is in seed, so execFile would NOT be called).
 *   - Pass String(undefined) to checkDomain when tabUrl absent → test 5 may fail
 *     (depends on whether 'undefined' parses as URL; correct impl guards on missing key).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import { ScreenshotBlockedError } from '../../../src/errors.js';
import type { IEngine } from '../../../src/engines/engine.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => cb(null),
  ),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

const fakeEngine = {} as IEngine;
const blockPolicy = new ScreenshotPolicy({ blockedPatterns: ['^blocked\\.example\\.com$'] });

async function callHandler(tools: ExtractionTools, params: Record<string, unknown>) {
  const handler = tools.getHandler('safari_take_screenshot');
  if (!handler) throw new Error('safari_take_screenshot handler must be registered');
  return handler(params);
}

describe('safari_take_screenshot — ScreenshotPolicy handler wiring (T59)', () => {
  beforeEach(async () => {
    const { execFile } = await import('node:child_process');
    vi.mocked(execFile).mockClear();
  });

  it('throws ScreenshotBlockedError when tabUrl matches a blocked domain', async () => {
    const tools = new ExtractionTools(fakeEngine, blockPolicy);
    await expect(
      callHandler(tools, { tabUrl: 'https://blocked.example.com/page' }),
    ).rejects.toBeInstanceOf(ScreenshotBlockedError);
  });

  it('does NOT invoke screencapture (execFile) when domain is blocked', async () => {
    const { execFile } = await import('node:child_process');
    const tools = new ExtractionTools(fakeEngine, blockPolicy);
    await expect(
      callHandler(tools, { tabUrl: 'https://blocked.example.com/page' }),
    ).rejects.toBeInstanceOf(ScreenshotBlockedError);
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('invokes screencapture (execFile) when tabUrl is unblocked', async () => {
    const { execFile } = await import('node:child_process');
    const tools = new ExtractionTools(fakeEngine, blockPolicy);
    await callHandler(tools, { tabUrl: 'https://safe.example.com/page' });
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'screencapture',
      expect.any(Array),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('invokes screencapture for seed-list domain when no policy is configured', async () => {
    // Uses chase.com (in BANKING_DOMAIN_SEED) to ensure a wrong implementation that
    // defaults to new ScreenshotPolicy() would fail — the seed would block chase.com.
    const { execFile } = await import('node:child_process');
    const tools = new ExtractionTools(fakeEngine); // no policy — second arg omitted
    await callHandler(tools, { tabUrl: 'https://chase.com/' });
    expect(vi.mocked(execFile)).toHaveBeenCalled();
  });

  it('invokes screencapture when tabUrl is absent or non-string even with policy configured', async () => {
    // Spec: "tabUrl not provided → fail-open". Policy cannot block what it cannot inspect.
    // { tabUrl: null } discriminates typeof-string guard from 'tabUrl' in params guard:
    // a guard written as `'tabUrl' in params` would run checkDomain(null) — a `typeof`
    // guard correctly skips it.
    const { execFile } = await import('node:child_process');
    const tools = new ExtractionTools(fakeEngine, blockPolicy);
    await callHandler(tools, {}); // no tabUrl key
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    vi.mocked(execFile).mockClear();
    await callHandler(tools, { tabUrl: null }); // key present but non-string
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });
});
