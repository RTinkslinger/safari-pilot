import { describe, it, expect } from 'vitest';
import { wrapEvaluateScript } from '../../../src/tools/extraction.js';

// v0.1.37 Bug-MCP-1 — safari_evaluate's script wrapping previously interpolated
// the user's script as the body of an async function, requiring a literal
// top-level `return X;` to surface a value. Three script shapes regularly
// produced by LLM agents under bare prompts were silently returning
// `{type: "undefined"}` and abandoned by the agent:
//
//   1. Bare expression                  — `document.title`
//   2. Self-invoked arrow IIFE          — `(() => "x")()`
//   3. Self-invoked async arrow IIFE    — `(async () => "x")()`
//
// These are not "bad" scripts — they are the standard expression-as-value
// pattern the agent learned from training on every other browser MCP
// (Playwright, browser-use, etc.). The wrapper must accept them.
//
// Contract after fix — `wrapEvaluateScript(script: string): string` returns
// a function-BODY string suitable for `new Function(wrapped)()` (the
// production callsite passes it to engine.executeJsInTab which feeds it
// into an inner `(async function() { ... })()`):
//
//   - script contains a top-level `return` keyword (not inside a string
//     literal, not inside a comment, not after a property accessor) → used
//     as function body (back-compat path; existing callers preserved)
//   - otherwise → wrapped as `return (${script});` so bare expressions and
//     IIFEs return their evaluated value.
//
// Tests assert RUNTIME BEHAVIOR by executing the wrapped string. Production
// path is: handleEvaluate -> wrapEvaluateScript -> engine.executeJsInTab.
// engine.executeJsInTab runs the wrapped script in a Safari page context
// inside an `(async function() { ... })()` wrapper; the language-level
// semantics tested here (return-vs-expression detection, top-level await
// inside an async context) are identical under Node's `new Function`.
// Page-context-specific behavior (Trusted Types, CSP, postMessage
// boundaries) is tested separately in e2e — out of scope here.

async function evalWrapped(script: string): Promise<{ value: unknown; type: string }> {
  const wrapped = wrapEvaluateScript(script);
  // The wrapped string is a function body that returns a Promise<{value,type}>
  // emerging from an inner async IIFE. `new Function` is sufficient because
  // any user-script `await` lives inside the inner async function.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(wrapped) as () => Promise<{ value: unknown; type: string }>;
  return await fn();
}

