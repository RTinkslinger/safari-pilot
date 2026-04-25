/**
 * T13 — AppleScriptEngine.parseJsResult must classify a BARE empty string
 * as CSP_BLOCKED, not as a successful empty-string return.
 *
 * Pre-T13: a triple-nested conditional in parseJsResult (applescript.ts:264-280)
 * dropped the `raw === ''` case at the innermost level. The OUTER + MIDDLE
 * branches matched empty raw, but the INNER `return CSP_BLOCKED` only fired
 * when raw contained "content security policy" or "blocked by csp" text.
 * Empty raw fell through, JSON.parse('') threw, the catch swallowed it, and
 * the function returned `{ ok: true, value: '' }` — silent wrong behavior on
 * CSP-protected pages.
 *
 * Audit finding: docs/AUDIT-TASKS.md T13 (P1 silent-wrong-behavior).
 * Origin: 96064f6 (2026-04-11) — never modified since creation.
 *
 * Per CLAUDE.md "Unit Tests (HARD RULES)": parseJsResult is pure logic
 * (string → EngineResult); no Safari, no daemon, no IPC. Direct construction
 * of AppleScriptEngine + method call is the right unit-test boundary.
 */
import { describe, it, expect } from 'vitest';
import { AppleScriptEngine } from '../../../src/engines/applescript.js';

describe('AppleScriptEngine.parseJsResult — T13 CSP empty-string detection', () => {
  it('returns CSP_BLOCKED when raw is the empty string', () => {
    // Discrimination target: applescript.ts:264-280. Pre-fix, raw === ''
    // hit the OUTER + MIDDLE conditionals but failed the INNER and fell
    // through to JSON.parse('') → catch → return { ok: true, value: '' }.
    // Production callers (parseJsResult is invoked from the AppleScript
    // do-JavaScript path at lines 42, 213, 240) saw silent success on
    // CSP-blocked pages.
    const engine = new AppleScriptEngine();

    const result = engine.parseJsResult('');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CSP_BLOCKED');
    expect(result.error?.retryable).toBe(false);
  });

  it('returns CSP_BLOCKED when raw contains the "Content Security Policy" text marker', () => {
    // Locks the existing CSP-text path so the T13 simplification doesn't
    // accidentally drop it. Reverting the simplification to a bare
    // `if (raw === '') return CSP_BLOCKED` (without the includes() checks)
    // would fail this test.
    const engine = new AppleScriptEngine();

    const result = engine.parseJsResult('Refused to execute inline script: violates Content Security Policy directive');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CSP_BLOCKED');
  });

  it('returns ok=true with the raw string when the result is a non-CSP, non-JSON, non-empty string', () => {
    // Regression check: the fallback `return { ok: true, value: raw }`
    // (applescript.ts:323) must still fire for legitimate non-JSON
    // string returns. A regression that over-broadened the empty/CSP
    // check (e.g. `if (raw.trim() === '' || ...)`) would mis-classify
    // ordinary non-empty strings.
    const engine = new AppleScriptEngine();

    const result = engine.parseJsResult('hello world');

    expect(result.ok).toBe(true);
    expect(result.value).toBe('hello world');
  });
});
