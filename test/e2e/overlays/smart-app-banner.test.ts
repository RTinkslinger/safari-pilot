/**
 * Task 14 — per-pattern: smart-app-banner (app-install).
 *
 * POSITIVE: inline fixture below. Asserts dismissed[].id contains
 *   'smart-app-banner'. Currently EXPECTED TO FAIL — see KNOWN PATTERN BUG.
 * NEGATIVE: shipped fixture in test/fixtures/overlays-negative/smart-app-banner.negative.ts.
 *
 * KNOWN PATTERN BUG (flagged for v0.1.32 hardening — BLOCKER class):
 * `src/overlays/app-install.json` smart-app-banner has TWO `selector` signals:
 *   1. `meta[name=apple-itunes-app]` (lives in <head>)
 *   2. `.smart-app-banner, [class*=smartbanner i]` (lives in <body>)
 * `extension/locator.js` findPatternRoot picks the FIRST selector signal as
 * primary, finds ONE candidate (the meta tag), and requires `every` signal to
 * match that single element. A meta tag cannot match `.smart-app-banner`, so
 * the pattern is unmatchable on any site — it ships as dead code.
 *
 * Fix path (out of scope for T14): split into a "page-level selector exists"
 * signal type, or replace signal 1 with a body-compatible signal (e.g.
 * `aria-role` on the banner itself), or relax `every` to `findPatternRoot`
 * candidate-union semantics.
 *
 * The positive test below intentionally asserts the desired behavior so that
 * when the v0.1.32 fix lands, this test starts passing without code changes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startSmartAppBannerNegativeFixture } from '../../fixtures/overlays-negative/smart-app-banner.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

// Inline positive fixture — the shipped app-install-banner.ts lacks a click
// handler, so the click-action pattern's verify (node-removed) lands the
// dismissal in skipped[]. Mirror the click-removes-self shape from
// cookie-consent-onetrust.ts.
function startSmartAppBannerPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head>
<meta name="apple-itunes-app" content="app-id=12345">
</head><body>
<main><h1>Mobile site</h1></main>
<div class="smart-app-banner" style="position:fixed;top:0;left:0;right:0;background:#eee;padding:1em;z-index:9999">
  <span>Open in App</span>
  <button id="sab-close" aria-label="Close banner">×</button>
</div>
<script>
  document.getElementById('sab-close').addEventListener('click', function(){
    var n = document.querySelector('.smart-app-banner');
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

describe('pattern: smart-app-banner — positive + negative pair', () => {
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

  it('POSITIVE: dismisses smart-app-banner', async () => {
    const fixture = startSmartAppBannerPositiveFixture();
    try {
      const result = await dismiss(fixture.url(), 'smartapp-pos');
      expect(result.dismissed.some((d) => d.id === 'smart-app-banner')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate fixed banner without app-install signals', async () => {
    const fixture = startSmartAppBannerNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'smartapp-neg');
      expect(result.dismissed.every((d) => d.id !== 'smart-app-banner')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
