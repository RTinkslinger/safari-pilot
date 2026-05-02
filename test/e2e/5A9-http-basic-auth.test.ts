/**
 * Phase 5A · 5A.9 — HTTP basic auth via DNR header injection.
 *
 * GATED: requires v0.1.20 extension build (DNR sentinels added in
 * extension/background.js executeCommand). RED until that ships.
 *
 * Companion to test/unit/tools/http-auth-dispatch.test.ts (dispatch boundary).
 * This e2e closes the loop end-to-end:
 *   safari_authenticate → DNR rule installed in extension →
 *   subsequent navigate to /auth-protected →
 *   browser appends Authorization: Basic header automatically →
 *   server returns 200 with #ok element →
 *   safari_get_text confirms authentication landed.
 *
 * The fixture server's /auth-protected route returns 401 unless the request
 * carries Authorization: Basic dGVzdHVzZXI6dGVzdHBhc3M= (testuser:testpass).
 * This is the litmus: a 200 with #ok proves the DNR injected the right
 * header on the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('5A.9 — HTTP basic auth via DNR (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let benignTab: string | null = null;
  let pattern = '';

  // Architecture: do NOT navigate the tab to /auth-protected directly.
  // Top-level navigation to a 401 + WWW-Authenticate response triggers
  // Safari's native HTTP auth dialog, which blocks JS, suspends the tab
  // in an indeterminate URL state, and breaks the extension's tab cache.
  //
  // Instead: open ONE benign tab on the same origin (the cookie-fixture,
  // which is happy to 200 with no auth) and use safari_evaluate to run
  // fetch('/auth-protected') from inside that page. fetch() does NOT
  // trigger the modal dialog on 401 — it returns the response as data.
  // DNR's modifyHeaders rule applies to xmlhttprequest resource type,
  // so the Authorization header injection works for fetch() too.
  // Fire fetch, sleep generously off-tool-bus, read result. Two safari_evaluate
  // calls per assertion — well under the 60/min/domain rate limit even when
  // 5A.8 has just run on the same origin. safari_evaluate's main-world JS
  // must return synchronously (Promises hang the storage bus), so the result
  // travels via window['<slot>'].
  async function fetchProtected(suffix: string): Promise<{ status: number; body: string }> {
    const url = `http://127.0.0.1:${fixture.hostPort}/auth-protected?${suffix}=${Date.now()}`;
    const slot = `__sp5A9_${suffix}`;
    await callTool(client, 'safari_evaluate', {
      tabUrl: benignTab!,
      script: `
        window['${slot}'] = null;
        fetch('${url}', { credentials: 'omit', cache: 'no-store' })
          .then(async function (r) { window['${slot}'] = { status: r.status, body: await r.text() }; })
          .catch(function (e) { window['${slot}'] = { status: 0, body: 'fetch error: ' + (e && e.message || String(e)) }; });
        return 'dispatched';
      `,
      timeout: 5_000,
    }, nextId(), 15_000);

    // Local server, no real latency — 3s is generous. Off the tool bus
    // entirely so we don't burn rate-limiter tokens polling.
    await new Promise((r) => setTimeout(r, 3000));

    const poll = await callTool(client, 'safari_evaluate', {
      tabUrl: benignTab!,
      script: `return window['${slot}'];`,
      timeout: 5_000,
    }, nextId(), 15_000);
    const v = (poll['value'] ?? poll['result']) as null | { status: number; body: string };
    if (!v || typeof v !== 'object' || !('status' in v)) {
      throw new Error(`fetchProtected(${suffix}) result not ready after 3s; got: ${JSON.stringify(poll)}`);
    }
    return v;
  }

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    pattern = `*://127.0.0.1:${fixture.hostPort}/*`;
    // Benign tab on the fixture origin — page itself returns 200 with no
    // auth. fetch() from this page targets /auth-protected.
    const target = `http://127.0.0.1:${fixture.hostPort}/cookie-fixture?sp_t5A9=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    benignTab = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (benignTab) {
      try { await callTool(client, 'safari_clear_authentication', { tabUrl: benignTab, urlPattern: pattern }, nextId()); } catch { /* best-effort */ }
      try { await callTool(client, 'safari_close_tab', { tabUrl: benignTab }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('baseline: fetch(/auth-protected) without auth returns 401', async () => {
    // Prove the fixture actually requires auth. A misconfigured fixture
    // that returned 200 unconditionally would also "pass" the post-auth
    // assertion below — this test is the negative control.
    const r = await fetchProtected('baseline');
    expect(r.status, `unexpected: ${JSON.stringify(r).slice(0, 200)}`).toBe(401);
  }, 60_000);

  it('after safari_authenticate: fetch(/auth-protected) returns 200 with #ok body', async () => {
    // Install the DNR rule. Subsequent fetch from the SAME tab carries
    // Authorization: Basic <b64> automatically — server returns 200 +
    // "authenticated" in the page body.
    await callTool(client, 'safari_authenticate', {
      tabUrl: benignTab!,
      username: 'testuser',
      password: 'testpass',
      urlPattern: pattern,
    }, nextId(), 15_000);

    const r = await fetchProtected('authed');
    expect(r.status, `unexpected: ${JSON.stringify(r).slice(0, 200)}`).toBe(200);
    expect(r.body).toMatch(/authenticated/i);
  }, 60_000);

  it('after safari_clear_authentication: fetch(/auth-protected) returns 401 again', async () => {
    await callTool(client, 'safari_clear_authentication', {
      tabUrl: benignTab!,
      urlPattern: pattern,
    }, nextId(), 15_000);

    const r = await fetchProtected('cleared');
    expect(r.status, `unexpected: ${JSON.stringify(r).slice(0, 200)}`).toBe(401);
  }, 60_000);
});
