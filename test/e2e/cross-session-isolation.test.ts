/**
 * F1.2 — Cross-session tab isolation through the real MCP stack.
 *
 * Pre-F1.2 extension/background.js findTargetTab called browser.tabs.query({})
 * which returns ALL Safari tabs across ALL windows regardless of which MCP
 * session opened them. At bench concurrency 4 (or any time two MCP sessions
 * share a Safari instance), the 4-tier URL matcher could match a tab opened
 * by a different session — silently routing one agent's command into
 * another agent's tab. TabOwnership at the TS layer fails CLOSED but only
 * if the extension returns the wrong tab to begin with.
 *
 * F1.2 threads `sessionWindowId` through every extension_execute payload
 * (TS engine -> daemon ExtensionBridge -> background.js cmd body -> filter
 * applied before the URL matcher). Cross-session tabs are excluded from
 * the candidate pool.
 *
 * This test spawns two real MCP server processes, opens a tab in Session B,
 * and asserts Session A cannot resolve B's tab via safari_get_text (must
 * fail with TAB_URL_NOT_RECOGNIZED / TAB_NOT_FOUND). Session B must still
 * read its own tab successfully.
 *
 * Per CLAUDE.md HARD RULES: real spawn, real MCP protocol, real daemon,
 * zero stubs (no mocks anywhere — the pre-commit hook enforces that
 * contract for every file under test/e2e/).
 *
 * Requires:
 *   - Dev.10 (or later) extension installed in Safari with F1.2's
 *     sessionWindowId filter in background.js findTargetTab.
 *   - Daemon on TCP:19474 / HTTP:19475 (provisioned by global setup).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { initClient, callTool } from '../helpers/mcp-client.js';

describe('F1.2 — cross-session tab isolation', () => {
  // Two ad-hoc independent MCP server processes. Each owns its own Safari
  // window via the daemon's /session/register endpoint. We can't use
  // getSharedClient() for either side — the shared singleton is one
  // session by design, and this test is specifically about TWO sessions.
  const sessions: Array<{ close: () => Promise<void> }> = [];

  afterAll(async () => {
    for (const s of sessions) {
      try { await s.close(); } catch { /* swept */ }
    }
  });

  it('Session A cannot resolve a tab opened by Session B', async () => {
    const sessA = await initClient('dist/index.js');
    const sessB = await initClient('dist/index.js');
    sessions.push({ close: () => sessA.client.close() });
    sessions.push({ close: () => sessB.client.close() });

    const aNextId = (() => { let n = sessA.nextId; return () => n++; })();
    const bNextId = (() => { let n = sessB.nextId; return () => n++; })();

    // Session B opens a tab. Use a unique URL marker so cross-test
    // pollution is impossible.
    const bUrl = `data:text/html,<html><body><h1>F12_SESSION_B_ONLY_${Date.now()}</h1></body></html>`;
    const bOpen = await callTool(sessB.client, 'safari_new_tab', { url: bUrl }, bNextId(), 30000);
    const bTabUrl = bOpen.tabUrl as string;
    expect(bTabUrl, 'Session B must successfully open a tab').toBeDefined();

    try {
      // PRIMARY ORACLE — Session A tries to read Session B's tab and fails.
      // Without F1.2, A's findTargetTab returns B's tab id (browser.tabs.query
      // sees ALL windows). TabOwnership at A's TS layer then catches the
      // mismatch and throws TabUrlNotRecognizedError. With F1.2, the filter
      // excludes B's tab from the candidate pool BEFORE the URL matcher
      // runs, so A's extension returns TAB_NOT_FOUND structurally; A's
      // ownership layer still rejects.
      //
      // Either way the call must fail. The point is that A must NOT
      // successfully execute against B's tab — that would be the smoking
      // gun of cross-session pollution.
      let thrown: unknown;
      try {
        await callTool(
          sessA.client,
          'safari_get_text',
          { tabUrl: bTabUrl, selector: 'h1' },
          aNextId(),
          15000,
        );
      } catch (e) {
        thrown = e;
      }
      expect(
        thrown,
        'Session A reading Session B\'s tab MUST fail. If this passed, ' +
        'F1.2 sessionWindowId filtering OR pre-existing TabOwnership ' +
        'guardrail is broken — cross-session tab pollution is now possible.',
      ).toBeDefined();
      const errMsg = thrown instanceof Error ? thrown.message : String(thrown);
      // The error message should reference the un-recognized tab URL.
      expect(errMsg.toLowerCase()).toContain('session_b_only');

      // SECONDARY ORACLE — Session B can still read its own tab. Pins the
      // F1.2 contract: the filter doesn't break legitimate same-session
      // matches; it only excludes cross-session candidates.
      const bRead = await callTool(
        sessB.client,
        'safari_get_text',
        { tabUrl: bTabUrl, selector: 'h1' },
        bNextId(),
        15000,
      );
      const text = (bRead.text as string) ?? JSON.stringify(bRead);
      expect(
        text.toUpperCase(),
        'Session B must successfully read its own tab. If this fails, the ' +
        'F1.2 filter is excluding the originating session\'s own window.',
      ).toContain('F12_SESSION_B_ONLY');
    } finally {
      // Clean up B's tab.
      try {
        await callTool(sessB.client, 'safari_close_tab', { tabUrl: bTabUrl }, bNextId());
      } catch { /* best effort */ }
    }
  }, 90000);
});
