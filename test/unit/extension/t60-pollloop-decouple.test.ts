/**
 * T60 — pollLoop must be decoupled from the wake-setup lock.
 *
 * Pre-T60 architecture: `initialize()` set `isWakeRunning = true`, awaited
 * `wakeSequence()` (which awaited `pollLoop()` internally), and only cleared
 * the flag in the `finally`. Because `pollLoop` is a forever loop, the
 * `finally` only ran on a thrown error. Once Safari's MV3 event-page
 * suspended the page mid-`fetch('/poll')`, the fetch promise became
 * unresolvable, the await never returned, the `finally` never fired, and
 * `isWakeRunning` stayed `true` permanently — every subsequent alarm-wake
 * `initialize()` call bailed at the early-return path. Symptom: `alarm_fire`
 * trace events continue every 60s, but no `/connect` or `/poll` requests
 * reach the daemon, queued commands never drain, e2e tests time out at 10s.
 *
 * The fix is structural: `wakeSequence` runs the BOUNDED setup phase only
 * (tab cache + storage GC + cleanup + /connect+reconcile), and `initialize`
 * starts `pollLoop` AFTER `wakeSequence` returns and AFTER the lock is
 * cleared, via `supersedePollLoop()` which aborts any prior pollLoop's
 * AbortController (releasing wedged fetches) and starts a fresh one.
 *
 * This test guards the structural invariants so a future refactor that
 * accidentally moves `pollLoop` back into `wakeSequence` (or removes the
 * AbortController plumbing) fails CI before the bug ships.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const BACKGROUND_JS = readFileSync(
  resolve(__filename, '../../../../extension/background.js'),
  'utf-8',
);

describe('T60 — pollLoop decoupled from wake lock', () => {
  it('wakeSequence does NOT call pollLoop (was the dormancy bug)', () => {
    // Extract the wakeSequence function body. It must NOT contain a
    // pollLoop( call anywhere — pollLoop runs outside the lock now.
    const match = BACKGROUND_JS.match(
      /async function wakeSequence\([^)]*\)\s*\{[\s\S]*?\n\}/,
    );
    expect(match, 'wakeSequence function not found').not.toBeNull();
    const body = match![0];
    expect(
      /pollLoop\s*\(/.test(body),
      'wakeSequence still calls pollLoop — the T60 fix has been reverted; ' +
        'a forever-pending poll fetch will hold isWakeRunning hostage and ' +
        'cause extension dormancy.',
    ).toBe(false);
  });

  it('initialize calls supersedePollLoop AFTER the wake-setup lock is released', () => {
    const match = BACKGROUND_JS.match(
      /async function initialize\([^)]*\)\s*\{[\s\S]*?\n\}/,
    );
    expect(match, 'initialize function not found').not.toBeNull();
    const body = match![0];
    // supersedePollLoop call must appear after the closing brace of the
    // try/finally that clears isWakeRunning. We validate by checking the
    // call comes AFTER `isWakeRunning = false` in the source order.
    const flagClearIdx = body.indexOf('isWakeRunning = false');
    const supersedeIdx = body.indexOf('supersedePollLoop(');
    expect(flagClearIdx, 'isWakeRunning=false not found in initialize').toBeGreaterThan(-1);
    expect(supersedeIdx, 'supersedePollLoop call not found in initialize').toBeGreaterThan(-1);
    expect(
      supersedeIdx,
      'supersedePollLoop must run AFTER isWakeRunning is cleared so a wedged ' +
        'pollLoop cannot pin the wake lock.',
    ).toBeGreaterThan(flagClearIdx);
  });

  it('supersedePollLoop aborts the prior controller before starting a new pollLoop', () => {
    const match = BACKGROUND_JS.match(
      /function supersedePollLoop\([^)]*\)\s*\{[\s\S]*?\n\}/,
    );
    expect(match, 'supersedePollLoop function not found').not.toBeNull();
    const body = match![0];
    expect(/pollLoopController\.abort\(\)/.test(body)).toBe(true);
    expect(/new AbortController\(\)/.test(body)).toBe(true);
    expect(/pollLoop\(controller\.signal\)/.test(body)).toBe(true);
  });

  it('pollLoop signature accepts an AbortSignal and uses it as the loop guard', () => {
    expect(/async function pollLoop\(abortSignal\)/.test(BACKGROUND_JS)).toBe(true);
    // The while-condition must be guarded by abortSignal so a pending
    // iteration short-circuits when superseded.
    expect(
      /while \(!\(abortSignal && abortSignal\.aborted\)\)/.test(BACKGROUND_JS),
    ).toBe(true);
  });

  it('httpPoll combines the per-fetch timeout with the external abort signal', () => {
    expect(/async function httpPoll\(externalAbortSignal\)/.test(BACKGROUND_JS)).toBe(true);
    expect(
      /AbortSignal\.any\(\[externalAbortSignal, timeoutSignal\]\)/.test(
        BACKGROUND_JS,
      ),
      'httpPoll must combine the externally provided abort signal with its ' +
        '10s timeout signal so the prior pollLoop iteration can be killed by ' +
        'supersedePollLoop, even if Safari has wedged the fetch.',
    ).toBe(true);
  });

  it('pollLoop emits a pollloop_aborted trace event when the abort signal fires', () => {
    // The aborted-trace contract is what e2e tests / future debugging will
    // look for in daemon-trace.ndjson to discriminate the fix from a
    // reverted state.
    expect(/pollloop_aborted/.test(BACKGROUND_JS)).toBe(true);
  });

  it('initialize emits init_proceeding and init_coalesced diagnostic traces', () => {
    // These are the discriminator events for confirming the fix in
    // daemon-trace.ndjson under load. If T60 dormancy ever returns, the
    // trace will show repeated init_coalesced without setup_completed.
    expect(/'init_proceeding'/.test(BACKGROUND_JS)).toBe(true);
    expect(/'init_coalesced'/.test(BACKGROUND_JS)).toBe(true);
    expect(/'setup_completed'/.test(BACKGROUND_JS)).toBe(true);
  });
});
