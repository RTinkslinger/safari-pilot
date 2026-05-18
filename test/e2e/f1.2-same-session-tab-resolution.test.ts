/**
 * Bug-1 (2026-05-18 evening) — F1.2 same-session tab resolution must succeed.
 *
 * DISCRIMINATING ASSERTION:
 *   Pre-fix: extension/background.js spFilterBySession compares the
 *   daemon-supplied `cmd.sessionWindowId` (AppleScript's `id of window N`
 *   from src/server.ts:1622) against cache entries' `t.windowId` from
 *   browser.tabs.query (WebExtension API). Two different integer
 *   namespaces — they never match. Every same-session extension-engine
 *   call returns TAB_NOT_FOUND because the filter drops every candidate
 *   before the URL matcher runs. The 2026-05-18 22:53 IST per-window
 *   smoke (Allrecipes--0) caught this: agent opened a tab via
 *   AppleScript-engine safari_new_tab, then every subsequent
 *   safari_evaluate/safari_snapshot/safari_query_all failed with
 *   "(extension cache miss)" + "Same-origin tabs in cache: <exact URL>"
 *   — the cache HAS the tab; the filter rejected it.
 *
 *   Post-fix: daemon sends `sessionDashboardUrl` (a string URL — stable
 *   across the AppleScript / WebExtension boundary) in place of
 *   `sessionWindowId`. Extension watches tabs.onUpdated for the
 *   dashboard URL pattern, captures the WebExtension `tab.windowId`, and
 *   resolves `sessionDashboardUrl → windowId` via that map before
 *   filtering. The filter now compares WebExtension IDs to WebExtension
 *   IDs.
 *
 * Test mechanics: spawn a real MCP server via dist/index.js (claude's
 * production entry), open a data: URL tab via safari_new_tab, then
 * resolve that tab via safari_get_text (extension engine — needs JS
 * execution). Pre-fix the get_text call fails with TAB_NOT_FOUND. Post-fix
 * the call returns text containing the marker embedded in the data URL.
 *
 * Uses initClient + callTool helpers (real MCP stdio, zero mocks). The
 * data: URL marker rules out cross-test pollution from any other tab
 * named "search" or similar.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { initClient, callTool } from '../helpers/mcp-client.js';

const MARKER = `F12_SAMESESSION_${Date.now()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const TAB_URL = `data:text/html,<html><body><h1>${MARKER}</h1></body></html>`;

describe('F1.2 — same-session tab resolution succeeds via extension engine', () => {
  const sessions: Array<{ close: () => Promise<void> }> = [];

  afterAll(async () => {
    for (const s of sessions) {
      try { await s.close(); } catch { /* swept */ }
    }
  });

  it('opens a tab via safari_new_tab and reads it via safari_get_text in the same session', async () => {
    const sess = await initClient('dist/index.js');
    sessions.push({ close: () => sess.client.close() });
    const nextId = (() => { let n = sess.nextId; return () => n++; })();

    // Open the tab. safari_new_tab routes to the AppleScript engine
    // (engine selector: no JS execution needed). This part works pre-fix.
    const open = await callTool(sess.client, 'safari_new_tab', { url: TAB_URL }, nextId(), 30000);
    const openedTabUrl = open.tabUrl as string | undefined;
    expect(openedTabUrl, 'safari_new_tab must return tabUrl').toBeDefined();

    try {
      // The discriminator: safari_get_text needs JS execution, so it
      // routes to the extension engine. Pre-fix, the F1.2 filter rejects
      // every candidate (windowId namespace mismatch), returning
      // TAB_NOT_FOUND. Post-fix, the dashboard-URL handshake resolves the
      // session's window in the WebExtension namespace, the filter keeps
      // this tab, and the text comes back containing MARKER.
      const read = await callTool(
        sess.client,
        'safari_get_text',
        { tabUrl: openedTabUrl, selector: 'h1' },
        nextId(),
        15000,
      );
      const text = (read.text as string) ?? JSON.stringify(read);
      expect(
        text,
        `Same-session safari_get_text must read the tab opened by the same MCP session. ` +
        `If this fails with TAB_NOT_FOUND, the F1.2 windowId namespace mismatch is ` +
        `still rejecting the originating session's own candidates.`,
      ).toContain(MARKER);
    } finally {
      try {
        if (openedTabUrl) {
          await callTool(sess.client, 'safari_close_tab', { tabUrl: openedTabUrl }, nextId());
        }
      } catch { /* best effort */ }
    }
  }, 90_000);
});
