/**
 * Phase 5A · 5A.1 / Phase 0 — Architecture spike (GATING).
 *
 * Verifies the two assumptions Approach 3 depends on:
 *   1. content-isolated.js can fetch http://127.0.0.1:19475/health
 *   2. File objects survive ISOLATED→MAIN structured-clone via window.postMessage
 *      with bytes intact.
 *
 * If either FAILS against the v0.1.22 release-mode build, ABORT 5A.1: design
 * re-opens, no further v0.1.22 work claims green, file_upload feature is
 * unshipped pending architecture re-design (candidate alt: bytes via
 * fragmented postMessage to MAIN, OR move File construction to MAIN).
 *
 * RUN ORDER: this test file MUST run BEFORE any other 5A.1 e2e (5A1-file-upload.test.ts).
 * Vitest's alphabetical default ensures "phase0-spike" sorts before "file-upload".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('5A.1 / Phase 0 — architecture spike (GATING)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let baseHttpUrl = '';

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    baseHttpUrl = `http://127.0.0.1:${fixture.hostPort}`;
  }, 30_000);

  afterAll(async () => {
    if (fixture) await fixture.close();
  }, 30_000);

  it('content-isolated.js can fetch http://127.0.0.1:19475/health (Assumption 1)', async () => {
    // The probe sentinel exercises browser.fetch() FROM content-isolated.js
    // FROM a tab on a regular http page. The manifest's connect-src
    // explicitly lists 127.0.0.1:19475 but governs extension pages —
    // content scripts run under a hybrid CSP. This test is the empirical
    // truth of whether Safari extends connect-src to content scripts.
    const target = `${baseHttpUrl}/cookie-fixture?sp_t5A1_a=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = tab['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await callTool(client, 'safari_evaluate', {
        tabUrl,
        script: '__SP_FILE_UPLOAD_PROBE_TEST__',
        timeout: 10_000,
      }, nextId(), 30_000);
      const probeResults = JSON.parse(r['value'] as string) as {
        fetchOk: boolean;
        fetchStatus?: number;
        structuredCloneOk: boolean;
        errors: string[];
        mainResponse: { ok: boolean; bytesMatchExpected?: boolean; error?: string };
      };
      expect(
        probeResults.fetchOk,
        `Phase 0 ASSUMPTION 1 FAILED: content-isolated.js cannot fetch the daemon. errors: ${JSON.stringify(probeResults.errors)}. Architecture must re-open.`,
      ).toBe(true);
      expect(probeResults.fetchStatus).toBe(200);
    } finally {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
  }, 60_000);

  it('File objects survive ISOLATED→MAIN structured-clone with bytes intact (Assumption 2)', async () => {
    // Builds a File("SPFUBYTE", "probe.bin") in content-isolated, postMessages
    // to MAIN. MAIN reads bytes via arrayBuffer() and verifies the 8-byte
    // signature matches. If MAIN sees a stripped Blob (size=0) or non-File
    // primitive, this fails.
    const target = `${baseHttpUrl}/cookie-fixture?sp_t5A1_b=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = tab['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await callTool(client, 'safari_evaluate', {
        tabUrl,
        script: '__SP_FILE_UPLOAD_PROBE_TEST__',
        timeout: 10_000,
      }, nextId(), 30_000);
      const probeResults = JSON.parse(r['value'] as string) as {
        structuredCloneOk: boolean;
        mainResponse: { ok: boolean; name?: string; size?: number; type?: string; bytesMatchExpected?: boolean; error?: string };
      };
      expect(
        probeResults.structuredCloneOk,
        `Phase 0 ASSUMPTION 2 FAILED: ${JSON.stringify(probeResults.mainResponse)}. Architecture must re-open.`,
      ).toBe(true);
      expect(probeResults.mainResponse.name).toBe('probe.bin');
      expect(probeResults.mainResponse.size).toBe(8);
      expect(probeResults.mainResponse.type).toBe('application/octet-stream');
      expect(probeResults.mainResponse.bytesMatchExpected).toBe(true);
    } finally {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
  }, 60_000);
});
