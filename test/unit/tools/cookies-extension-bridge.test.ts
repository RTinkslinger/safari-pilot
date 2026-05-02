/**
 * Phase 5A · 5A.8 — Cookies via browser.cookies extension API (httpOnly support).
 *
 * Behavior contract under test:
 *   When engine.name === 'extension', cookie handlers dispatch sentinel
 *   strings (__SP_COOKIE_GET_ALL__ / __SP_COOKIE_SET__ / __SP_COOKIE_REMOVE__)
 *   so background.js can route to browser.cookies — which sees httpOnly cookies.
 *
 *   When engine.name !== 'extension', handlers fall back to document.cookie
 *   injection (which CANNOT see httpOnly — known limitation, documented in
 *   safari_get_cookies description).
 *
 * Why these tests, not document.cookie escape testing:
 *   - The previous handlers were 100% document.cookie. The behavior change
 *     introduced by 5A.8 is engine-aware dispatch + httpOnly param threading.
 *   - Dispatching the sentinel is the OBSERVABLE behavior. The tests assert
 *     the tool sends the right script string to the engine — that's the
 *     boundary the extension's executeCommand consumes.
 *   - Asserting on the sentinel JSON suffix ensures params (domain filter,
 *     httpOnly flag, name) are threaded — without that, a hardcoded sentinel
 *     would pass shape checks but fail the actual cookie read/write.
 *
 * Scope: unit-level dispatch boundary. The e2e suite (5A8-cookies-httponly.test.ts)
 * exercises the whole stack with a real httpOnly cookie set by a fixture server.
 */
import { describe, it, expect } from 'vitest';
import { StorageTools } from '../../../src/tools/storage.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

const COOKIE_GET_ALL = '__SP_COOKIE_GET_ALL__';
const COOKIE_SET = '__SP_COOKIE_SET__';
const COOKIE_REMOVE = '__SP_COOKIE_REMOVE__';

