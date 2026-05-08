/**
 * Task 14 — per-pattern: didomi-notice (cookie-consent).
 *
 * Pattern signals: selector #didomi-notice + aria-role=dialog.
 * Dismiss: click #didomi-notice-agree-button + verify node-removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startDidomiNoticeNegativeFixture } from '../../fixtures/overlays-negative/didomi-notice.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

function startDidomiPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><h1>Article</h1></main>
<div id="didomi-notice" role="dialog" aria-label="Cookie consent"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:1em;z-index:9999">
  <p>This site uses cookies.</p>
  <button id="didomi-notice-agree-button">Agree and close</button>
</div>
<script>
  document.getElementById('didomi-notice-agree-button').addEventListener('click', function(){
    var n = document.getElementById('didomi-notice');
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

describe('pattern: didomi-notice — positive + negative pair', () => {
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
    return (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['cookie-consent'] }, nextId(), 30_000)) as unknown as DismissResult;
  }

  it('POSITIVE: dismisses didomi-notice', async () => {
    const fixture = startDidomiPositiveFixture();
    try {
      const result = await dismiss(fixture.url(), 'didomi-pos');
      expect(result.dismissed.some((d) => d.id === 'didomi-notice')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate dialog reusing #didomi-notice id', async () => {
    const fixture = startDidomiNoticeNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'didomi-neg');
      expect(result.dismissed.every((d) => d.id !== 'didomi-notice')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
