/**
 * Task 14 — per-pattern: quantcast-cmp (cookie-consent).
 *
 * Pattern signals: selector .qc-cmp2-container + aria-label containing "consent".
 * Dismiss: click .qc-cmp2-summary-buttons button[mode=primary] + verify node-removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startQuantcastCmpNegativeFixture } from '../../fixtures/overlays-negative/quantcast-cmp.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

function startQuantcastPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><h1>Article</h1></main>
<div class="qc-cmp2-container" role="dialog" aria-label="We need your consent"
     style="position:fixed;bottom:0;left:0;right:0;background:#222;color:#fff;padding:1em;z-index:9999">
  <p>We use cookies and similar tech.</p>
  <div class="qc-cmp2-summary-buttons">
    <button mode="primary" id="qc-accept">Accept</button>
    <button mode="secondary">Decline</button>
  </div>
</div>
<script>
  document.getElementById('qc-accept').addEventListener('click', function(){
    var n = document.querySelector('.qc-cmp2-container');
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

describe('pattern: quantcast-cmp — positive + negative pair', () => {
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

  it('POSITIVE: dismisses quantcast-cmp', async () => {
    const fixture = startQuantcastPositiveFixture();
    try {
      const result = await dismiss(fixture.url(), 'qc-pos');
      expect(result.dismissed.some((d) => d.id === 'quantcast-cmp')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate dialog without quantcast signals', async () => {
    const fixture = startQuantcastCmpNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'qc-neg');
      expect(result.dismissed.every((d) => d.id !== 'quantcast-cmp')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
