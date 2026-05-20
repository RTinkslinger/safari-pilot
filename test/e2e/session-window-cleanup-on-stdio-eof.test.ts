/**
 * Investigate: session window leak on serial probe.
 *
 * Empirical (v0.1.37 SP-T01-bare /tmp/bare2b-sp/Allrecipes--1-r1):
 *   pre=1, post=2, delta=1
 *
 * Trace: agent called safari_new_tab, safari_navigate, safari_close_tab
 * (closed the recipe tab), then claude exited. The session window
 * should have closed via the gracefulShutdown('STDIO_EOF') path in
 * dist/index.js (line 112: process.stdin.on('end', gracefulShutdown)),
 * which calls server.shutdown() → closeSessionWindow() which runs
 * `osascript ... close window id ${wid}` with 3s timeout.
 *
 * Hypothesis under test: closing the LAST agent-tab (the recipe tab) via
 * safari_close_tab causes Safari to close the window OR confuses the
 * session_window_id bookkeeping, so closeSessionWindow's later call
 * either targets an already-closed window or a stale id.
 *
 * Strategy: don't spawn a fresh server here — that's heavy and slow.
 * Instead use the shared MCP client (already connected to a running
 * server with a session window). Capture the session window count
 * delta around the safari_close_tab call WITHOUT exiting the server.
 * If the count drops by 1 immediately, the bug is in shutdown ordering.
 * If it stays the same, the bug is in shutdown's osascript path.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

function safariWindowCount(): number {
  try {
    const out = execSync(
      `osascript -e 'tell application "Safari" to count of windows'`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return parseInt(out, 10);
  } catch {
    return -1;
  }
}

function safariWindowNames(): string[] {
  try {
    const out = execSync(
      `osascript -e 'tell application "Safari" to get name of every window'`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    return out.split(',').map((s) => s.trim());
  } catch {
    return [];
  }
}

describe('Investigate: session window leak around safari_close_tab', () => {
  let client: McpTestClient;
  let nextId: () => number;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30000);

  it('characterizes Safari window count across new_tab + close_tab sequence', async () => {
    const start = safariWindowCount();
    const startNames = safariWindowNames();
    console.log(`[diag] START: count=${start} names=${JSON.stringify(startNames)}`);

    // 1. Open a tab. It should go INTO the session window (per F1.2 isolation).
    const tab = await callTool(client, 'safari_new_tab', {
      url: `https://example.com/?leak_test=${Date.now()}`,
    }, nextId());
    const tabUrl = tab.tabUrl as string;
    const after_new = safariWindowCount();
    const after_new_names = safariWindowNames();
    console.log(`[diag] AFTER safari_new_tab: count=${after_new} names=${JSON.stringify(after_new_names)} tabUrl=${tabUrl} windowId=${(tab as { windowId?: number }).windowId}`);

    // 2. Close the tab.
    const closeResult = await callTool(client, 'safari_close_tab', { tabUrl }, nextId());
    console.log(`[diag] safari_close_tab result: ${JSON.stringify(closeResult)}`);
    // Tiny settle delay so Safari has time to actually close the window if
    // the last tab triggered window-close.
    await new Promise((r) => setTimeout(r, 500));
    const after_close = safariWindowCount();
    const after_close_names = safariWindowNames();
    console.log(`[diag] AFTER safari_close_tab: count=${after_close} names=${JSON.stringify(after_close_names)}`);

    // The session window (one of the windows present at start) should NOT
    // have leaked a NEW one. So count after close <= count at start.
    // (If safari_new_tab opens into the existing session window, then
    // close_tab restores parity. If new_tab created a new window, then
    // close_tab on the last tab should close that window.)
    expect(after_close, `Expected window count to return to start (${start}) or below, got ${after_close}`).toBeLessThanOrEqual(start);
  }, 30000);
});
