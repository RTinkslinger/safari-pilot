/**
 * Phase 5A · 5A.7 — Path B: interceptor header capture (smoke gate).
 *
 * The change under test: `safari_intercept_requests` (handleInterceptRequests
 * in src/tools/network.ts) dispatches a JS string that monkey-patches
 * `window.fetch` and `XMLHttpRequest`. Path B extends the captured entry
 * shape with `requestHeaders` and `responseHeaders` fields so the resulting
 * `window.__safariPilotNetwork.entries` is HAR-ready.
 *
 * THIS IS A SMOKE GATE, NOT A BEHAVIORAL TEST.
 *
 * The behavioral truth — "fetches actually capture headers and feed
 * entriesToHar correctly end-to-end" — is verified in the e2e suite
 * (test/e2e/5A7-har-record-replay.test.ts, RED-5/GREEN-5 in this cycle)
 * by hitting a real fixture server through Safari and asserting the
 * dumped HAR contains the captured Content-Type. That e2e is the truth.
 *
 * What THIS file does:
 *   - Pin that the dispatched script string contains the specific token
 *     patterns that capture request and response headers for both fetch
 *     and XMLHttpRequest. Catches accidental deletion or refactor that
 *     drops the header-capture code without breaking anything else.
 *   - This is intentionally implementation-coupled. Its job is "regression
 *     guard" not "behavioral verification." If a future refactor renames
 *     the JS variables, this test should be updated to match — that's a
 *     deliberate cost paid for cheap deletion-detection.
 *
 * Why a behavioral unit test was rejected:
 *   - vm-sandbox eval of the dispatched script with a synthetic window/
 *     fetch/XHR is the alternative. ~150 lines of harness for behavior
 *     the e2e already verifies in real Safari. Cost > benefit at this
 *     test level — the e2e is the right home for behavior.
 */
import { describe, it, expect } from 'vitest';
import { NetworkTools } from '../../../src/tools/network.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

function recordingEngine(name: Engine = 'applescript'): IEngine & { scripts: string[] } {
  const scripts: string[] = [];
  const e: IEngine & { scripts: string[] } = {
    name,
    isAvailable: async () => true,
    execute: async () => ({ ok: true, value: '{}', elapsed_ms: 1 }),
    executeJsInTab: async (...args: unknown[]) => {
      scripts.push(args[1] as string);
      return { ok: true, value: '{}', elapsed_ms: 1 } as EngineResult;
    },
    executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 1 }) as EngineResult,
    shutdown: async () => {},
    scripts,
  } as unknown as IEngine & { scripts: string[] };
  return e;
}

async function dispatchIntercept(): Promise<string> {
  const engine = recordingEngine();
  const tools = new NetworkTools(engine);
  const handler = tools.getHandler('safari_intercept_requests');
  if (!handler) throw new Error('safari_intercept_requests handler not registered');
  await handler({ tabUrl: 'https://example.com/', captureBody: false });
  if (engine.scripts.length !== 1) {
    throw new Error(`expected 1 dispatched script, got ${engine.scripts.length}`);
  }
  return engine.scripts[0]!;
}

describe('5A.7 — interceptor dispatched script captures headers (smoke gate)', () => {
  it('fetch interceptor: captures response.headers via Headers iteration AND binds them to the entry', async () => {
    // The fetch monkey-patch reads response.headers and stores into
    // entry.responseHeaders. The Headers API exposes either
    // `.forEach((value, name) => ...)` or `for (const [name, value] of headers)`
    // — match either. The entry-binding regex closes the trivially-passable
    // gap where iteration exists but never writes to the entry (e.g., a
    // local-only var that downstream entriesToHar can't see).
    const script = await dispatchIntercept();
    // PIN 1: iteration mechanism is present (allow either form).
    const usesForEach = /response\.headers\.forEach\s*\(/.test(script);
    const usesEntries = /response\.headers\.entries\s*\(/.test(script) || /for\s*\([^)]+of\s+response\.headers\s*\)/.test(script);
    expect(
      usesForEach || usesEntries,
      'expected response.headers.forEach(...) or for-of/entries() iteration in fetch interceptor',
    ).toBe(true);
    // PIN 2 (load-bearing): captured headers MUST be assigned to the entry
    // object that downstream code (entriesToHar) reads from. Catches typo'd
    // keys (`respnseHeaders`) and unwired-local-variable bugs.
    expect(script).toMatch(/entry\.responseHeaders\s*[[=]/);
  });

  it('XHR interceptor: overrides setRequestHeader and writes captured request headers to the entry', async () => {
    // XHR has two flavors of header capture:
    //   - Response: getAllResponseHeaders() returns a CRLF-joined string;
    //     parse into {name: value} pairs and assign to entry.responseHeaders.
    //   - Request: override XHR.prototype.setRequestHeader to record
    //     captured pairs into a per-request map (XHR doesn't expose
    //     request headers post-send), then attach to entry.requestHeaders.
    const script = await dispatchIntercept();
    // PIN 1: response-side parse mechanism present.
    expect(script).toContain('getAllResponseHeaders');
    // PIN 2: setRequestHeader is OVERRIDDEN (assignment, not just call).
    expect(script).toMatch(/XMLHttpRequest\.prototype\.setRequestHeader\s*=/);
    // PIN 3 (load-bearing): captured request headers reach the entry.
    // Catches override-that-captures-locally-but-never-attaches bug.
    expect(script).toMatch(/entry\.requestHeaders\s*[[=]/);
    // PIN 4 (load-bearing): captured response headers reach the entry.
    expect(script).toMatch(/entry\.responseHeaders\s*[[=]/);
  });

  it('fetch interceptor: normalizes init.headers and binds them to the entry', async () => {
    // fetch's `init.headers` can be:
    //   1. A `Headers` object: iterate via .forEach
    //   2. A plain object: Object.keys / Object.entries / for-in
    //   3. An array of [name, value] pairs: array iteration
    // The interceptor must handle at least #1 and #2 to be useful.
    const script = await dispatchIntercept();
    // PIN 1: init.headers is referenced (no reference → no normalization).
    expect(script).toMatch(/init\s*&&\s*init\.headers|init\.headers/);
    // PIN 2 (load-bearing): a Headers-iteration OR object-keys form is used.
    // A passing impl must do at least one — otherwise no normalization happens.
    const handlesHeadersInstance = /init\.headers\.forEach\s*\(/.test(script);
    const handlesPlainObject = /Object\.keys\s*\(\s*init\.headers\s*\)/.test(script)
      || /Object\.entries\s*\(\s*init\.headers\s*\)/.test(script)
      || /for\s*\([^)]+\s+in\s+init\.headers\s*\)/.test(script);
    expect(
      handlesHeadersInstance || handlesPlainObject,
      'expected at least one of: init.headers.forEach (Headers form) or Object.keys/entries / for-in (plain-object form)',
    ).toBe(true);
    // PIN 3 (load-bearing): the captured request headers reach the entry.
    expect(script).toMatch(/entry\.requestHeaders\s*[[=]/);
  });
});
