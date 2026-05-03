/**
 * T67 — storage quota in housekeeping must not block reconcile.
 *
 * Failure mode discovered 2026-05-03 (32-hour wedge, evidence in
 * ~/.safari-pilot/daemon-trace.ndjson lines 109513+).
 *
 * Pre-T67 wakeSequence ordering:
 *   loadTabCache → gcPendingStorage → cleanupStaleStorageBus → connectAndReconcile
 *
 * gcPendingStorage calls writePending (storage.local.set), which throws
 * "Exceeded storage quota" the moment storage.local crosses Safari's ~5 MB
 * limit. The throw bubbles up to wakeSequence's outer try/catch, which
 * swallows it. connectAndReconcile is NEVER reached. /connect never lands
 * on the daemon. lastReconcileTimestamp never advances. isConnected stays
 * false indefinitely — until the user manually clears storage.
 *
 * Trace pattern that revealed this (every alarm cycle, for 32+ hours):
 *   init_proceeding → wake_setup_error("Exceeded storage quota") → setup_completed
 *
 * Notably MISSING from each cycle: any /connect-related event. The system
 * is fully alive, the wake routine completes, but the critical reconcile
 * step is skipped because an upstream housekeeping write throws.
 *
 * The structural fix is threefold:
 *   1. Re-order wakeSequence so connectAndReconcile runs BEFORE any storage
 *      write (gc, cleanup). Reconcile becomes critical-path, housekeeping
 *      becomes best-effort.
 *   2. writePending gains quota recovery (mirror saveTabCache's existing
 *      pattern at extension/background.js:43-58): catch quota errors,
 *      emergency-clean the store via remove(), retry the set().
 *   3. Wrap each step of wakeSequence in its own try/catch and emit a
 *      step-tagged trace event (`wake_step_error` with `step:` field) so
 *      future operators have a discriminator in trace logs and the
 *      diagnostic-blindness symptom that hid this bug for 32 hours
 *      doesn't recur.
 *
 * Tests are a mix of structural invariants (matching T60's pattern in
 * t60-pollloop-decouple.test.ts) and one behavioral test that exercises
 * writePending's quota-recovery branch by extracting the source via regex
 * and eval-ing in a sandbox with a stubbed `browser.storage.local`.
 *
 * Reviewer notes (2026-05-03 round 1):
 *   - Initial structural-only tests had two CRITICAL weak oracles
 *     (trivially-passable on /catch/+/quota/ substrings; gameable on
 *     try/catch counts). Strengthened in this revision to assert specific
 *     recovery semantics (remove + retry) and step-tagged trace events,
 *     plus a behavioral test that actually verifies the catch handles
 *     a quota throw without re-throwing.
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

function extractFunctionBody(source: string, fnName: string): string {
  const re = new RegExp(`async function ${fnName}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`);
  const match = source.match(re);
  if (!match) throw new Error(`function ${fnName} not found in source`);
  return match[0];
}

describe('T67 — storage quota in housekeeping must not block reconcile', () => {
  // ─── Structural invariants ────────────────────────────────────────────────

  it('wakeSequence calls connectAndReconcile BEFORE gcPendingStorage', () => {
    const body = extractFunctionBody(BACKGROUND_JS, 'wakeSequence');
    const reconcileIdx = body.indexOf('connectAndReconcile(');
    const gcIdx = body.indexOf('gcPendingStorage(');

    expect(reconcileIdx).toBeGreaterThanOrEqual(0);
    expect(gcIdx).toBeGreaterThanOrEqual(0);
    expect(
      reconcileIdx < gcIdx,
      'wakeSequence calls gcPendingStorage BEFORE connectAndReconcile — ' +
        'a quota throw in gc will prevent /connect from landing. See ' +
        '~/.safari-pilot/daemon-trace.ndjson around 2026-05-02T02:54:52 ' +
        'for the original failure pattern.',
    ).toBe(true);
  });

  it('wakeSequence calls connectAndReconcile BEFORE cleanupStaleStorageBus', () => {
    const body = extractFunctionBody(BACKGROUND_JS, 'wakeSequence');
    const reconcileIdx = body.indexOf('connectAndReconcile(');
    const cleanupIdx = body.indexOf('cleanupStaleStorageBus(');

    expect(cleanupIdx).toBeGreaterThanOrEqual(0);
    expect(reconcileIdx < cleanupIdx).toBe(true);
  });

  it('writePending catch block calls remove() AND retries set() (recovery semantics, not just substrings)', () => {
    // Reviewer-flagged CRITICAL fix: prior version used /catch/.test(body) +
    // /quota/i.test(body), which a "// quota — TODO" comment satisfied while
    // the bug remained intact. This revision asserts the actual recovery
    // pattern: a remove() call AND a retry set() call, both inside the catch.
    const body = extractFunctionBody(BACKGROUND_JS, 'writePending');

    // Extract just the catch block body. Match `} catch (...) { ... }` with
    // balanced-brace tolerance via a non-greedy match anchored to the function's
    // closing brace.
    const catchMatch = body.match(/\}\s*catch\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
    expect(
      catchMatch,
      'writePending has no try/catch block — cannot recover from quota throws.',
    ).not.toBeNull();
    const catchBody = catchMatch![1];

    // Quota-specific check (not just any error).
    expect(
      /quota/i.test(catchBody),
      'writePending\'s catch block does not branch on "quota" — non-quota ' +
        'errors must re-throw to preserve diagnostics.',
    ).toBe(true);

    // The recovery itself: must call remove() to free space.
    expect(
      /browser\.storage\.local\.remove\s*\(/.test(catchBody),
      'writePending\'s catch block does not call browser.storage.local.remove() — ' +
        'without removing keys, the storage stays full and any retry will throw again. ' +
        'Mirror saveTabCache\'s pattern at extension/background.js:43-58.',
    ).toBe(true);

    // The retry: must call set() a second time after recovery.
    expect(
      /browser\.storage\.local\.set\s*\(/.test(catchBody),
      'writePending\'s catch block does not retry browser.storage.local.set() — ' +
        'without retry, the pending dict is never persisted after recovery and ' +
        'in-flight commands lose their tracking entry.',
    ).toBe(true);
  });

  it('wakeSequence emits step-tagged trace events for per-step failure isolation', () => {
    // Reviewer-flagged CRITICAL fix: prior version counted `try {` and
    // `} catch (` substrings, which 4 empty try/catches at the top of the
    // function trivially satisfied. This revision asserts the trace-event
    // contract that proves per-step isolation AND closes the
    // diagnostic-blindness gap (32-hour wedge was invisible because the
    // single `wake_setup_error` event didn\'t identify which step failed).
    const body = extractFunctionBody(BACKGROUND_JS, 'wakeSequence');

    // The new event name discriminates per-step from the legacy single-blob
    // wake_setup_error. Either token is acceptable — the requirement is
    // that the trace event carries a step identifier.
    const hasStepEvent =
      /wake_step_error/.test(body) ||
      /wake_(load|reconcile|gc|cleanup)_error/.test(body);
    expect(
      hasStepEvent,
      'wakeSequence does not emit step-tagged trace events. Without per-step ' +
        'discrimination, future failures will reproduce the diagnostic blindness ' +
        'that hid the original 32-hour wedge — operators see "wake_setup_error" ' +
        'but cannot tell which of 4 steps failed without reading source.',
    ).toBe(true);

    // Each of the four steps must be identified by tag in the trace stream.
    // Either via separate event names (wake_load_error, wake_reconcile_error,
    // wake_gc_error, wake_cleanup_error) or via a `step:` field carrying
    // these identifiers.
    for (const step of ['load', 'reconcile', 'gc', 'cleanup'] as const) {
      const stepRe = new RegExp(
        `wake_${step}_error|step:\\s*['"\`]${step}['"\`]|step:\\s*['"\`]${step}\\b`,
      );
      expect(
        stepRe.test(body),
        `wakeSequence has no trace event tagged for step "${step}". ` +
          `Each step must have its own catch that emits a unique trace tag ` +
          `so operators can identify which step failed from trace logs.`,
      ).toBe(true);
    }
  });

  it('connectAndReconcile body does NOT call writePending (reconcile must stay read-only on the storage-write critical path)', () => {
    // Reviewer-flagged missing-edge-case #1: even with the wakeSequence reorder,
    // if a future refactor adds writePending(...) to connectAndReconcile (or to
    // anything it calls in its critical path), the bug regresses — /connect
    // would land but the reconcile-response processing would throw and abort.
    //
    // The /connect HTTP roundtrip itself does not require any storage write;
    // acks-cleanup happens in handleReconcileResponse via removePendingEntry.
    // Per T67, removePendingEntry's writePending call is now quota-recoverable,
    // but defense in depth: assert connectAndReconcile itself doesn't introduce
    // a write that escapes recovery.
    const body = extractFunctionBody(BACKGROUND_JS, 'connectAndReconcile');
    expect(
      /\bwritePending\s*\(/.test(body),
      'connectAndReconcile calls writePending — reconcile must be read-only ' +
        'on storage writes. Move any write into a downstream best-effort step.',
    ).toBe(false);
  });

  // ─── Behavioral invariant ─────────────────────────────────────────────────

  it('writePending recovers from a quota throw without escaping (extracted+sandboxed)', async () => {
    // Reviewer-required behavioral test: stub browser.storage.local in a
    // node test (CLAUDE.md unit policy permits Node-boundary mocks), extract
    // writePending's source via regex, eval in a sandboxed scope, and assert
    // that a quota-throw on the FIRST set() does NOT escape — recovery runs.
    //
    // This is the test that catches "// quota — TODO" pseudo-fixes: a
    // re-throwing catch fails this test even though the structural tests
    // could pass.
    const writePendingSource = extractFunctionBody(BACKGROUND_JS, 'writePending');

    const setCalls: unknown[] = [];
    const removeCalls: unknown[] = [];
    let setCallCount = 0;

    const browserStub = {
      storage: {
        local: {
          set: async (arg: unknown) => {
            setCallCount += 1;
            setCalls.push(arg);
            // First call throws a Safari-shaped quota error; subsequent calls succeed.
            if (setCallCount === 1) {
              const e = new Error(
                'Invalid call to browser.storage.local.set(). Exceeded storage quota.',
              );
              throw e;
            }
            return undefined;
          },
          remove: async (key: unknown) => {
            removeCalls.push(key);
            return undefined;
          },
          // get is unused by writePending; provided for completeness.
          get: async () => ({}),
        },
      },
    };

    // Build a function that defines writePending in our sandbox. STORAGE_KEY_PENDING
    // is the only constant the function references; we provide its real value.
    const STORAGE_KEY_PENDING = 'sp_pending';
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(
      'browser',
      'STORAGE_KEY_PENDING',
      `${writePendingSource}\nreturn writePending;`,
    )(browserStub, STORAGE_KEY_PENDING);

    // Call writePending. The first set throws quota; the catch must NOT
    // re-throw to caller. Recovery: must call remove(), then retry set() at
    // least once.
    const dict = { 'cmd-1': { status: 'completed', result: { ok: true } } };
    let escaped: Error | null = null;
    try {
      await fn(dict);
    } catch (e) {
      escaped = e as Error;
    }

    expect(
      escaped,
      `writePending re-threw a quota error to caller (msg: ${escaped?.message}). ` +
        `Catch block must handle quota errors silently (after recovery), like ` +
        `saveTabCache does at extension/background.js:43-58.`,
    ).toBeNull();

    expect(
      removeCalls.length,
      'writePending\'s catch did not call browser.storage.local.remove() — ' +
        'no recovery happened; storage stays full forever.',
    ).toBeGreaterThanOrEqual(1);

    expect(
      setCallCount,
      'writePending did not retry browser.storage.local.set() after recovery — ' +
        'caller\'s pending dict was never persisted.',
    ).toBeGreaterThanOrEqual(2);
  });
});
