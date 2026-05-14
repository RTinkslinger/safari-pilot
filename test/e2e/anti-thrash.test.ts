/**
 * v0.1.35 Task 5 — anti-thrash controls e2e.
 *
 * Verifies the two detectors land through the real MCP pipeline:
 *
 *   1. LOOP: 5 identical (tool, key-args) calls in a row → LOOP_DETECTED on
 *      the 5th. Driver: safari_get_text against a non-existent selector,
 *      same fixture URL each call.
 *
 *   2. THRASH: 4 identical safari_snapshot results → THRASH_DETECTED on the
 *      4th. Driver: a static fixture page that returns the same DOM each
 *      call (no timestamps, no per-request markers).
 *
 * Both are session-scoped (LoopDetector instance lives on the server). The
 * shared MCP client across the e2e suite means we must call
 * safari_health_check at test start to clear state from any earlier tests.
 *
 * Test pattern follows other 5A.* e2e tests: getSharedClient() + top-level
 * callTool helper. callTool THROWS on the protocol-error path the server
 * uses to surface SafariPilotError subclasses; we catch + assert on the
 * thrown message which carries the error code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('v0.1.35 Task 5 — anti-thrash controls (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let openTabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    // Reset session-scoped LoopDetector state from any prior tests.
    await callTool(client, 'safari_health_check', {}, nextId(), 15_000);
  }, 60_000);

  afterAll(async () => {
    if (openTabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: openTabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('returns LOOP_DETECTED after 5 identical (tool, key-args) calls', async () => {
    // Reset so prior subtests don't pollute the rolling window.
    await callTool(client, 'safari_health_check', {}, nextId(), 15_000);

    const target = `http://127.0.0.1:${fixture.hostPort}/bench-smoke?sp_tantithrash_loop=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    openTabUrl = newTab['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1000));

    let lastError: unknown = null;
    // 6 calls so call #5 (1-indexed) is the trigger and call #6 surfaces
    // the error if the detector kept tripping post-clear.
    for (let i = 0; i < 6; i++) {
      try {
        await callTool(
          client,
          'safari_get_text',
          { tabUrl: openTabUrl, selector: '#nope-anti-thrash-marker' },
          nextId(),
          15_000,
        );
      } catch (e) {
        lastError = e;
      }
    }
    const errStr = lastError instanceof Error ? lastError.message : JSON.stringify(lastError);
    // SafariPilotError.message is human-readable ("Loop detected: ...").
    // The error_code (LOOP_DETECTED) is on the thrown class but the MCP SDK
    // surfaces only the message. Match the prefix that uniquely identifies
    // a LoopDetectedError vs any other thrown SafariPilotError.
    expect(errStr, `expected loop-detected error, got: ${errStr}`).toMatch(/Loop detected/i);
  }, 120_000);

  it('returns THRASH_DETECTED after 4 identical snapshot results', async () => {
    // Reset detector + close prior tab so THRASH test has a clean window.
    await callTool(client, 'safari_health_check', {}, nextId(), 15_000);
    if (openTabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: openTabUrl }, nextId()); } catch { /* best-effort */ }
      openTabUrl = null;
    }

    // /bench-smoke returns the same static HTML every request.
    const target = `http://127.0.0.1:${fixture.hostPort}/bench-smoke?sp_tantithrash_thrash=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    openTabUrl = newTab['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1000));

    // Capture the FIRST error (THRASH should fire on the 4th identical
    // snapshot). Don't keep iterating — subsequent calls would also trip
    // the LoopDetector since each safari_snapshot has identical key-args,
    // and the LAST error would be LOOP_DETECTED instead of THRASH_DETECTED.
    let firstError: unknown = null;
    for (let i = 0; i < 5; i++) {
      try {
        await callTool(
          client,
          'safari_snapshot',
          { tabUrl: openTabUrl, format: 'yaml' },
          nextId(),
          20_000,
        );
      } catch (e) {
        if (firstError === null) firstError = e;
        break;
      }
    }
    const errStr = firstError instanceof Error ? firstError.message : JSON.stringify(firstError);
    expect(errStr, `expected thrash-detected error, got: ${errStr}`).toMatch(/Thrash detected/i);
  }, 120_000);
});