describe('wrapEvaluateScript — Bug-MCP-1 contract', () => {
  // ── Expression-wrap path: scripts without top-level `return` keyword ────

  it('bare string-literal expression returns the string value', async () => {
    // Simplest case: agent writes `"ok"`. Before fix: undefined. After: "ok".
    const r = await evalWrapped('"ok"');
    expect(r.value).toBe('ok');
    expect(r.type).toBe('string');
  });

  it('self-invoked arrow IIFE returns inner value', async () => {
    // Agent writes `(() => "hello")()` — the IIFE form Playwright MCP
    // documents as the canonical evaluate input. Before fix: undefined.
    const r = await evalWrapped('(() => "hello")()');
    expect(r.value).toBe('hello');
    expect(r.type).toBe('string');
  });

  it('self-invoked async arrow IIFE awaits and returns inner value', async () => {
    const r = await evalWrapped('(async () => 42)()');
    expect(r.value).toBe(42);
    expect(r.type).toBe('number');
  });

  it('JSON.stringify call as bare expression returns its string', async () => {
    // Recurring pattern in agent stream: JSON.stringify({...}) at bottom of
    // script, no `return`. Before fix: undefined. After: JSON string.
    const r = await evalWrapped('JSON.stringify({a: 1, b: "x"})');
    expect(r.value).toBe('{"a":1,"b":"x"}');
    expect(r.type).toBe('string');
  });

  it('top-level await in bare expression resolves and returns awaited value', async () => {
    // Agents under bare prompts write `await Promise.resolve(X)` as a one-
    // liner. The fix wraps this as `return (await Promise.resolve(X));`
    // inside the inner async function — legal and resolves end-to-end.
    const r = await evalWrapped('await Promise.resolve("awaited")');
    expect(r.value).toBe('awaited');
    expect(r.type).toBe('string');
  });

  // ── Word "return" must be detected at the keyword level, not as substring ──

  it('string literal containing the word "return" is wrapped as expression (not body)', async () => {
    // CRITICAL: if implementation does naive `s.includes("return")`, it
    // would take the body path → `return "return value here"` body → which
    // happens to also work (single-statement body with return). To force a
    // discriminating case we use a literal where body-path interpretation
    // breaks: the bare string literal as a standalone statement is a
    // no-op in body context (expression statement, no return), but as an
    // expression-wrap it returns the value. Naive includes("return") sends
    // it down the body path → result undefined → test fails.
    const r = await evalWrapped('"return value here"');
    expect(r.value).toBe('return value here');
    expect(r.type).toBe('string');
  });

  it('block comment containing the word "return" is wrapped as expression', async () => {
    // Same discriminating shape: `/* return */ 42` is a bare expression
    // (42 preceded by a comment). Naive includes("return") → body path →
    // body becomes `/* return */ 42` → expression-statement, no return →
    // undefined. With keyword-aware detection: expression-wrap →
    // `return (/* return */ 42)` → 42.
    const r = await evalWrapped('/* return */ 42');
    expect(r.value).toBe(42);
    expect(r.type).toBe('number');
  });

  // ── Body-path back-compat: scripts WITH top-level `return` keyword ──────

  it('multi-statement script with literal top-level return preserves back-compat path', async () => {
    // Existing callers (and the e2e harness) write `const x = 1; return x;`
    // The fix MUST keep that working — regression guard.
    const r = await evalWrapped('const x = 7; return x * 6;');
    expect(r.value).toBe(42);
    expect(r.type).toBe('number');
  });

  it('top-level return after a comment with "return" is still detected', async () => {
    // Composite case: a leading comment mentioning "return" SHOULD NOT
    // mask a real top-level return that follows. Body path must engage.
    // (If implementation strips comments before scanning for `return`, both
    // tokens disappear from the stripped form, but the REAL `return` is
    // also stripped — bug. The robust impl strips comments + strings, then
    // checks for `return` keyword in the residue.)
    const r = await evalWrapped('/* this returns nothing */ const x = 99; return x;');
    expect(r.value).toBe(99);
    expect(r.type).toBe('number');
  });

  // ── Boundary: script that is neither expression nor has return ──────────

  it('IIFE with internal return statement returns the IIFE value (not undefined)', async () => {
    // CRITICAL: discovered empirically in /tmp/bare3-sp/Allrecipes--2-r1.stream
    // event #41. Agent writes `(() => { ...; return out; })()` — IIFE body
    // contains `return`, but that return is at brace-depth >= 1 (inside the
    // arrow function), NOT top-level for the wrapper. Naive substring/regex
    // detection matches the inner `return` and routes the whole script to
    // body-path, which then discards the IIFE's return value at the outer
    // wrapper level and the agent gets `{type:"undefined"}` despite the IIFE
    // returning correctly internally.
    //
    // Post-fix: detect top-level-return at brace-depth 0 only. IIFE body
    // returns are at depth >= 1 → expression-wrap path → IIFE evaluates and
    // its returned value bubbles through `return (${script});`.
    const r = await evalWrapped('(() => { const arr = [1,2,3]; return arr.length * 14; })()');
    expect(r.value).toBe(42);
    expect(r.type).toBe('number');
  });

  it('async IIFE with internal await + return returns the awaited value', async () => {
    // Same brace-depth detection issue with async IIFEs. The agent's
    // natural pattern: `(async () => { const x = await Promise.resolve(7); return x; })()`.
    const r = await evalWrapped('(async () => { const x = await Promise.resolve(7); return x * 6; })()');
    expect(r.value).toBe(42);
    expect(r.type).toBe('number');
  });

  it('script with statements but no return returns undefined (boundary documented)', async () => {
    // `let x = 1;` is a statement, not an expression. Wrapping as
    // `return (let x = 1;)` would be a syntax error, so the implementation
    // MUST detect this is not a valid expression and take the body path.
    // In body path with no top-level return, the value is undefined.
    // This documents the boundary: expression-wrap is only when the script
    // parses cleanly as an expression. Implementation strategies:
    //   (a) Try-parse-as-expression: wrap in expression context, on parse
    //       failure fall back to body path.
    //   (b) Detect statement-leading keywords (let/const/var/if/for/while/
    //       function/class) and route to body path.
    // Either is acceptable. This test forbids the "expression-wrap that
    // throws SyntaxError" outcome — the function must execute and return
    // undefined for this input.
    const r = await evalWrapped('let x = 1;');
    expect(r.value).toBeUndefined();
    expect(r.type).toBe('undefined');
  });
});
