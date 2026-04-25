/**
 * T20 — `safari_eval_in_frame` must NOT use explicit `eval()`. Replace
 * with the `new Function()` pattern that the rest of the codebase uses
 * (extension/content-main.js:11 `const _Function = Function;` + `:323
 * new _Function(params.script)`).
 *
 * Pre-T20, frames.ts:122 used `result = win.eval(userScript);`. Two issues:
 * 1. Code smell — eval() leaks the enclosing scope into the user script
 *    and is the universal "do not use" pattern in modern JS.
 * 2. CSP brittleness — `eval()` is the canonical example of the
 *    `'unsafe-eval'` directive's target. Pages with a strict CSP block
 *    eval() outright. `new Function()` matches the codebase convention
 *    (content-main.js's pre-captured _Function pattern is the
 *    CSP-survival ancestor).
 *
 * Audit finding: docs/AUDIT-TASKS.md T20 (P1, H16 — tool-modules audit).
 * Origin: `b3b83a1` (2026-04-12). Security audit `162e5a5` removed an
 * engine routing flag but did not fix the `eval()` itself.
 */
import { describe, it, expect } from 'vitest';
import { FrameTools } from '../../../src/tools/frames.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';
import type { EngineResult } from '../../../src/types.js';

/**
 * Fake engine that captures the embedded JS string the handler passes.
 * Returns a stub success response so the handler completes without error.
 */
function makeCapturingEngine(): { engine: AppleScriptEngine; calls: Array<{ tabUrl: string; jsCode: string }> } {
  const calls: Array<{ tabUrl: string; jsCode: string }> = [];
  const engine = {
    name: 'applescript',
    executeJsInTab: async (tabUrl: string, jsCode: string): Promise<EngineResult> => {
      calls.push({ tabUrl, jsCode });
      return { ok: true, value: JSON.stringify({ ok: true, result: 'stub' }), elapsed_ms: 1 };
    },
  } as unknown as AppleScriptEngine;
  return { engine, calls };
}

describe('safari_eval_in_frame embedded JS (T20)', () => {
  it('does not use win.eval(userScript) — eval() is a CSP-fragile, scope-leaking pattern', async () => {
    // Discrimination target: src/tools/frames.ts:122. Pre-T20 the embedded
    // JS template inlined `result = win.eval(userScript);`. The negative
    // assertion catches a regression that re-introduces eval(). The
    // matcher is intentionally narrow to `\.eval\s*\(` so it does NOT
    // false-positive on the word "eval" appearing in a comment or
    // identifier (e.g. "evaluation" or "// eval was here").
    const { engine, calls } = makeCapturingEngine();
    const tools = new FrameTools(engine);
    const handler = tools.getHandler('safari_eval_in_frame');
    if (!handler) throw new Error('safari_eval_in_frame handler must exist');

    await handler({
      tabUrl: 'https://example.com',
      frameSelector: 'iframe#test',
      script: 'return document.title;',
    });

    expect(calls.length, 'engine.executeJsInTab must be called once').toBe(1);
    const embeddedJs = calls[0].jsCode;
    expect(embeddedJs, 'embedded JS must NOT call eval()').not.toMatch(/\beval\s*\(/);
  });

  it('uses new Function() to evaluate the user script (codebase convention)', async () => {
    // Discrimination target: T20 prescribes the `new Function()` pattern
    // matching content-main.js:323 `new _Function(params.script)`. The
    // positive assertion locks the chosen replacement so a regression
    // that drops eval() but doesn't add Function() (or replaces with a
    // different mechanism like indirect-eval `(0,eval)(...)`) still fails.
    const { engine, calls } = makeCapturingEngine();
    const tools = new FrameTools(engine);
    const handler = tools.getHandler('safari_eval_in_frame');
    if (!handler) throw new Error('safari_eval_in_frame handler must exist');

    await handler({
      tabUrl: 'https://example.com',
      frameSelector: 'iframe#test',
      script: 'return 42;',
    });

    const embeddedJs = calls[0].jsCode;
    // Match `new <something>.Function(` or `new Function(` — the chosen
    // pattern is `new win.Function(...)` per the planned fix (mirrors
    // win.eval syntactic shape; targets the FRAME's window).
    expect(embeddedJs, 'embedded JS must use new Function() to construct the user script').toMatch(/new\s+(win\.)?Function\s*\(/);
  });
});
