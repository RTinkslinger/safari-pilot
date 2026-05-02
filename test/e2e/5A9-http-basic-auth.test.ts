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
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    // Open a blank-ish tab first so we have a tabUrl handle to thread into
    // the auth call. The actual protected request happens on the next
    // navigate AFTER the rule is installed.
    const target = `http://127.0.0.1:${fixture.hostPort}/?sp_t5A9=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_clear_authentication', { tabUrl, urlPattern: `*://127.0.0.1:${fixture.hostPort}/*` }, nextId()); } catch { /* best-effort */ }
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('without authentication: /auth-protected returns 401 #denied', async () => {
    // Baseline: prove the fixture actually requires auth. Without this,
    // the post-auth assertion proves nothing — a fixture that always
    // returned 200 would also "pass".
    const protectedUrl = `http://127.0.0.1:${fixture.hostPort}/auth-protected`;
    await callTool(client, 'safari_navigate', { tabUrl: tabUrl!, url: protectedUrl }, nextId(), 15_000);
    tabUrl = protectedUrl;
    await new Promise((r) => setTimeout(r, 800));
    const txt = await callTool(client, 'safari_get_text', { tabUrl, selector: 'h1' }, nextId(), 15_000);
    expect((txt['text'] as string)).toMatch(/401|denied|unauthorized/i);
  }, 60_000);

  it('after safari_authenticate: /auth-protected returns 200 #ok', async () => {
    // Install the DNR rule, then re-navigate. The DNR rule injects the
    // Authorization header on the request, satisfying the fixture.
    await callTool(client, 'safari_authenticate', {
      tabUrl: tabUrl!,
      username: 'testuser',
      password: 'testpass',
      urlPattern: `*://127.0.0.1:${fixture.hostPort}/*`,
    }, nextId(), 15_000);

    const protectedUrl = `http://127.0.0.1:${fixture.hostPort}/auth-protected?retry=${Date.now()}`;
    await callTool(client, 'safari_navigate', { tabUrl: tabUrl!, url: protectedUrl }, nextId(), 15_000);
    tabUrl = protectedUrl;
    await new Promise((r) => setTimeout(r, 800));

    const txt = await callTool(client, 'safari_get_text', { tabUrl, selector: 'h1' }, nextId(), 15_000);
    expect((txt['text'] as string)).toMatch(/authenticated/i);
  }, 60_000);

  it('safari_clear_authentication removes the rule — subsequent request returns 401 again', async () => {
    await callTool(client, 'safari_clear_authentication', {
      tabUrl: tabUrl!,
      urlPattern: `*://127.0.0.1:${fixture.hostPort}/*`,
    }, nextId(), 15_000);

    // Re-navigate with a cache-buster so Safari doesn't serve the previous
    // 200 from cache. The header injection should be GONE → 401 returns.
    const protectedUrl = `http://127.0.0.1:${fixture.hostPort}/auth-protected?cleared=${Date.now()}`;
    await callTool(client, 'safari_navigate', { tabUrl: tabUrl!, url: protectedUrl }, nextId(), 15_000);
    tabUrl = protectedUrl;
    await new Promise((r) => setTimeout(r, 800));

    const txt = await callTool(client, 'safari_get_text', { tabUrl, selector: 'h1' }, nextId(), 15_000);
    expect((txt['text'] as string)).toMatch(/401|denied|unauthorized/i);
  }, 60_000);
});
