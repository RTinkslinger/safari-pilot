/**
 * v0.1.35 Task 9 — playbook tools e2e
 *
 * NOTE: The cookie-consent and rate-limit tests exercise extension sentinels
 * (__SP_DISMISS_OVERLAYS__ and __SP_WAIT_RATE_LIMIT_CLEAR__). The latter is
 * NEW in this task and is only present in the rebuilt extension produced by
 * the batched rebuild scheduled at the end of v0.1.35 Task 10. Until then,
 * those two suites will fail with "Unknown method" / sentinel-not-found
 * style errors from the installed extension. The safari_normalize_date suite
 * is engine-free and runs today.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('v0.1.35 T9 — playbook tools', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    if (fixture) await fixture.close();
  });

  describe('safari_normalize_date', () => {
    it('parses an English date string into ISO + components', async () => {
      const r = (await callTool(
        client,
        'safari_normalize_date',
        { input: 'January 10, 2027' },
        nextId(),
        10_000,
      )) as { iso?: string; components?: { year: number; month: number; day: number }; isError?: boolean };
      expect(r.isError).toBe(false);
      expect(r.iso).toBe('2027-01-10');
      expect(r.components).toEqual({ year: 2027, month: 1, day: 10 });
    });

    it('returns isError when input is not a parseable date', async () => {
      const r = (await callTool(
        client,
        'safari_normalize_date',
        { input: 'not a date at all' },
        nextId(),
        10_000,
      )) as { isError?: boolean; message?: string };
      expect(r.isError).toBe(true);
      expect(typeof r.message).toBe('string');
    });
  });

  describe('safari_dismiss_cookie_consent', () => {
    it('dismisses a cookie banner on a fixture page', async () => {
      const target = `http://127.0.0.1:${fixture.hostPort}/cookie-banner?sp_tT9a=${Date.now()}`;
      const tab = (await callTool(
        client,
        'safari_new_tab',
        { url: target },
        nextId(),
        15_000,
      )) as { tabUrl?: string; tab_id?: number };
      const tabUrl = tab.tabUrl ?? target;
      const tabId = tab.tab_id;
      // Settle for extension tab cache + content script injection.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const r = (await callTool(
          client,
          'safari_dismiss_cookie_consent',
          { tabUrl },
          nextId(),
          30_000,
        )) as { dismissed?: boolean; banner_type?: string };
        expect(r.dismissed).toBe(true);
        expect(r.banner_type).toBe('cookie-consent');
      } finally {
        if (typeof tabId === 'number') {
          await callTool(client, 'safari_close_tab', { tabId }, nextId(), 10_000).catch(() => {});
        }
      }
    }, 60_000);
  });

  describe('safari_wait_for_rate_limit_clear', () => {
    it('reports ready:true when no rate-limit indicator is present', async () => {
      const url = `http://127.0.0.1:${fixture.hostPort}/bench-smoke?sp_tT9b=${Date.now()}`;
      const tab = (await callTool(
        client,
        'safari_new_tab',
        { url },
        nextId(),
        15_000,
      )) as { tab_id?: number };
      const tabId = tab.tab_id;
      try {
        const r = (await callTool(
          client,
          'safari_wait_for_rate_limit_clear',
          { tabUrl: url, max_wait_ms: 4000 },
          nextId(),
          15_000,
        )) as { ready?: boolean; waited_ms?: number };
        expect(r.ready).toBe(true);
        expect(typeof r.waited_ms).toBe('number');
        expect(r.waited_ms!).toBeLessThan(5000);
      } finally {
        if (typeof tabId === 'number') {
          await callTool(client, 'safari_close_tab', { tabId }, nextId(), 10_000).catch(() => {});
        }
      }
    }, 30_000);
  });
});
