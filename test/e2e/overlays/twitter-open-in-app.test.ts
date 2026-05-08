/**
 * Task 14 — per-pattern: twitter-open-in-app (app-install).
 *
 * Pattern signals: selector [data-testid=BottomBar] + aria-label containing "open in".
 * Dismiss: click `[data-testid=BottomBar] [aria-label*=dismiss i]` + verify node-removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startTwitterOpenInAppNegativeFixture } from '../../fixtures/overlays-negative/twitter-open-in-app.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

function startTwitterPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><h1>Home</h1><p>Your timeline.</p></main>
<div data-testid="BottomBar" aria-label="Open in the X app for the best experience"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:0.75em;z-index:9999">
  <span>Open in app</span>
  <button id="tw-dismiss" aria-label="Dismiss banner">×</button>
</div>
<script>
  document.getElementById('tw-dismiss').addEventListener('click', function(){
    var n = document.querySelector('[data-testid=BottomBar]');
    if (n) n.parentNode.removeChild(n);
  });
</script>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.listen(0);
  return {
    server,
    url: () => {
      const a = server.address();
      if (typeof a === 'string' || a === null) throw new Error('no addr');
      return `http://127.0.0.1:${a.port}/`;
    },
  };
}

describe('pattern: twitter-open-in-app — positive + negative pair', () => {
  let client: McpTestClient;
  let nextId: () => number;
  const opened: string[] = [];

  beforeAll(async () => { const s = await getSharedClient(); client = s.client; nextId = s.nextId; }, 35_000);

  afterAll(async () => {
    if (!client) return;
    for (const u of opened) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: u }, nextId()); } catch { /* ignore */ }
    }
  });

  async function dismiss(url: string, marker: string): Promise<DismissResult> {
    const tab = await callTool(client, 'safari_new_tab', { url: `${url}?sp_pat=${marker}-${Date.now()}` }, nextId(), 15_000);
    const tabUrl = tab.tabUrl as string;
    opened.push(tabUrl);
    await callTool(client, 'safari_wait_for', {
      tabUrl, condition: 'function', value: 'return document.readyState === "complete"', timeout: 10_000,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 800));
    return (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['app-install'] }, nextId(), 30_000)) as unknown as DismissResult;
  }

  it('POSITIVE: dismisses twitter-open-in-app', async () => {
    const fixture = startTwitterPositiveFixture();
    try {
      const result = await dismiss(fixture.url(), 'twitter-pos');
      expect(result.dismissed.some((d) => d.id === 'twitter-open-in-app')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss compose-tweet BottomBar (no "open in" in label)', async () => {
    const fixture = startTwitterOpenInAppNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'twitter-neg');
      expect(result.dismissed.every((d) => d.id !== 'twitter-open-in-app')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
