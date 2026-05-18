/**
 * Fix B — `NavigationTools.handleNewTab` must recover when Safari has zero
 * windows and the caller did NOT supply `_sessionWindowId` (bench mode via
 * `SAFARI_PILOT_NO_SESSION_WINDOW=1`). Pre-Fix-B the AppleScript script
 * `tell front window` fails with `-1719` ("Can't get window 1. Invalid
 * index") or `-1700` ("Can't make missing value into type tab") and the
 * handler returns errorResponse immediately, forcing the agent to discover
 * the recovery itself (the 2026-05-18 RCA records four catastrophic tasks
 * where the agent had to fall back to `Bash osascript ... activate Safari`).
 *
 * Contract under Fix B:
 *   1. When the FIRST attempt errors with a no-front-window AppleScript code
 *      (and `_sessionWindowId` is undefined), activate Safari and retry once.
 *   2. If the retry succeeds, return the OK response with parsed tabUrl/
 *      windowId/tabIndex.
 *   3. If the retry ALSO fails, return errorResponse (no infinite recovery).
 *   4. The existing `_sessionWindowId`-supplied `WINDOW_CLOSED` recovery path
 *      is unchanged (it has its own retry).
 *   5. Unrelated AppleScript errors (e.g., -1743 PERMISSION_DENIED) do NOT
 *      trigger the activate-Safari retry.
 *
 * RCA reference: bench-runs/v0136-probes/RCA-batch-regression.md §4 Factor 3.
 *
 * Boundary: per CLAUDE.md unit policy, NavigationTools is the unit; the
 * AppleScriptEngine is a real (constructed) collaborator and only its
 * `execute` method is per-instance spied — no module-level child_process
 * mocking (would leak across files under the isolate:false vitest config).
 */
import { describe, it, expect, vi } from 'vitest';
import { NavigationTools } from '../../../src/tools/navigation.js';
import { AppleScriptEngine } from '../../../src/engines/applescript.js';
import type { EngineResult } from '../../../src/types.js';

/** AppleScript error text shapes that signal "no front window" in Safari. */
const NO_WINDOW_ERROR_1719 = "52:99: execution error: Safari got an error: Can't get window 1. Invalid index. (-1719)";
const NO_WINDOW_ERROR_1700 = "129:140: execution error: Safari got an error: Can't make missing value into type tab. (-1700)";

/** A successful `safari_new_tab` AppleScript return value (URL|||winId|||tabIdx). */
const SUCCESS_RAW = 'https://www.example.com/|||3655|||3';

