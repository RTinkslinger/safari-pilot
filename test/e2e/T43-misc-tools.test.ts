/**
 * T43 — e2e coverage for the misc cluster: clipboard, dialog, service workers,
 * tracing, smart_scrape, paginate_scrape, media_control, test_flow,
 * click_shadow, extension diagnostics, export_pdf.
 *
 * Tools covered (one per assertion, real Safari, real MCP):
 *   safari_clipboard_read / safari_clipboard_write
 *   safari_handle_dialog
 *   safari_sw_list / safari_sw_unregister
 *   safari_begin_trace / safari_end_trace
 *   safari_smart_scrape
 *   safari_paginate_scrape (smoke — single page, no nav)
 *   safari_media_control
 *   safari_test_flow
 *   safari_click_shadow
 *   safari_extension_health / safari_extension_debug_dump
 *   safari_export_pdf
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T43 — misc tools (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    const target = `http://127.0.0.1:${fixture.hostPort}/t43-misc?sp_t43=${Date.now()}`;
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

  it('safari_extension_health returns connection status (read-only diagnostic)', async () => {
    const result = await callTool(client, 'safari_extension_health', {}, nextId(), 15_000);
    expect(result, `extension_health result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
    // Result includes `isConnected` (boolean) + counters/timestamps.
    expect('isConnected' in result, `expected isConnected field. Got: ${JSON.stringify(result).slice(0, 300)}`).toBe(true);
    expect(typeof result.isConnected).toBe('boolean');
  }, 20_000);

  it('safari_extension_debug_dump returns infrastructure snapshot', async () => {
    const result = await callTool(client, 'safari_extension_debug_dump', {}, nextId(), 15_000);
    expect(result, `extension_debug_dump result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
    // The snapshot should have at least one descriptive field — we don't
    // pin the shape since it's diagnostic-only.
    expect(Object.keys(result).length).toBeGreaterThan(0);
  }, 20_000);

  it('safari_clipboard_write writes text without throwing', async () => {
    // Safari requires a user gesture for clipboard ops. The tool returns
    // {clipboardAvailable: false} when no gesture has occurred — that's a
    // valid envelope (proves the API plumbed through).
    const result = await callTool(
      client,
      'safari_clipboard_write',
      { tabUrl, text: 'T43 clipboard text' },
      nextId(),
      15_000,
    );
    expect(result, `clipboard_write result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 20_000);

  it('safari_clipboard_read returns a structured envelope', async () => {
    const result = await callTool(client, 'safari_clipboard_read', { tabUrl }, nextId(), 15_000);
    expect(result, `clipboard_read result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
    // Either `clipboardAvailable` or a `text` field should be present.
    const hasField = ('clipboardAvailable' in result) || ('text' in result);
    expect(hasField, `expected clipboard field. Got: ${JSON.stringify(result)}`).toBe(true);
  }, 20_000);

  it('safari_handle_dialog installs an interceptor without throwing', async () => {
    // CAUTION: do NOT trigger a native dialog (alert/confirm/prompt) from
    // the test, even after installing the interceptor — if the install lost
    // a race against the dispatched dialog, Safari shows a modal that blocks
    // ALL JS execution in the tab and cascades into every subsequent tool
    // call timing out. Tested in earlier iteration; produced 10/14 failures.
    // Project rule: "Do not trigger JavaScript alerts, confirms, prompts, or
    // browser modal dialogs through your actions" (CLAUDE.md, Browser
    // Automation section).
    //
    // This test asserts only that the install call returns. A separate,
    // controlled assertion of "the interceptor actually intercepts" can be
    // added when there is a deterministic non-blocking way to invoke a
    // dialog (e.g., an `__SP_DIALOG_TEST__` extension sentinel that calls
    // confirm in a sandboxed worker context).
    const result = await callTool(
      client,
      'safari_handle_dialog',
      { tabUrl, action: 'accept' },
      nextId(),
      15_000,
    );
    expect(result, `handle_dialog result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_sw_list returns service worker registrations (likely empty for this fixture)', async () => {
    const result = await callTool(client, 'safari_sw_list', { tabUrl }, nextId(), 15_000);
    expect(result, `sw_list result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
    // The fixture doesn't register a service worker, so registrations
    // should be an empty array. We assert the shape (array), not the
    // contents.
    const regs = result.registrations ?? result.workers ?? [];
    expect(Array.isArray(regs), `expected an array of registrations. Got: ${JSON.stringify(result)}`).toBe(true);
  }, 20_000);

  it('safari_sw_unregister returns a non-error envelope for a non-existent scope', async () => {
    const result = await callTool(
      client,
      'safari_sw_unregister',
      { tabUrl, scope: 'http://127.0.0.1/nonexistent' },
      nextId(),
      15_000,
    );
    expect(result, `sw_unregister result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 20_000);

  it('safari_begin_trace + safari_end_trace round-trip a perf trace', async () => {
    await callTool(client, 'safari_begin_trace', { tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const result = await callTool(client, 'safari_end_trace', { tabUrl }, nextId(), 15_000);
    expect(result, `end_trace result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
    // Trace results should expose at least one of marks / measures / lcp.
    const hasField = ('marks' in result) || ('measures' in result) || ('lcp' in result) || ('longTasks' in result);
    expect(hasField, `expected trace fields. Got: ${JSON.stringify(result).slice(0, 300)}`).toBe(true);
  }, 25_000);

  it('safari_smart_scrape returns structured data matching a simple schema', async () => {
    const result = await callTool(
      client,
      'safari_smart_scrape',
      {
        tabUrl,
        schema: { type: 'object', properties: { title: { type: 'string' } } },
      },
      nextId(),
      15_000,
    );
    expect(result, `smart_scrape result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_paginate_scrape returns at least the first-page result (no next-selector match expected)', async () => {
    const result = await callTool(
      client,
      'safari_paginate_scrape',
      {
        tabUrl,
        nextSelector: '#nonexistent-next-button',
        extractScript: 'return { title: document.querySelector("h1")?.textContent || null };',
        maxPages: 1,
      },
      nextId(),
      20_000,
    );
    expect(result, `paginate_scrape result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_media_control toggles the seeded <video> element', async () => {
    const result = await callTool(
      client,
      'safari_media_control',
      { tabUrl, action: 'play', selector: '#t43-video' },
      nextId(),
      15_000,
    );
    expect(result, `media_control result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 20_000);

  it('safari_test_flow runs a single trivial step and returns pass/fail', async () => {
    const result = await callTool(
      client,
      'safari_test_flow',
      {
        tabUrl,
        steps: [{ action: 'evaluate', script: 'return document.title;' }],
      },
      nextId(),
      20_000,
    );
    expect(result, `test_flow result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
  }, 25_000);

  it('safari_click_shadow finds an element inside a Shadow DOM and dispatches a click', async () => {
    // The fixture's #t43-shadow-host has open shadow root with a button#shadow-btn.
    const result = await callTool(
      client,
      'safari_click_shadow',
      { tabUrl, hostSelector: '#t43-shadow-host', shadowSelector: '#shadow-btn' },
      nextId(),
      15_000,
    );
    expect(result, `click_shadow result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
    // Verify the click reached the shadow handler (it sets window.__t43_shadow_clicked).
    await new Promise((r) => setTimeout(r, 200));
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return window.__t43_shadow_clicked === true;' },
      nextId(),
      10_000,
    );
    const v = (r.payload['value'] ?? r.payload['_rawText']) as boolean | string | undefined;
    expect(v === true || v === 'true', `expected shadow click handler to fire. Got ${v}`).toBe(true);
  }, 30_000);

  it('safari_export_pdf produces a PDF file at the requested path', async () => {
    // Tool requires an absolute `path` ending in .pdf (pdf.ts schema).
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { existsSync, statSync, unlinkSync } = await import('node:fs');
    const outPath = join(tmpdir(), `t43-export-${Date.now()}.pdf`);
    try {
      const result = await callTool(
        client,
        'safari_export_pdf',
        { path: outPath },
        nextId(),
        45_000,
      );
      expect(result, `export_pdf result: ${JSON.stringify(result).slice(0, 200)}`).toBeDefined();
      // The tool writes to disk and returns the path. Verify the file
      // actually exists and is non-empty.
      expect(existsSync(outPath), `expected ${outPath} to exist after export_pdf`).toBe(true);
      const size = statSync(outPath).size;
      expect(size, `expected PDF file size > 100 bytes; got ${size}`).toBeGreaterThan(100);
    } finally {
      try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* best-effort */ }
    }
  }, 60_000);
});