// browser.cookies.getAll returns a bare array; handler must wrap as {cookies,count}.
const getAllValue = JSON.stringify([
  { name: 'session', value: 'abc', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
  { name: 'theme', value: 'dark', domain: 'example.com', path: '/', secure: false, httpOnly: false, sameSite: 'lax' },
]);
const setValue = JSON.stringify({ name: 'sid', value: 'xyz', domain: 'example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
const removeValue = JSON.stringify({ url: 'https://example.com/', name: 'sid' });

function recordingEngine(name: Engine, response: string): IEngine & { scripts: string[] } {
  const scripts: string[] = [];
  const e: IEngine & { scripts: string[] } = {
    name,
    isAvailable: async () => true,
    execute: async () => ({ ok: true, value: response, elapsed_ms: 1 }),
    executeJsInTab: async (...args: unknown[]) => {
      scripts.push(args[1] as string);
      return { ok: true, value: response, elapsed_ms: 1 } as EngineResult;
    },
    executeJsInFrame: async () => ({ ok: true, value: response, elapsed_ms: 1 }) as EngineResult,
    shutdown: async () => {},
    scripts,
  } as unknown as IEngine & { scripts: string[] };
  return e;
}

describe('5A.8 — cookies dispatch via extension sentinels', () => {
  // ── safari_get_cookies ──────────────────────────────────────────────────

  it('extension engine: get_cookies dispatches __SP_COOKIE_GET_ALL__ sentinel (NOT document.cookie)', async () => {
    const engine = recordingEngine('extension', getAllValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_get_cookies')!;
    await handler({ tabUrl: 'https://example.com/' });

    expect(engine.scripts).toHaveLength(1);
    const dispatched = engine.scripts[0]!;
    expect(dispatched.startsWith(COOKIE_GET_ALL)).toBe(true);
    // CRITICAL: must NOT be the document.cookie JS path. A trivial impl
    // that always sends document.cookie regardless of engine would pass
    // the "starts with sentinel" check ONLY if the sentinel is actually
    // dispatched. This second assertion catches regressions where someone
    // accidentally dispatches both.
    expect(dispatched).not.toContain('document.cookie');
  });

  it('extension engine: get_cookies passes domain filter through sentinel JSON suffix', async () => {
    const engine = recordingEngine('extension', getAllValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_get_cookies')!;
    await handler({ tabUrl: 'https://example.com/', domain: 'example.com' });

    const dispatched = engine.scripts[0]!;
    // Sentinel format: __SP_COOKIE_GET_ALL__:<json-params>. Without param
    // threading the extension would query all cookies, then the handler
    // would have to re-filter — defeating the point of the API call.
    const colonIdx = dispatched.indexOf(':');
    expect(colonIdx).toBeGreaterThan(0);
    const params = JSON.parse(dispatched.slice(colonIdx + 1)) as { domain?: string };
    expect(params.domain).toBe('example.com');
  });

  it('extension engine: get_cookies wraps bare browser.cookies.getAll array as {cookies,count} response', async () => {
    const engine = recordingEngine('extension', getAllValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_get_cookies')!;
    const response = await handler({ tabUrl: 'https://example.com/' });

    // The extension returns a bare array; the tool must shape it into the
    // standard {cookies, count} response so callers don't see different
    // shapes per engine. httpOnly:true MUST round-trip — that's the whole
    // point of routing through browser.cookies.
    const body = JSON.parse((response.content[0] as { text: string }).text) as { cookies: Array<{ name: string; httpOnly: boolean }>; count: number };
    expect(body.count).toBe(2);
    expect(body.cookies[0]!.name).toBe('session');
    expect(body.cookies[0]!.httpOnly).toBe(true);
  });

  it('non-extension engine: get_cookies falls back to document.cookie injection (no sentinel)', async () => {
    const engine = recordingEngine('applescript', JSON.stringify({ cookies: [], count: 0 }));
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_get_cookies')!;
    await handler({ tabUrl: 'https://example.com/' });

    const dispatched = engine.scripts[0]!;
    expect(dispatched).not.toContain(COOKIE_GET_ALL);
    // document.cookie is the JS API the fallback uses; this is the litmus
    // for the legacy code path being preserved (not deleted by the change).
    expect(dispatched).toContain('document.cookie');
  });

  // ── safari_set_cookie ──────────────────────────────────────────────────

  it('extension engine: set_cookie dispatches __SP_COOKIE_SET__ with httpOnly:true threaded through', async () => {
    const engine = recordingEngine('extension', setValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_set_cookie')!;
    await handler({ tabUrl: 'https://example.com/', name: 'sid', value: 'xyz', domain: 'example.com', secure: true, httpOnly: true });

    const dispatched = engine.scripts[0]!;
    expect(dispatched.startsWith(COOKIE_SET)).toBe(true);
    // Triangulate separator: a sentinel emitted as `__SP_COOKIE_SET__|{...}`
    // would slip past `startsWith` but yield a confusing JSON.parse failure.
    // Asserting the colon explicitly catches the format-drift mutation class.
    expect(dispatched.charAt(COOKIE_SET.length)).toBe(':');
    const params = JSON.parse(dispatched.slice(COOKIE_SET.length + 1)) as { name: string; value: string; httpOnly: boolean; domain: string };
    expect(params.name).toBe('sid');
    expect(params.value).toBe('xyz');
    expect(params.httpOnly).toBe(true);
    expect(params.domain).toBe('example.com');
  });

  it('extension engine: set_cookie threads httpOnly:false (or omitted) — no hardcoded true', async () => {
    // Mutation guard: a trivial impl could hardcode httpOnly:true into the
    // sentinel JSON and pass every "httpOnly:true" assertion. This test
    // verifies the boolean is GENUINELY threaded by inverting it.
    const engine = recordingEngine('extension', setValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_set_cookie')!;
    await handler({ tabUrl: 'https://example.com/', name: 'theme', value: 'dark' /* httpOnly omitted */ });

    const dispatched = engine.scripts[0]!;
    const params = JSON.parse(dispatched.slice(COOKIE_SET.length + 1)) as { httpOnly?: boolean };
    // Either explicit false or absent — both are valid for browser.cookies.set
    // (its default is false). What we MUST NOT see is true.
    expect(params.httpOnly === true).toBe(false);
  });

  it('extension engine: set_cookie threads url from tabUrl so browser.cookies.set has a target', async () => {
    // browser.cookies.set requires either `url` or `domain`. Threading the
    // url ensures the daemon-side handler can call browser.cookies.set
    // without an extra normalization step.
    const engine = recordingEngine('extension', setValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_set_cookie')!;
    await handler({ tabUrl: 'https://example.com/path?x=1', name: 'a', value: 'b' });

    const dispatched = engine.scripts[0]!;
    const params = JSON.parse(dispatched.slice(COOKIE_SET.length + 1)) as { url: string };
    expect(params.url).toBe('https://example.com/path?x=1');
  });

  it('non-extension engine: set_cookie falls back to document.cookie (httpOnly is silently dropped — JS cannot set httpOnly)', async () => {
    const engine = recordingEngine('applescript', JSON.stringify({ set: true, name: 'sid', cookie: 'sid=xyz; path=/' }));
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_set_cookie')!;
    // httpOnly:true requested but applescript engine has no way to honor it.
    // The existing document.cookie path stays as-is — fallback contract.
    await handler({ tabUrl: 'https://example.com/', name: 'sid', value: 'xyz', httpOnly: true });

    const dispatched = engine.scripts[0]!;
    expect(dispatched).not.toContain(COOKIE_SET);
    expect(dispatched).toContain('document.cookie');
  });

  // ── safari_delete_cookie ──────────────────────────────────────────────

  it('extension engine: delete_cookie dispatches __SP_COOKIE_REMOVE__ with url+name', async () => {
    const engine = recordingEngine('extension', removeValue);
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_delete_cookie')!;
    await handler({ tabUrl: 'https://example.com/', name: 'sid' });

    const dispatched = engine.scripts[0]!;
    expect(dispatched.startsWith(COOKIE_REMOVE)).toBe(true);
    // Same separator triangulation as set_cookie above.
    expect(dispatched.charAt(COOKIE_REMOVE.length)).toBe(':');
    const params = JSON.parse(dispatched.slice(COOKIE_REMOVE.length + 1)) as { url: string; name: string };
    // browser.cookies.remove signature: { url, name, storeId? }. url is
    // mandatory; name selects the cookie. Threading both through asserts
    // the dispatch wires exactly what the API needs.
    expect(params.url).toBe('https://example.com/');
    expect(params.name).toBe('sid');
  });

  it('non-extension engine: delete_cookie falls back to document.cookie expiry-in-past trick', async () => {
    const engine = recordingEngine('applescript', JSON.stringify({ deleted: true, existed: true, name: 'sid' }));
    const tools = new StorageTools(engine);
    const handler = tools.getHandler('safari_delete_cookie')!;
    await handler({ tabUrl: 'https://example.com/', name: 'sid' });

    const dispatched = engine.scripts[0]!;
    expect(dispatched).not.toContain(COOKIE_REMOVE);
    // Legacy path uses Thu, 01 Jan 1970 expiry to delete. Asserting that
    // string is a stronger oracle than just "contains document.cookie" —
    // a stub that returned an empty string would still contain document.cookie.
    expect(dispatched).toContain('1970');
  });
});