describe('NavigationTools.handleNewTab — Fix B: no-front-window recovery', () => {
  it('activates Safari and retries when the first attempt errors with "-1719" (no front window) and _sessionWindowId is undefined', async () => {
    const engine = new AppleScriptEngine();
    const calls: string[] = [];
    vi.spyOn(engine, 'execute').mockImplementation(async (script: string): Promise<EngineResult> => {
      calls.push(script);
      // Call 1: buildNewTabScript fails with no-window error.
      if (calls.length === 1) {
        return { ok: false, error: { code: 'APPLESCRIPT_ERROR', message: NO_WINDOW_ERROR_1719, retryable: false }, elapsed_ms: 1 };
      }
      // Call 2: the activate-Safari recovery AppleScript — succeeds (returns empty per AppleScript "tell ... activate" pattern).
      if (calls.length === 2) {
        return { ok: true, value: '', elapsed_ms: 1 };
      }
      // Call 3: retried buildNewTabScript — succeeds with the canonical URL|||winId|||tabIdx triple.
      return { ok: true, value: SUCCESS_RAW, elapsed_ms: 1 };
    });
    const tools = new NavigationTools(engine);

    const res = await tools.getHandler('safari_new_tab')!({ url: 'https://www.example.com/' });

    expect((res.metadata as { engine: string }).engine).toBe('applescript');
    expect(res.content[0]?.type).toBe('text');
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.tabUrl).toBe('https://www.example.com/');
    expect(parsed.windowId).toBe(3655);
    expect(parsed.tabIndex).toBe(3);
    // Three execute calls: original new_tab, Safari-activate, retried new_tab.
    expect(calls.length).toBe(3);
    // Defense vs trivial implementation: the second call must be the
    // Safari-activate AppleScript, not a third new_tab. Without this,
    // a buggy implementation that just fires buildNewTabScript three
    // times in a row would also produce calls.length === 3.
    expect(calls[1]).toMatch(/activate/i);
  });

  it('activates Safari and retries when the first attempt errors with "-1700" ("missing value into type tab")', async () => {
    const engine = new AppleScriptEngine();
    let call = 0;
    vi.spyOn(engine, 'execute').mockImplementation(async (): Promise<EngineResult> => {
      call += 1;
      if (call === 1) return { ok: false, error: { code: 'APPLESCRIPT_ERROR', message: NO_WINDOW_ERROR_1700, retryable: false }, elapsed_ms: 1 };
      if (call === 2) return { ok: true, value: '', elapsed_ms: 1 };
      return { ok: true, value: SUCCESS_RAW, elapsed_ms: 1 };
    });
    const tools = new NavigationTools(engine);

    const res = await tools.getHandler('safari_new_tab')!({ url: 'https://www.example.com/' });

    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.tabUrl).toBe('https://www.example.com/');
    expect(call).toBe(3);
  });

  it('returns errorResponse (no infinite recovery) when the second attempt ALSO fails with a no-window error', async () => {
    const engine = new AppleScriptEngine();
    let call = 0;
    vi.spyOn(engine, 'execute').mockImplementation(async (): Promise<EngineResult> => {
      call += 1;
      if (call === 1) return { ok: false, error: { code: 'APPLESCRIPT_ERROR', message: NO_WINDOW_ERROR_1719, retryable: false }, elapsed_ms: 1 };
      if (call === 2) return { ok: true, value: '', elapsed_ms: 1 }; // activate
      return { ok: false, error: { code: 'APPLESCRIPT_ERROR', message: NO_WINDOW_ERROR_1719, retryable: false }, elapsed_ms: 1 };
    });
    const tools = new NavigationTools(engine);

    const res = await tools.getHandler('safari_new_tab')!({ url: 'https://www.example.com/' });

    // The handler signals failure by emitting `errorResponse()` —
    // content[0].text holds `{"error": "<original message>"}` and metadata
    // marks `degraded: true`. No `isError` flag at this layer; the
    // server.executeToolWithSecurity layer adds isError later.
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error).toContain('-1719');
    expect((res.metadata as { degraded: boolean }).degraded).toBe(true);
    // No further retries beyond the one Safari-activate recovery.
    expect(call).toBe(3);
  });

  it('does NOT activate-Safari-retry when the error is unrelated (e.g., PERMISSION_DENIED -1743) — preserves error-classification fidelity', async () => {
    const engine = new AppleScriptEngine();
    let call = 0;
    vi.spyOn(engine, 'execute').mockImplementation(async (): Promise<EngineResult> => {
      call += 1;
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'execution error: Not authorised to send Apple events to Safari. (-1743)', retryable: false }, elapsed_ms: 1 };
    });
    const tools = new NavigationTools(engine);

    const res = await tools.getHandler('safari_new_tab')!({ url: 'https://www.example.com/' });

    // errorResponse shape: content[0].text JSON has { error: <msg> }.
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error).toContain('-1743');
    // Only the original attempt — no recovery, no second attempt.
    expect(call).toBe(1);
  });

  it('does NOT activate-Safari-retry on an APPLESCRIPT_ERROR with a non-no-window message (e.g., syntax error -2740) — discriminates message text, not error code class', async () => {
    // Closes the trivial-bypass exploited by a "match on error.code only"
    // implementation. Tests #1-#3 fire with `code: APPLESCRIPT_ERROR` and
    // a no-window message. An over-broad check on `error.code` alone would
    // happily retry on ANY APPLESCRIPT_ERROR — including this syntax error
    // — which is wrong. Fix B must match the message substring (-1719 or
    // -1700) so unrelated APPLESCRIPT_ERROR shapes pass through untouched.
    const engine = new AppleScriptEngine();
    let call = 0;
    vi.spyOn(engine, 'execute').mockImplementation(async (): Promise<EngineResult> => {
      call += 1;
      return { ok: false, error: { code: 'APPLESCRIPT_ERROR', message: 'execution error: syntax error (-2740)', retryable: false }, elapsed_ms: 1 };
    });
    const tools = new NavigationTools(engine);

    const res = await tools.getHandler('safari_new_tab')!({ url: 'https://www.example.com/' });

    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.error).toContain('-2740');
    expect(call).toBe(1);
  });

  it('does NOT activate-Safari-retry when _sessionWindowId is provided (preserves WINDOW_CLOSED path)', async () => {
    const engine = new AppleScriptEngine();
    let call = 0;
    vi.spyOn(engine, 'execute').mockImplementation(async (): Promise<EngineResult> => {
      call += 1;
      // First attempt: targets sessionWindowId. Fails with WINDOW_CLOSED (the pre-existing path).
      if (call === 1) return { ok: false, error: { code: 'APPLESCRIPT_ERROR', message: 'execution error: WINDOW_CLOSED (-2700)', retryable: false }, elapsed_ms: 1 };
      // Second attempt: pre-existing fallback without windowId. Succeeds.
      return { ok: true, value: SUCCESS_RAW, elapsed_ms: 1 };
    });
    const tools = new NavigationTools(engine);

    const res = await tools.getHandler('safari_new_tab')!({ url: 'https://www.example.com/', _sessionWindowId: 999 });

    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.tabUrl).toBe('https://www.example.com/');
    // Two calls — pre-existing WINDOW_CLOSED recovery. NO activate-Safari third call.
    expect(call).toBe(2);
  });
});
