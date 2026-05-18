/**
 * Fix A — `parseJsResult` must only treat empty raw as `CSP_BLOCKED` when the
 * caller was executing page JavaScript. For pure-AppleScript callers (e.g.,
 * `safari_list_tabs` against Safari with 0 windows, which legitimately returns
 * empty stdout), empty must be a successful empty-value, not a CSP error.
 *
 * Pre-Fix-A the empty-as-CSP rule fires unconditionally inside `parseJsResult`,
 * and `AppleScriptEngine.execute()` routes ALL osascript stdout — JS and
 * non-JS alike — through that single parser. The 2026-05-18 batch-probe RCA
 * (`bench-runs/v0136-probes/RCA-batch-regression.md` §4 Factor 2) measured 55
 * false-positive `CSP_BLOCKED` returns on `safari_list_tabs` calls when Safari
 * had no windows (vs. 0 in the matched envelope-only probe). The agent then
 * burned turns reorienting away from a phantom CSP block.
 *
 * Origin of the T13 empty-as-CSP rule: 96064f6 (2026-04-11). T13 fixed a real
 * bug for `do JavaScript` paths — a CSP-blocked script never runs, producing
 * empty stdout, and the pre-T13 parser returned `{ ok: true, value: '' }`
 * silently. That fix must be preserved: a `do JavaScript` execution that
 * returns empty IS a CSP block. Fix A only narrows the rule to the JS path.
 *
 * Per CLAUDE.md "Unit Tests (HARD RULES)": parseJsResult is pure logic
 * (string + options → EngineResult); no Safari, no daemon, no IPC. Direct
 * import + function call is the right unit-test boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseJsResult } from '../../../src/engines/js-helpers.js';
import { AppleScriptEngine } from '../../../src/engines/applescript.js';

// NOTE: vitest config uses `isolate: false` + `pool: forks` + `singleFork: true`
// (vitest.config.ts) for performance — every test file runs in the same worker
// with a shared module registry. A module-level `vi.mock('node:child_process')`
// in this file would leak the mock state into other test files that ALSO mock
// child_process (test/unit/tools/extraction-screenshot-handler.test.ts,
// test/unit/server/ensure-session-window.test.ts). The "extension returns
// empty value → fallback" branch in extraction-screenshot-handler then breaks.
//
// We use per-instance `vi.spyOn` instead. Spies are local to the constructed
// AppleScriptEngine instance and the test method's lexical scope; they do not
// touch the module registry, so isolate:false is harmless.

describe('parseJsResult — Fix A: CSP-empty guard requires JS-execution context', () => {
  it('returns CSP_BLOCKED on empty raw when called WITHOUT opts (locks the safe default for legacy JS-path callers)', () => {
    // T13 default — the entire `do JavaScript` path historically called
    // parseJsResult with no opts and depended on empty=CSP_BLOCKED to
    // surface silent CSP failures. The Fix A signature change must keep
    // the default as JS-safe so that if a future refactor drops the
    // explicit `isJsExecution: true` argument from `executeJsInTab`, the
    // JS path still flags CSP rather than silently returning ok=true.
    const result = parseJsResult('');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CSP_BLOCKED');
    expect(result.error?.retryable).toBe(false);
  });

  it('returns CSP_BLOCKED on empty raw when isJsExecution=true (preserves T13 for the JS path)', () => {
    // T13 contract: an empty `do JavaScript` stdout means the script never
    // ran (CSP block). This must remain the behaviour for callers that
    // explicitly executed page JS — `executeJsInTab`, `executeJsInFrame`,
    // and the WebView-DOM-script entry on the daemon side.
    const result = parseJsResult('', { isJsExecution: true });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CSP_BLOCKED');
    expect(result.error?.retryable).toBe(false);
  });

  it('returns ok=true with value="" on empty raw when isJsExecution=false (Fix A: non-JS callers)', () => {
    // Discrimination target: `parseJsResult('')` was unconditionally
    // CSP_BLOCKED. With the guard, non-JS callers must see a successful
    // empty value so `handleListTabs` (which calls `engine.execute()` on a
    // pure-AppleScript list script) can interpret 0 windows as "no tabs"
    // rather than "JS blocked by CSP".
    const result = parseJsResult('', { isJsExecution: false });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('AppleScriptEngine.execute wires isJsExecution=false through to parseJsResult for non-JS callers (Fix A wiring contract)', async () => {
    // Reviewer Check 6 (UNWIRED) — pure parseJsResult tests cannot prove the
    // Fix A wiring. A naive implementation that adds the parameter to
    // parseJsResult but forgets to thread it from `AppleScriptEngine.execute`
    // would pass the other tests in this file while leaving the 55-CSP_FP
    // production bug fully unfixed.
    //
    // Verifies the wiring deterministically: spy on the engine's
    // parseJsResult method, run execute() against a no-op AppleScript that
    // returns empty stdout, then assert parseJsResult was called with
    // `isJsExecution: false`. Per-instance spy — does NOT mock
    // node:child_process at module scope (which would leak across files
    // under the isolate:false vitest config).
    const engine = new AppleScriptEngine();
    const parseSpy = vi.spyOn(engine, 'parseJsResult');

    // `return ""` is a no-op AppleScript that produces empty stdout. On
    // any darwin host osascript is available; on a non-darwin host the
    // call rejects via classifyError and parseJsResult is never invoked,
    // in which case the spy.calls is empty and the test correctly fails
    // (signalling the wiring couldn't even be reached).
    await engine.execute('return ""').catch(() => undefined);

    expect(parseSpy).toHaveBeenCalled();
    // The wiring contract: every direct call from execute() must pass
    // isJsExecution: false so empty stdout from a non-JS AppleScript
    // resolves to ok=true, not CSP_BLOCKED.
    expect(parseSpy.mock.calls[0]).toEqual([expect.any(String), { isJsExecution: false }]);
  });

  it('AppleScriptEngine.executeJsInTab returns CSP_BLOCKED when do-JavaScript yields empty stdout (Fix A must NOT regress T13 for the JS path)', async () => {
    // Regression guard for the second-order effect of Fix A. `execute()` now
    // returns ok=true/value='' on empty stdout (so list_tabs stops false-
    // positiving on 0-window Safari). The JS path's `executeJsInTab` MUST
    // re-apply the empty-as-CSP rule itself, otherwise a CSP-blocked page-JS
    // call would silently return ok=true/value='' instead of CSP_BLOCKED —
    // re-introducing the pre-T13 silent-wrong-behavior bug for the JS path.
    //
    // Per-instance spy on `execute` (not module-level) — keeps mock state
    // out of the shared registry under isolate:false.
    const engine = new AppleScriptEngine();
    vi.spyOn(engine, 'execute').mockResolvedValue({ ok: true, value: '', elapsed_ms: 1 });

    const result = await engine.executeJsInTab('https://csp.example/page', 'return 42');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CSP_BLOCKED');
  });

  it('returns CSP_BLOCKED on a "Content Security Policy" raw regardless of isJsExecution flag', () => {
    // The textual CSP marker is unambiguous — it comes from osascript's
    // own error stream when WebKit refused execution. Both JS and
    // non-JS callers should treat it as CSP_BLOCKED (the underlying
    // page has a real CSP issue irrespective of which engine path
    // initiated the call). This guards Fix A from over-narrowing the
    // CSP detection: only the EMPTY heuristic is contextual; the
    // text marker is universal.
    const rawWithMarker = 'Refused to execute inline script: violates Content Security Policy directive';

    const jsResult = parseJsResult(rawWithMarker, { isJsExecution: true });
    const nonJsResult = parseJsResult(rawWithMarker, { isJsExecution: false });

    expect(jsResult.ok).toBe(false);
    expect(jsResult.error?.code).toBe('CSP_BLOCKED');
    expect(nonJsResult.ok).toBe(false);
    expect(nonJsResult.error?.code).toBe('CSP_BLOCKED');
  });
});
