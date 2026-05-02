/**
 * Phase 5A · 5A.8 — cookies httpOnly via browser.cookies extension API.
 *
 * GATED: this test exercises code that requires the v0.1.20 extension build
 * (sentinel handlers in extension/background.js executeCommand). Until the
 * user installs v0.1.20 and re-enables the extension, these tests will RED.
 * That is intentional — they are the rebuild checkpoint litmus.
 *
 * Companion to test/unit/tools/cookies-extension-bridge.test.ts (which verifies
 * the dispatch boundary). This e2e closes the loop:
 *   server (Set-Cookie header w/ HttpOnly) → real Safari cookie store
 *     → MCP → server → extension → browser.cookies.getAll
 *     → safari_get_cookies returns cookie WITH httpOnly:true visible.
 *
 * Litmus: if `body.cookies` finds `srv_session` with `httpOnly: true`, the
 * extension dispatch actually crossed into browser.cookies. With the
 * pre-5A.8 document.cookie path, srv_session would be invisible entirely
 * (httpOnly cookies don't appear in document.cookie at all).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
}

describe('5A.8 — cookies httpOnly via browser.cookies (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    // Hitting /cookie-fixture causes the server to issue Set-Cookie
    // headers including HttpOnly. Safari stores both cookies; only the
    // non-HttpOnly one is visible to JS document.cookie.
    const target = `http://127.0.0.1:${fixture.hostPort}/cookie-fixture?sp_t5A8=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      // Best-effort cleanup — delete BOTH cookies regardless of which path
      // is active so re-runs don't leak state across iterations.
      try { await callTool(client, 'safari_delete_cookie', { tabUrl, name: 'srv_session' }, nextId()); } catch { /* best-effort */ }
      try { await callTool(client, 'safari_delete_cookie', { tabUrl, name: 'srv_visible' }, nextId()); } catch { /* best-effort */ }
      try { await callTool(client, 'safari_delete_cookie', { tabUrl, name: 'sp_test_set' }, nextId()); } catch { /* best-effort */ }
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('safari_get_cookies sees httpOnly cookie set by Set-Cookie header', async () => {
    const r = await callTool(client, 'safari_get_cookies', { tabUrl: tabUrl! }, nextId(), 15_000);
    const cookies = (r['cookies'] as Cookie[]) ?? [];
    const session = cookies.find((c) => c.name === 'srv_session');
    // CORE assertion: the httpOnly cookie is visible AND its httpOnly flag is true.
    // Pre-5A.8 (document.cookie path), srv_session would be undefined entirely.
    expect(session, `expected srv_session in cookies; got names: ${cookies.map((c) => c.name).join(', ')}`).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.value).toBe('server-set-secret');
  }, 60_000);

  it('safari_get_cookies returns httpOnly:false for non-httpOnly cookies (no flag forcing)', async () => {
    // Mutation guard: a wrong impl could hardcode httpOnly:true on every
    // cookie. The non-HttpOnly cookie set by the same fixture must read
    // back with httpOnly:false.
    const r = await callTool(client, 'safari_get_cookies', { tabUrl: tabUrl! }, nextId(), 15_000);
    const cookies = (r['cookies'] as Cookie[]) ?? [];
    const visible = cookies.find((c) => c.name === 'srv_visible');
    expect(visible).toBeDefined();
    expect(visible!.httpOnly).toBe(false);
  }, 60_000);

  it('safari_set_cookie with httpOnly:true creates a cookie not visible to document.cookie', async () => {
    // Round-trip via the new path: set httpOnly via tool, then verify it
    // came back through tool with httpOnly:true. AND verify it's invisible
    // to document.cookie inside the page (the actual browser-level promise
    // of the httpOnly flag).
    await callTool(client, 'safari_set_cookie', {
      tabUrl: tabUrl!,
      name: 'sp_test_set',
      value: 'set-by-tool',
      domain: '127.0.0.1',
      httpOnly: true,
    }, nextId(), 15_000);

    // Verify via tool (extension path)
    const got = await callTool(client, 'safari_get_cookies', { tabUrl: tabUrl! }, nextId(), 15_000);
    const cookies = (got['cookies'] as Cookie[]) ?? [];
    const created = cookies.find((c) => c.name === 'sp_test_set');
    expect(created, `expected sp_test_set in cookies; got: ${cookies.map((c) => c.name).join(', ')}`).toBeDefined();
    expect(created!.httpOnly).toBe(true);

    // Verify via in-page JS (the browser's httpOnly contract). document.cookie
    // MUST NOT include sp_test_set. If it does, the cookie wasn't actually set
    // as httpOnly (browser.cookies.set silently degraded).
    const evalRes = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: 'return document.cookie;',
    }, nextId(), 15_000);
    const docCookie = (evalRes['result'] as string) ?? (evalRes['value'] as string) ?? '';
    expect(docCookie).not.toContain('sp_test_set');
  }, 60_000);

  it('safari_delete_cookie removes an httpOnly cookie via browser.cookies.remove', async () => {
    // Pre-condition: srv_session is present (set by fixture during beforeAll).
    const before = await callTool(client, 'safari_get_cookies', { tabUrl: tabUrl! }, nextId(), 15_000);
    const beforeCookies = (before['cookies'] as Cookie[]) ?? [];
    expect(beforeCookies.find((c) => c.name === 'srv_session')).toBeDefined();

    await callTool(client, 'safari_delete_cookie', { tabUrl: tabUrl!, name: 'srv_session' }, nextId(), 15_000);

    const after = await callTool(client, 'safari_get_cookies', { tabUrl: tabUrl! }, nextId(), 15_000);
    const afterCookies = (after['cookies'] as Cookie[]) ?? [];
    // The httpOnly cookie was deleted. document.cookie path CANNOT delete
    // httpOnly cookies — pre-5A.8, this assertion would fail because the
    // cookie would still be present in the cookie jar.
    expect(afterCookies.find((c) => c.name === 'srv_session')).toBeUndefined();
  }, 60_000);
});
