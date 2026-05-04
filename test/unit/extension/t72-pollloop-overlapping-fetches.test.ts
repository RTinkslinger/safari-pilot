/**
 * T72 — pollLoop must keep a fetch always in flight (overlapping fetches).
 *
 * Background (T71 phase-1 evidence):
 * In long-running e2e sweeps, the Safari MV3 event page suspends with a
 * command queued in the daemon bridge. The pre-T72 pollLoop had this shape:
 *
 *   while (...) {
 *     const data = await httpPoll(...);     // fetch /poll, 5s daemon hold
 *     if (data?.commands) for (...) { await executeCommand(cmd); ... }
 *     // back to top → next fetch begins HERE
 *   }
 *
 * Between `httpPoll` resolving and the next iteration's `httpPoll` call,
 * there is a microtask-tick window with no fetch in flight. MV3 event
 * pages can suspend in that window (Chrome and Safari both). Daemon-trace
 * evidence: 10-second gap in extension-bg activity with a command queued
 * in the bridge waiting for /poll to pick it up.
 *
 * The fix: pre-launch the NEXT `httpPoll` before processing commands of
 * the current batch. A fetch is always in flight → MV3 event page never
 * sees an idle moment → no suspension → queued commands deliver promptly.
 *
 * This test guards the structural invariant via source-grep (matching the
 * existing test pattern in test/unit/extension/t60-pollloop-decouple.test.ts).
 * A future refactor that reverts to the sequential-await shape will fail CI
 * before regressing the flake.
 *
 * TRADE-OFF (acknowledged, matches T60 house style):
 * Source-grep tests are BRITTLE on legitimate refactors. Wrapping the pre-launch
 * in a helper (`pumpPoll()`, `Promise.race(...)`, etc.) will produce a false
 * REVISE. If a future refactor changes the literal `httpPoll(` token at the
 * call sites, these tests AND the production code must be updated together.
 * The e2e sweep flake-rate (target: <20% post-T72, was 80% pre-T72) is the
 * authoritative behavioural oracle. These tests catch obvious regressions
 * fast; the e2e suite catches semantic regressions slower.
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

function getPollLoopBody(): string {
  const match = BACKGROUND_JS.match(/async function pollLoop\([^)]*\)\s*\{[\s\S]*?\n\}/);
  expect(match, 'pollLoop function not found in background.js').not.toBeNull();
  return match![0];
}

describe('T72 — pollLoop overlapping fetches', () => {
  it('pollLoop pre-launches the FIRST httpPoll BEFORE entering the while loop', () => {
    const body = getPollLoopBody();
    // The first httpPoll call must appear BEFORE the `while (` keyword.
    const firstFetchIdx = body.indexOf('httpPoll(');
    const whileIdx = body.indexOf('while (');
    expect(firstFetchIdx, 'pollLoop must call httpPoll() at least once').toBeGreaterThan(-1);
    expect(whileIdx, 'pollLoop must contain a while loop').toBeGreaterThan(-1);
    expect(
      firstFetchIdx,
      'T72: the first httpPoll() must be invoked BEFORE entering the while loop ' +
        'so a fetch is in flight when the loop body runs. If httpPoll only appears ' +
        'inside the loop body, MV3 can suspend the event page during the iteration ' +
        'transition (T71 phase-1 evidence: 10s gap with command queued).',
    ).toBeLessThan(whileIdx);
  });

  it('pollLoop assigns the in-flight poll to a re-assignable variable (let, not const)', () => {
    const body = getPollLoopBody();
    // The pre-launched fetch must be stored in a `let` so the loop body can
    // re-launch it for the next iteration. A `const` assignment would prevent
    // the pipelining pattern.
    expect(
      /let\s+\w+\s*=\s*httpPoll\(/.test(body),
      'T72: the pre-launched httpPoll must be stored in a let-binding so the ' +
        'loop body can re-launch it before processing commands.',
    ).toBe(true);
  });

  it('the in-flight poll variable is RE-ASSIGNED with a new httpPoll inside the loop body', () => {
    const body = getPollLoopBody();
    // Find the let binding name, then verify it's reassigned to httpPoll(
    // inside the loop body. Pattern: `let inflightPoll = httpPoll(`
    // followed by `inflightPoll = httpPoll(` later in the source.
    const letMatch = body.match(/let\s+(\w+)\s*=\s*httpPoll\(/);
    expect(letMatch, 'T72: must have `let <name> = httpPoll(...)`').not.toBeNull();
    const varName = letMatch![1];
    // Reassignment pattern (excluding the original let).
    const reassignRegex = new RegExp(`(?<!let\\s)\\b${varName}\\s*=\\s*httpPoll\\(`);
    expect(
      reassignRegex.test(body),
      `T72: ${varName} must be re-assigned to a new httpPoll(...) call inside the ` +
        'loop body to keep a fetch always in flight across iterations.',
    ).toBe(true);
  });

  it('the in-flight poll variable is CONSUMED via `await` inside the loop body (not a decoy)', () => {
    // CRITICAL gap from initial review: without this, a buggy implementation
    // could pre-launch + reassign the inflight variable WITHOUT awaiting it,
    // and revert to a sequential `await httpPoll(...)` inside the loop. The
    // structural shape would pass the other tests while the bug persists.
    const body = getPollLoopBody();
    const letMatch = body.match(/let\s+(\w+)\s*=\s*httpPoll\(/);
    expect(letMatch, 'precondition: must have `let <name> = httpPoll(...)`').not.toBeNull();
    const varName = letMatch![1];
    const awaitRegex = new RegExp(`await\\s+${varName}\\b`);
    expect(
      awaitRegex.test(body),
      `T72: the inflight-poll variable (${varName}) must be CONSUMED via ` +
        '`await ' + varName + '` somewhere in pollLoop. Without this, the ' +
        'pre-launched fetch is a decoy that is never awaited — the loop ' +
        'body could still call `await httpPoll(...)` directly and the ' +
        'pipelining invariant would be silently broken.',
    ).toBe(true);
  });

  it('no bare `await httpPoll(...)` appears anywhere in pollLoop (only the inflight variable is awaited)', () => {
    // The pipelining invariant requires that pollLoop's only fetch-await is
    // the in-flight variable. A bare `await httpPoll(...)` anywhere in the
    // body means a fetch is launched + awaited synchronously, with the
    // microsecond gap that MV3 can suspend in.
    const body = getPollLoopBody();
    expect(
      /await\s+httpPoll\(/.test(body),
      'T72: pollLoop must NOT contain a bare `await httpPoll(...)`. The pipelining ' +
        'pattern requires that all fetches are pre-launched as expressions ' +
        '(stored in the inflight variable) and then awaited via that variable. ' +
        'A direct `await httpPoll(...)` defeats the pipelining and reintroduces ' +
        'the MV3 suspension gap.',
    ).toBe(false);
  });

  it('the await of the in-flight variable lives inside the while-loop try-block (error-path parity, BACKOFF_MS-protected)', () => {
    // MAJOR gap from initial review: the pre-launched fetch can throw on
    // cold-start (network blip, AbortError, TimeoutError). The existing
    // pollLoop has a BACKOFF_MS retry ladder in `catch (err)` INSIDE the
    // while loop. If the await of the inflight variable sits OUTSIDE that
    // try-catch — even if some other unrelated try-catch exists nearby —
    // errors crash pollLoop instead of hitting the retry ladder.
    //
    // Second-review revision: the original "any try-open before, any catch
    // after" check admitted a sibling-try evasion (decoy try-block before +
    // unrelated try-catch later). Replacement is stronger:
    //   1. await of inflight var must be INSIDE the while-loop body
    //   2. there must be a try-block in the while-body that brackets the
    //      await AND its catch block contains the BACKOFF_MS retry ladder
    //      signature.
    const body = getPollLoopBody();
    const letMatch = body.match(/let\s+(\w+)\s*=\s*httpPoll\(/);
    expect(letMatch).not.toBeNull();
    const varName = letMatch![1];
    const awaitRegex = new RegExp(`await\\s+${varName}\\b`);
    const awaitMatch = awaitRegex.exec(body);
    expect(awaitMatch, 'precondition: await of inflight variable must exist').not.toBeNull();
    const awaitIdx = awaitMatch!.index;

    // Constraint 1: await is inside the while-loop body (not before the loop
    // and not after its closing brace).
    const whileIdx = body.indexOf('while (');
    const whileBodyOpenBrace = body.indexOf('{', whileIdx);
    expect(whileBodyOpenBrace, 'precondition: while-loop must have a body').toBeGreaterThan(-1);
    expect(
      awaitIdx,
      `T72: await ${varName} must be INSIDE the while-loop body (after its ` +
        'opening brace). A sibling try-catch before the loop does NOT count.',
    ).toBeGreaterThan(whileBodyOpenBrace);

    // Constraint 2: a try-block precedes the await within the while-body, AND
    // a `} catch` follows it that contains the BACKOFF_MS retry-ladder
    // signature (proves it's the existing retry ladder, not an unrelated
    // try-catch).
    const before = body.slice(0, awaitIdx);
    const after = body.slice(awaitIdx);
    const lastTryOpen = before.lastIndexOf('try {');
    expect(
      lastTryOpen,
      'T72: await must be inside a try-block.',
    ).toBeGreaterThan(whileBodyOpenBrace);

    const nextCatchOpen = after.indexOf('} catch');
    expect(nextCatchOpen, 'T72: a `} catch` must follow the await').toBeGreaterThan(-1);
    // Slice the catch block — from `} catch` until the next blank-line / end
    // of pollLoop. Conservative: take everything up to the end of the body.
    const catchBlock = after.slice(nextCatchOpen);
    expect(
      /BACKOFF_MS|attempts\+\+/.test(catchBlock),
      'T72: the try-catch surrounding the inflight-await must be the existing ' +
        'BACKOFF_MS retry ladder (signature: BACKOFF_MS or attempts++ in the ' +
        'catch). A decoy try-catch that does not retry would silently drop ' +
        'cold-start fetch errors.',
    ).toBe(true);
  });

  it('the loop body re-launches the next httpPoll BEFORE awaiting executeCommand', () => {
    const body = getPollLoopBody();
    // Within the loop body, the order must be:
    //   1. await <inflight>           — get current batch
    //   2. <inflight> = httpPoll(...) — kick next batch  ← BEFORE step 3
    //   3. await executeCommand(...)  — process current
    //
    // Pattern check: index of `httpPoll(` reassignment must come before
    // `await executeCommand(` somewhere in the body.
    const letMatch = body.match(/let\s+(\w+)\s*=\s*httpPoll\(/);
    expect(letMatch).not.toBeNull();
    const varName = letMatch![1];

    // Find the FIRST reassignment (skip the let-binding occurrence).
    const reassignPattern = new RegExp(`\\b${varName}\\s*=\\s*httpPoll\\(`, 'g');
    const allMatches = [...body.matchAll(reassignPattern)];
    // First match is the `let` declaration; second match (if any) is the reassignment.
    expect(
      allMatches.length,
      `T72: expected at least 2 occurrences of ${varName} = httpPoll(...) — ` +
        'one in the let-binding (pre-launch) and one as the in-loop reassignment.',
    ).toBeGreaterThanOrEqual(2);

    const reassignIdx = allMatches[1].index!;
    const executeCommandIdx = body.indexOf('await executeCommand(');
    expect(
      executeCommandIdx,
      'pollLoop must still call await executeCommand for command processing',
    ).toBeGreaterThan(-1);
    expect(
      reassignIdx,
      'T72: the reassignment of the in-flight poll must come BEFORE ' +
        'await executeCommand(...) so the next /poll fetch is in flight while ' +
        'the current batch is being processed. Putting it after defeats the ' +
        'purpose — the page can suspend during a long-running executeCommand.',
    ).toBeLessThan(executeCommandIdx);
  });
});
