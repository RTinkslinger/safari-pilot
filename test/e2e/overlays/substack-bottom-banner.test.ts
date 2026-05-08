/**
 * Task 14 — per-pattern: substack-bottom-banner (registration-wall).
 *
 * Pattern signals: selector .main-modal + aria-label containing "subscribe".
 * Dismiss: click `.main-modal button[aria-label*=close i]` + verify node-removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startSubstackBottomBannerNegativeFixture } from '../../fixtures/overlays-negative/substack-bottom-banner.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

function startSubstackPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><article><h1>Newsletter post</h1></article></main>
<!-- intentionally NO role=dialog: prevents generic-newsletter-modal pattern
       from out-matching substack-bottom-banner (both share aria-label
       "subscribe"; generic uses [role=dialog] selector and is registered
       earlier in registration-walls.json, so it would dismiss first).
  -->
<div class="main-modal" aria-label="Subscribe to keep reading"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1em;z-index:9999">
  <p>Subscribe to continue.</p>
  <button id="ss-close" aria-label="Close">×</button>
</div>
<script>
  document.getElementById('ss-close').addEventListener('click', function(){
    var n = document.querySelector('.main-modal');
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

describe('pattern: substack-bottom-banner — positive + negative pair', () => {
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
    return (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['registration-wall'] }, nextId(), 30_000)) as unknown as DismissResult;
  }

  it('POSITIVE: dismisses substack-bottom-banner', async () => {
    const fixture = startSubstackPositiveFixture();
    try {
      const result = await dismiss(fixture.url(), 'substack-pos');
      expect(result.dismissed.some((d) => d.id === 'substack-bottom-banner')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate .main-modal without subscribe label', async () => {
    const fixture = startSubstackBottomBannerNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'substack-neg');
      expect(result.dismissed.every((d) => d.id !== 'substack-bottom-banner')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
