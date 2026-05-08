/**
 * Task 14 — per-pattern: cookiebot-dialog (cookie-consent).
 *
 * POSITIVE: inline fixture with #CybotCookiebotDialog + role=dialog +
 *   click-removes-self handler on #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll.
 * NEGATIVE: shipped fixture in test/fixtures/overlays-negative/cookiebot-dialog.negative.ts.
 *
 * Per Task-14 plan: assert positive case lands in dismissed[] with id ===
 * 'cookiebot-dialog'; assert negative case is NOT dismissed (loose .every()
 * form so later additions to the allowlist don't false-fail this test).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startCookiebotDialogNegativeFixture } from '../../fixtures/overlays-negative/cookiebot-dialog.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

function startCookiebotPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Article body</h1></main>
<div id="CybotCookiebotDialog" role="dialog" aria-label="We use cookies"
     style="position:fixed;bottom:0;left:0;right:0;background:#222;color:#fff;padding:1em;z-index:9999">
  <p>This site uses cookies.</p>
  <button id="CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll">Allow all</button>
</div>
<script>
  document.getElementById('CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll').addEventListener('click', function(){
    var n = document.getElementById('CybotCookiebotDialog');
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

describe('pattern: cookiebot-dialog — positive + negative pair', () => {
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

  it('POSITIVE: dismisses cookiebot-dialog', async () => {
    const fixture = startCookiebotPositiveFixture();
    try {
      const result = await dismiss(fixture.url(), 'cookiebot-pos');
      expect(result.dismissed.some((d) => d.id === 'cookiebot-dialog')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate dialog with #CybotCookiebotDialog id', async () => {
    const fixture = startCookiebotDialogNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'cookiebot-neg');
      expect(result.dismissed.every((d) => d.id !== 'cookiebot-dialog')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
