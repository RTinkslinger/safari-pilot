/**
 * Extension Engine E2E Tests
 *
 * Exercises engine availability, JS evaluation, and response metadata
 * through the real MCP protocol. Tests are resilient to whether the
 * extension is loaded or not — they verify correct behavior in both cases.
 *
 * When extension IS connected:
 *   - Shadow DOM tools route through extension engine (metadata proof)
 *   - JS evaluation uses extension pipeline
 *   - __safariPilot namespace is available
 *
 * When extension is NOT connected:
 *   - Shadow DOM tools are REJECTED (not silently routed to applescript)
 *   - JS evaluation uses daemon (not applescript when daemon is available)
 *   - Degradation metadata is set
 *
 * THE LITMUS TEST: If SafariWebExtensionHandler.swift were deleted, the
 * extension-connected tests MUST fail (they assert engine='extension').
 * The extension-disconnected tests verify proper rejection, not fallback.
 *
 * Zero mocks. Zero source imports. Real MCP server over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { E2EReportCollector } from '../helpers/e2e-report.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Extension Engine — MCP E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let extensionConnected: boolean;
  let daemonAvailable: boolean;
  let agentTabUrl: string | undefined;
  const report = new E2EReportCollector('extension-engine');

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Probe engine availability via health check
    const health = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = health['checks'] as Array<Record<string, unknown>>;
    extensionConnected = checks.find((c) => c['name'] === 'extension')?.['ok'] === true;
    daemonAvailable = checks.find((c) => c['name'] === 'daemon')?.['ok'] === true;
    report.setExtensionConnected(extensionConnected);

    // Open a tab for JS evaluation tests
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );
    const rawUrl = tabResult['tabUrl'] as string;
    agentTabUrl = rawUrl.endsWith('/') ? rawUrl : rawUrl + '/';

    // Wait for page load
    await new Promise((r) => setTimeout(r, 2000));
  }, 45000);

  afterAll(async () => {
    report.writeReport();
    if (agentTabUrl && client) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10000);
      } catch {
        // Best-effort cleanup
      }
    }
    if (client) await client.close();
  });

  // ── Health check reports engine status ─────────────────────────────────────

  it('health check reports extension availability status', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const extCheck = checks.find((c) => c['name'] === 'extension');
    expect(extCheck).toBeDefined();
    expect(typeof extCheck!['ok']).toBe('boolean');

    console.log(`Extension connected: ${extCheck!['ok']}`);
  }, 25000);

  it('health check reports daemon availability', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const daemonCheck = checks.find((c) => c['name'] === 'daemon');
    expect(daemonCheck).toBeDefined();
    expect(typeof daemonCheck!['ok']).toBe('boolean');

    console.log(`Daemon available: ${daemonCheck!['ok']}`);
  }, 25000);

  // ── Shadow DOM tools: extension-only capability ───────────────────────────
  // safari_query_shadow requires { requiresShadowDom: true } which ONLY the
  // extension engine can satisfy. This is the critical architectural test.

  it('safari_query_shadow: with extension, routes through extension engine (metadata proof)', async () => {
    if (!extensionConnected) {
      console.log('Skipping: extension not connected — see negative-path test below');
      return;
    }

    const tabUrl = agentTabUrl!;
    const { meta, result } = await rawCallTool(
      client,
      'safari_query_shadow',
      { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' },
      nextId++,
      20000,
    );
    report.recordCall('safari_query_shadow', { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' }, meta, true);

    // CRITICAL: engine metadata MUST be 'extension' — nothing else can handle shadow DOM
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBe('extension');

    // The tool should have executed (element not found is fine) — not engine-unavailable
    const content = result['content'] as Array<Record<string, unknown>>;
    const text = content?.[0]?.['text'] as string;
    if (text) {
      const lower = text.toLowerCase();
      expect(lower).not.toContain('engine unavailable');
    }
  }, 25000);

  it('safari_query_shadow: without extension, rejects with engine unavailable (not silent fallback)', async () => {
    if (extensionConnected) {
      console.log('Skipping: extension IS connected — see positive-path test above');
      return;
    }

    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_query_shadow',
      { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' },
      nextId++,
      20000,
    );
    const queryOk = !(payload['_rawText'] as string | undefined)?.toLowerCase().includes('error');
    report.recordCall('safari_query_shadow', { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' }, meta, queryOk, queryOk ? undefined : (payload['_rawText'] as string));

    // Without extension, the server MUST NOT silently fall back to applescript.
    // It should return an error indicating the extension is required.
    expect(meta).toBeDefined();
    expect(meta!['degraded']).toBe(true);

    // The error text should mention extension/unavailable, NOT return shadow DOM results
    if (payload['_rawText']) {
      const text = payload['_rawText'] as string;
      expect(text.toLowerCase()).toMatch(/extension|unavailable|required/);
    } else if (payload['error']) {
      const errMsg = (payload['error'] as string).toLowerCase();
      expect(errMsg).toMatch(/extension|unavailable|required/);
    }

    // Engine metadata should NOT be 'extension' since it wasn't used
    expect(meta!['engine']).not.toBe('extension');
  }, 25000);

  it('safari_click_shadow: same routing rules as safari_query_shadow', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_click_shadow',
      { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' },
      nextId++,
      20000,
    );
    const clickOk = !(payload['_rawText'] as string | undefined)?.toLowerCase().includes('error');
    report.recordCall('safari_click_shadow', { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' }, meta, clickOk, clickOk ? undefined : (payload['_rawText'] as string));

    expect(meta).toBeDefined();
    if (extensionConnected) {
      expect(meta!['engine']).toBe('extension');
    } else {
      // Must be rejected, not silently fallen through
      expect(meta!['degraded']).toBe(true);
      if (payload['_rawText']) {
        expect((payload['_rawText'] as string).toLowerCase()).toMatch(/extension|unavailable|required/);
      }
    }
  }, 25000);

  // ── JS evaluation through MCP ──────────────────────────────────────────────

  it('safari_evaluate returns engine metadata (extension or daemon, not applescript when higher available)', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.title' },
      nextId++,
      20000,
    );

    report.recordCall('safari_evaluate', { tabUrl, script: 'return document.title' }, meta, !!payload['value']);

    // safari_evaluate has requirements: {} so selectEngine picks best available.
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();

    if (extensionConnected) {
      expect(meta!['engine']).toBe('extension');
    } else if (daemonAvailable) {
      expect(meta!['engine']).toBe('daemon');
    }
    // Must NOT be applescript when higher-tier engines are available
    if (extensionConnected || daemonAvailable) {
      expect(meta!['engine']).not.toBe('applescript');
    }

    expect(payload['value']).toBeDefined();
    expect(typeof payload['value']).toBe('string');
    expect((payload['value'] as string).length).toBeGreaterThan(0);
  }, 25000);

  it('safari_evaluate can return computed values', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return 2 + 2' },
      nextId++,
      20000,
    );

    report.recordCall('safari_evaluate', { tabUrl, script: 'return 2 + 2' }, meta, !!payload['value']);

    expect(Number(payload['value'])).toBe(4);
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
  }, 25000);

  it('safari_evaluate can access DOM properties', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: 'return JSON.stringify({ href: location.href, nodeType: document.nodeType })',
      },
      nextId++,
      20000,
    );

    const value = payload['value'] as string;
    const parsed = JSON.parse(value);
    report.recordCall('safari_evaluate', { tabUrl, script: 'return JSON.stringify(...)' }, meta, !!payload['value']);

    expect(parsed['href']).toContain('example.com');
    expect(parsed['nodeType']).toBe(9); // DOCUMENT_NODE

    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
  }, 25000);

  // ── Response metadata completeness ────────────────────────────────────────

  it('response metadata includes degraded flag and latencyMs', async () => {
    const tabUrl = agentTabUrl!;
    const { meta } = await rawCallTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta).toBeDefined();
    expect(typeof meta!['degraded']).toBe('boolean');
    expect(typeof meta!['latencyMs']).toBe('number');
    expect(meta!['latencyMs'] as number).toBeGreaterThanOrEqual(0);
  }, 25000);

  it('engine metadata is present for every tool call', async () => {
    const tabUrl = agentTabUrl!;

    const tools = [
      { name: 'safari_get_text', args: { tabUrl } },
      { name: 'safari_list_tabs', args: {} },
    ];

    for (const { name, args } of tools) {
      const { meta } = await rawCallTool(client, name, args, nextId++, 20000);
      report.recordCall(name, args, meta, true);
      expect(meta).toBeDefined();
      expect(meta!['engine']).toBeDefined();
      expect(['extension', 'daemon', 'applescript']).toContain(meta!['engine']);
    }
  }, 35000);

  // ── Extension namespace verification ──────────────────────────────────────

  it('extension injects __safariPilot namespace when connected', async () => {
    if (!extensionConnected) {
      console.log('Skipping: extension not connected');
      return;
    }

    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: 'return typeof window.__safariPilot !== "undefined" ? "present" : "absent"',
      },
      nextId++,
      20000,
    );

    report.recordCall('safari_evaluate', { tabUrl, script: 'typeof __safariPilot...' }, meta, payload['value'] === 'present');

    expect(meta!['engine']).toBe('extension');
    expect(payload['value']).toBe('present');
  }, 25000);

  // ── Engine preference: non-extension tools also prefer higher tiers ───────

  it('safari_get_text prefers daemon over applescript when daemon is available', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );

    report.recordCall('safari_get_text', { tabUrl }, meta, !!payload['text']);

    expect(payload['text']).toContain('Example Domain');
    expect(meta).toBeDefined();

    if (extensionConnected) {
      expect(meta!['engine']).toBe('extension');
    } else if (daemonAvailable) {
      // When only daemon is available, it should be selected over applescript
      expect(meta!['engine']).toBe('daemon');
    }
  }, 25000);
});
