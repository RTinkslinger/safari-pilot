/**
 * Task 14 — per-pattern: bloomberg-overlay (paywall).
 *
 * Pattern signals: selector `.paywall-banner, [data-component=paywall-overlay]`
 *   + fixed-position.
 * Dismiss: action=remove-node (no click handler needed in fixture).
 * Requires SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true. Per-test client spawn.
 */
import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { initClient, callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { startBloombergOverlayNegativeFixture } from '../../fixtures/overlays-negative/bloomberg-overlay.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

function startBloombergPositiveFixture(): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><article><h1>Markets headline</h1></article></main>
<div class="paywall-banner" data-component="paywall-overlay"
     style="position:fixed;bottom:0;left:0;right:0;background:#000;color:#fff;padding:2em;z-index:9999">
  <h2>Continue with Bloomberg</h2>
  <button>Subscribe</button>
</div>
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

async function spawnEnvClient(env: Record<string, string>): Promise<{ client: McpTestClient; nextId: () => number }> {
  let id: number;
  const initRes = await initClient('dist/index.js', 1, { env });
  id = initRes.nextId;
  return { client: initRes.client, nextId: () => id++ };
}

async function dismissOnSpawnedClient(
  client: McpTestClient,
  nextId: () => number,
  url: string,
  marker: string,
): Promise<{ tabUrl: string; result: DismissResult }> {
  const tab = await callTool(client, 'safari_new_tab', { url: `${url}?sp_pat=${marker}-${Date.now()}` }, nextId(), 15_000);
  const tabUrl = tab.tabUrl as string;
  await callTool(client, 'safari_wait_for', {
    tabUrl, condition: 'function', value: 'return document.readyState === "complete"', timeout: 10_000,
  }, nextId(), 15_000);
  await new Promise((r) => setTimeout(r, 800));
  const result = (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['paywall'] }, nextId(), 30_000)) as unknown as DismissResult;
  return { tabUrl, result };
}

describe('pattern: bloomberg-overlay — positive + negative pair', () => {
  it('POSITIVE: dismisses bloomberg-overlay (with SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true)', async () => {
    const { client, nextId } = await spawnEnvClient({ SAFARI_PILOT_ENABLE_PAYWALL_DISMISS: 'true' });
    const fixture = startBloombergPositiveFixture();
    let tabUrl: string | undefined;
    try {
      const r = await dismissOnSpawnedClient(client, nextId, fixture.url(), 'bloomberg-pos');
      tabUrl = r.tabUrl;
      expect(r.result.dismissed.some((d) => d.id === 'bloomberg-overlay')).toBe(true);
    } finally {
      if (tabUrl) { try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ } }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);

  it('NEGATIVE: does NOT dismiss legitimate .paywall-banner without fixed-position', async () => {
    const { client, nextId } = await spawnEnvClient({ SAFARI_PILOT_ENABLE_PAYWALL_DISMISS: 'true' });
    const fixture = startBloombergOverlayNegativeFixture();
    let tabUrl: string | undefined;
    try {
      const r = await dismissOnSpawnedClient(client, nextId, fixture.url(), 'bloomberg-neg');
      tabUrl = r.tabUrl;
      expect(r.result.dismissed.every((d) => d.id !== 'bloomberg-overlay')).toBe(true);
    } finally {
      if (tabUrl) { try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ } }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);
});
