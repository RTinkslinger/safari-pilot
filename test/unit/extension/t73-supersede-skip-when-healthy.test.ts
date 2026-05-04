/**
 * T73 — supersedePollLoop must skip the abort cascade when pollLoop is healthy.
 *
 * Background (T72-partial validation evidence):
 * After T72 introduced overlapping fetches in pollLoop (a fetch is always in
 * flight), 5x e2e sweeps showed flake rate dropped from 80% to 40%. The
 * residual 40% traced to a different mechanism:
 *
 *   21.853 alarm_fire (KEEPALIVE_PERIOD_MIN = 1 fires every minute)
 *   22.039 pollloop_started reason=keepalive   (NEW pollloop spawning)
 *   22.040 pollloop_aborted reason=abort_signal (the IN-FLIGHT /poll fetch
 *                                                 of the healthy old pollLoop
 *                                                 was killed by the abort cascade)
 *   22-32  10s gap with no extension-bg events  (daemon waitingPolls empty,
 *                                                 commands queue, page suspends)
 *   32.547 cmd_dispatched (only when a NEW execute hits the daemon)
 *
 * The original T60 motivation for unconditional supersede was: a wedged
 * fetch that never resolves keeps the wake lock pinned. T72's pre-launch
 * pattern means a wedged fetch is now distinguishable from a healthy one —
 * a healthy pollLoop has emitted bridge_queued/cmd_dispatched events
 * recently (i.e. its fetches are resolving). The fix: track the timestamp
 * of the last successful httpPoll resolution; supersedePollLoop skips the
 * abort cascade when that timestamp is recent (<30s).
 *
 * Source-grep tests guarding the structural invariants — same pattern as
 * T60 and T72 (see header comment in t72-pollloop-overlapping-fetches.test.ts
 * for the trade-off rationale and the e2e flake-rate as the authoritative
 * behavioural oracle).
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

function getSupersedeBody(): string {
  const match = BACKGROUND_JS.match(/function supersedePollLoop\([^)]*\)\s*\{[\s\S]*?\n\}/);
  expect(match, 'supersedePollLoop function not found').not.toBeNull();
  return match![0];
}

function getPollLoopBody(): string {
  const match = BACKGROUND_JS.match(/async function pollLoop\([^)]*\)\s*\{[\s\S]*?\n\}/);
  expect(match, 'pollLoop function not found').not.toBeNull();
  return match![0];
}

describe('T73 — supersedePollLoop skips when pollLoop is healthy', () => {
  it('a module-level lastSuccessfulPoll timestamp variable is declared', () => {
    // The health check needs a "last successful poll resolved" timestamp
    // that pollLoop sets on each successful httpPoll resolution and
    // supersedePollLoop reads on each call.
    expect(
      /let\s+lastSuccessfulPoll\b/.test(BACKGROUND_JS),
      'T73: must declare a module-level `let lastSuccessfulPoll` to track ' +
        'the timestamp of the last successful httpPoll resolution. ' +
        'supersedePollLoop uses this to detect a healthy pollLoop and skip ' +
        'the abort cascade.',
    ).toBe(true);
  });

  it('pollLoop sets lastSuccessfulPoll = Date.now() in the SUCCESS try-block (not in catch / not before await)', () => {
    const body = getPollLoopBody();
    // The successful-poll timestamp must update inside pollLoop's success
    // try-block, AFTER the await of the inflight variable resolves. Reviewer
    // tightening: a buggy implementation could put the assignment inside the
    // TimeoutError catch (which is structurally AFTER the success await in
    // source order) and still pass a naive "after await" index check. We
    // narrow to: the assignment must appear inside the SAME try-block that
    // contains the inflight await, and BEFORE the matching `} catch`.
    expect(
      /lastSuccessfulPoll\s*=\s*Date\.now\(\)/.test(body),
      'T73: pollLoop must update lastSuccessfulPoll = Date.now() after each ' +
        'successful httpPoll resolution.',
    ).toBe(true);

    const letMatch = body.match(/let\s+(\w+)\s*=\s*httpPoll\(/);
    expect(letMatch).not.toBeNull();
    const inflightVar = letMatch![1];

    // Extract the success try-block (the FIRST try { ... } catch in the loop
    // body that contains `await <inflightVar>`). This is the success path —
    // the catch is the BACKOFF_MS error ladder. The assignment must live
    // inside this try AND after the await.
    const tryBlockRegex = new RegExp(
      `try\\s*\\{([\\s\\S]*?await\\s+${inflightVar}\\b[\\s\\S]*?)\\}\\s*catch`,
    );
    const tryBlockMatch = tryBlockRegex.exec(body);
    expect(
      tryBlockMatch,
      `T73: pollLoop must contain a try-block that wraps await ${inflightVar}.`,
    ).not.toBeNull();
    const tryBlockBody = tryBlockMatch![1];

    expect(
      /lastSuccessfulPoll\s*=\s*Date\.now\(\)/.test(tryBlockBody),
      `T73: lastSuccessfulPoll = Date.now() must appear INSIDE the success ` +
        'try-block (between `try {` and the matching `} catch`). Putting it ' +
        'in the catch would mark the pollLoop healthy on errors; putting it ' +
        'before the try would mark it healthy regardless of fetch outcome.',
    ).toBe(true);

    // And it must come AFTER the await within that block.
    const awaitInBlock = new RegExp(`await\\s+${inflightVar}\\b`).exec(tryBlockBody);
    const setInBlock = /lastSuccessfulPoll\s*=\s*Date\.now\(\)/.exec(tryBlockBody);
    expect(awaitInBlock).not.toBeNull();
    expect(setInBlock).not.toBeNull();
    expect(
      setInBlock!.index,
      'T73: lastSuccessfulPoll must be set AFTER the await resolves, not before.',
    ).toBeGreaterThan(awaitInBlock!.index);
  });

  it('supersedePollLoop reads lastSuccessfulPoll and compares against a freshness threshold', () => {
    const body = getSupersedeBody();
    expect(
      /lastSuccessfulPoll/.test(body),
      'T73: supersedePollLoop must read lastSuccessfulPoll to decide whether ' +
        'to skip the abort cascade.',
    ).toBe(true);

    // Must compare against a numeric threshold, e.g. Date.now() - lastSuccessfulPoll < 30000.
    // Be flexible on threshold value (15s-60s reasonable) but require SOME comparison.
    expect(
      /Date\.now\(\)\s*-\s*lastSuccessfulPoll/.test(body) ||
        /lastSuccessfulPoll\s*[<>]/.test(body) ||
        /lastSuccessfulPoll\s*&&\s*Date\.now/.test(body),
      'T73: supersedePollLoop must compare lastSuccessfulPoll against a ' +
        'freshness threshold (e.g. Date.now() - lastSuccessfulPoll < 30_000). ' +
        'Reading the value alone is not enough — a comparison is required.',
    ).toBe(true);
  });

  it('supersedePollLoop emits an early-return trace when skipping (observability)', () => {
    const body = getSupersedeBody();
    // The skip path must emit a trace event so operators can see "T73 fired,
    // I chose not to abort". Without this, a future regression that breaks
    // the skip predicate is invisible in daemon-trace.ndjson.
    expect(
      /emitTrace\([^)]*supersede_skipped/.test(body) ||
        /emitTrace\([^)]*pollloop_supersede_skipped/.test(body),
      'T73: supersedePollLoop must emit a trace event when it skips the abort ' +
        'cascade. Recommended event name: `pollloop_supersede_skipped` (mirrors ' +
        'T60\'s `pollloop_aborted`/`pollloop_started` naming).',
    ).toBe(true);
  });

  it('supersedePollLoop still aborts and restarts when pollLoop is unhealthy (no early-return without check)', () => {
    const body = getSupersedeBody();
    // Verify the abort + restart path STILL exists. The fix is "skip when
    // healthy", not "remove abort". A regression that removes the abort
    // entirely would break T60's wedge-recovery contract.
    expect(
      /pollLoopController\.abort\(\)/.test(body),
      'T73: supersedePollLoop must STILL contain pollLoopController.abort() — ' +
        'the unhealthy path needs to abort the wedged pollLoop. T73 narrows ' +
        'WHEN abort runs, it does not remove abort entirely.',
    ).toBe(true);
    expect(
      /new AbortController\(\)/.test(body) && /pollLoop\(/.test(body),
      'T73: supersedePollLoop must STILL spawn a new pollLoop on the unhealthy ' +
        'path. T60 wedge-recovery contract.',
    ).toBe(true);
  });

  it('the skip-predicate threshold appears in a comparison WITH lastSuccessfulPoll (not just any literal)', () => {
    const body = getSupersedeBody();
    // Reviewer tightening: the previous version accepted any 15s-120s number
    // anywhere in the body — too permissive. A buggy implementation could
    // call `setTimeout(restart, 30000)` for an unrelated retry while
    // deleting the actual freshness comparison; tests 3 + this would still
    // pass.
    //
    // Tighten: the threshold literal must appear directly in a comparison
    // `Date.now() - lastSuccessfulPoll <op> <threshold>` or equivalent.
    // T72-partial trace evidence: longest healthy idle is ~5s (daemon
    // long-poll); >=15s gives 3x headroom; <=120s prevents wedged loops
    // from lingering. Accepts both `30000` and `30_000` styles.
    const compareRegex = /Date\.now\(\)\s*-\s*lastSuccessfulPoll\s*[<>]=?\s*(\d{2,3}_?\d{3})\b/;
    const compareMatch = compareRegex.exec(body);
    expect(
      compareMatch,
      'T73: supersedePollLoop must contain a literal comparison of the form ' +
        '`Date.now() - lastSuccessfulPoll < <ms-literal>` (or > for inverse). ' +
        'Just having `lastSuccessfulPoll` and a separate ms-literal somewhere ' +
        'is not enough — they must be wired into the SAME comparison expression.',
    ).not.toBeNull();
    const thresholdMs = parseInt(compareMatch![1].replace(/_/g, ''), 10);
    expect(
      thresholdMs,
      `T73: threshold ${thresholdMs}ms is out of the recommended [15000, 120000] ` +
        `range. <15s risks false-unhealthy under daemon long-poll holds (5s ` +
        `normal); >120s lets wedged loops linger too long.`,
    ).toBeGreaterThanOrEqual(15000);
    expect(thresholdMs).toBeLessThanOrEqual(120000);
  });
});
