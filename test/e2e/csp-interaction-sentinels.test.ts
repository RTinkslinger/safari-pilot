/**
 * v0.1.34 Tasks 7-10 — e2e tests for sentinel-routed interaction tools on a
 * TT-strict (`require-trusted-types-for 'script'`) page.
 *
 * Verifies safari_click / safari_fill / safari_type / safari_scroll succeed
 * after the JS-string transport was replaced with __SP_<TOOL>__:<json>
 * sentinels in extension/content-main.js. On a TT-strict page, the previous
 * `new Function(params.script)` path is rejected by the browser; the sentinel
 * path bypasses that gate.
 *
 * Assertions are "no-throw" — deeper verification requires sentinel-immune
 * attribute reads (safari_get_attribute T12+, not yet refactored). T11's
 * batched verification gate runs this suite + page-info-tools together.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

function startInteractionFixture(): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict interaction fixture</title>
</head><body>
<button id="b1">Click me</button>
<input id="t1" type="text">
<input id="t2" type="text">
<div id="scroll-target" style="height: 200vh"></div>
<div id="evidence" data-clicks="0" data-fills="" data-types=""></div>
<script>
(function(){
  document.getElementById('b1').addEventListener('click', function() {
    var ev = document.getElementById('evidence');
    ev.setAttribute('data-clicks', String(parseInt(ev.getAttribute('data-clicks') || '0', 10) + 1));
  });
  document.getElementById('t1').addEventListener('change', function(e) {
    document.getElementById('evidence').setAttribute('data-fills', e.target.value);
  });
  document.getElementById('t2').addEventListener('input', function(e) {
    document.getElementById('evidence').setAttribute('data-types', e.target.value);
  });
})();
</script>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(0);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}

describe('CSP interaction sentinels (v0.1.34 Tasks 7-10)', () => {
  let fx: ReturnType<typeof startInteractionFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fx = startInteractionFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    fx?.server.close();
  }, 30_000);

  it('safari_click works on tt-strict pages (T7)', async () => {
    const target = `${fx.url()}?sp_t7=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    // No-throw is the strongest assertion possible without sentinel-immune
    // attribute reads (deferred to T12). A second click after the first proves
    // the first didn't fatally break the page.
    await callTool(client, 'safari_click', { tabUrl, selector: '#b1' }, nextId(), 15_000);
    await callTool(client, 'safari_click', { tabUrl, selector: '#b1' }, nextId(), 15_000);
  }, 60_000);

  it('safari_fill works on tt-strict pages (T8)', async () => {
    const target = `${fx.url()}?sp_t8=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_fill', { tabUrl, selector: '#t1', value: 'hello tt-strict' }, nextId(), 15_000);
  }, 60_000);

  it('safari_type works on tt-strict pages (T9)', async () => {
    const target = `${fx.url()}?sp_t9=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_type', { tabUrl, selector: '#t2', content: 'typed' }, nextId(), 15_000);
  }, 60_000);

  it('safari_scroll works on tt-strict pages (T10)', async () => {
    const target = `${fx.url()}?sp_t10=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_scroll', { tabUrl, direction: 'down', amount: 300 }, nextId(), 15_000);
  }, 60_000);

  it('safari_click works with role+name locator on tt-strict pages (T11_locator_role)', async () => {
    // T7b regression: locator resolution must go through __SP_RESOLVE_LOCATOR__
    // sentinel on TT-strict pages. No `new Function()` allowed.
    const target = `${fx.url()}?sp_t11_role=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_click', { tabUrl, role: 'button', name: 'Click me' }, nextId(), 15_000);
  }, 60_000);

  it('safari_click works with text locator on tt-strict pages (T11_locator_text)', async () => {
    // T7b regression: text locator path also runs through the resolve sentinel.
    const target = `${fx.url()}?sp_t11_text=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_click', { tabUrl, text: 'Click me' }, nextId(), 15_000);
  }, 60_000);
});
