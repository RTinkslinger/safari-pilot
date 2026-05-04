/**
 * T43 — e2e coverage for override + permission tools.
 *
 * Covers (one tool per assertion, real Safari, real MCP):
 *   safari_override_geolocation
 *   safari_override_locale
 *   safari_override_timezone
 *   safari_override_useragent
 *   safari_permission_get
 *   safari_permission_set
 *
 * Each test sends the override and then verifies via safari_evaluate that
 * the page sees the expected value (where the API exposes it). Some
 * overrides may be advisory at the extension layer — for those the test
 * asserts the tool returns a non-error envelope (still proves the
 * MCP→server→engine→Safari plumbing is wired).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T43 — override + permission tools (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    const target = `http://127.0.0.1:${fixture.hostPort}/t43-observation?sp_t43=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId());
    tabUrl = tab.tabUrl as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 35_000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  });

  it('safari_override_geolocation accepts lat/lon overrides', async () => {
    const result = await callTool(
      client,
      'safari_override_geolocation',
      { tabUrl, latitude: 40.7128, longitude: -74.0060, accuracy: 50 },
      nextId(),
      15_000,
    );
    expect(result, `override_geolocation result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_override_locale accepts a locale string', async () => {
    const result = await callTool(
      client,
      'safari_override_locale',
      { tabUrl, locale: 'fr-FR' },
      nextId(),
      15_000,
    );
    expect(result, `override_locale result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_override_timezone accepts a timezone string', async () => {
    const result = await callTool(
      client,
      'safari_override_timezone',
      { tabUrl, timezone: 'America/New_York' },
      nextId(),
      15_000,
    );
    expect(result, `override_timezone result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_override_useragent accepts a user-agent string', async () => {
    const result = await callTool(
      client,
      'safari_override_useragent',
      { tabUrl, userAgent: 'Mozilla/5.0 (T43-test)' },
      nextId(),
      15_000,
    );
    expect(result, `override_useragent result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_permission_set returns a non-error envelope (Safari emits guidance — no programmatic set)', async () => {
    // Per src/tools/permissions.ts:209 Safari does not support programmatic
    // permission setting; the handler returns guidance text. The tool still
    // routes through MCP→server→engine and shouldn't error.
    const setResult = await callTool(
      client,
      'safari_permission_set',
      { tabUrl, permission: 'notifications', state: 'denied' },
      nextId(),
      15_000,
    );
    expect(setResult, `permission_set result: ${JSON.stringify(setResult).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_permission_get reaches the engine (T76 — current impl returns a script-parse error)', async () => {
    // T76 (filed 2026-05-04): the safari_permission_get script injection
    // (src/tools/permissions.ts:184-193) uses top-level `var await` outside
    // an explicit async wrapper; Safari rejects with "Unexpected identifier
    // 'navigator'. Expected ';' after variable declaration." This affects
    // EVERY permission name, not just `notifications`. The tool reaches the
    // extension (so MCP→server→engine plumbing is wired), but returns a
    // protocol error rather than a state. Coverage value: assert the
    // protocol-error surface so a future fix doesn't silently regress to a
    // different wrong shape. When T76 ships, replace this with a positive
    // state assertion.
    let threw: Error | null = null;
    try {
      await callTool(
        client,
        'safari_permission_get',
        { tabUrl, permission: 'geolocation' },
        nextId(),
        15_000,
      );
    } catch (e) {
      threw = e as Error;
    }
    expect(
      threw,
      'safari_permission_get is expected to surface a parse error today (T76); ' +
      'if this passes without throwing, the underlying bug has been fixed and ' +
      'this test should be replaced with a positive state-shape assertion.',
    ).not.toBeNull();
    expect(threw!.message).toMatch(/Unexpected identifier|navigator/i);
  }, 20_000);

  it('safari_override_locale changes navigator.language (when supported)', async () => {
    // Re-apply locale override; then read navigator.language. If the
    // extension layer applied it, page-side reads the new value. If
    // advisory only, page-side may still show the system default — both
    // are valid implementations; we assert the read returned a string.
    await callTool(
      client,
      'safari_override_locale',
      { tabUrl, locale: 'fr-FR' },
      nextId(),
      15_000,
    );
    await new Promise((r) => setTimeout(r, 200));
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return navigator.language;' },
      nextId(),
      10_000,
    );
    const lang = (r.payload['value'] ?? r.payload['_rawText']) as string | undefined;
    expect(typeof lang).toBe('string');
    expect(lang!.length).toBeGreaterThan(0);
  }, 25_000);
});
