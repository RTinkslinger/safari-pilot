/**
 * Engine Selection E2E Tests
 *
 * Verifies that the three-tier engine model (Extension > Daemon > AppleScript)
 * actually selects engines correctly and reports the selection in MCP response
 * metadata via _meta.engine.
 *
 * Tests use rawCallTool to inspect _meta.engine on every response, proving
 * the engine selection pipeline runs and the metadata flows through MCP.
 *
 * THE LITMUS TEST: If engine selection always returned 'applescript',
 * these tests MUST fail — they verify non-applescript engines are selected
 * when higher-tier engines are available.
 *
 * Zero mocks. Zero source imports. Real process over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { E2EReportCollector } from '../helpers/e2e-report.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Engine Selection', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;
  let extensionConnected: boolean;
  let daemonAvailable: boolean;
  const report = new E2EReportCollector('engine-selection');

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Probe engine availability
    const health = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = health['checks'] as Array<Record<string, unknown>>;
    extensionConnected = checks.find((c) => c['name'] === 'extension')?.['ok'] === true;
    daemonAvailable = checks.find((c) => c['name'] === 'daemon')?.['ok'] === true;
    report.setExtensionConnected(extensionConnected);

    // Open a tab
    const newTabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com' }, nextId++, 20000);
    agentTabUrl = newTabResult['tabUrl'] as string | undefined;

    // Wait for page load
    await new Promise((r) => setTimeout(r, 3000));
  }, 45000);

  afterAll(async () => {
    report.writeReport();
    if (agentTabUrl && client) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10000);
      } catch { /* tab may already be closed */ }
    }
    if (client) await client.close();
  });

  // ── Engine metadata is present ────────────────────────────────────────────

  it('every tool response includes _meta with engine field', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const { meta } = await rawCallTool(client, 'safari_get_text', { tabUrl }, nextId++, 20000);
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
    expect(['extension', 'daemon', 'applescript']).toContain(meta!['engine']);
  }, 25000);

  it('_meta includes degraded and latencyMs fields', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const { meta } = await rawCallTool(client, 'safari_get_text', { tabUrl }, nextId++, 20000);
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta).toBeDefined();
    expect(typeof meta!['degraded']).toBe('boolean');
    expect(typeof meta!['latencyMs']).toBe('number');
    expect(meta!['latencyMs'] as number).toBeGreaterThanOrEqual(0);
  }, 25000);

  // ── Extension-required tools: engine routing ──────────────────────────────

  it('tool with requiresShadowDom: selects extension when available, rejects when not', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    // safari_query_shadow has requirements: { requiresShadowDom: true }
    // Only the extension engine has shadowDom: true in ENGINE_CAPS
    const { payload, meta } = await rawCallTool(
      client,
      'safari_query_shadow',
      { tabUrl, hostSelector: 'nonexistent', shadowSelector: 'button' },
      nextId++,
      20000,
    );
    const shadowOk = !payload['_rawText']?.toString().includes('Error');
    report.recordCall('safari_query_shadow', { tabUrl, hostSelector: 'nonexistent', shadowSelector: 'button' }, meta, shadowOk, shadowOk ? undefined : payload['_rawText'] as string);

    expect(meta).toBeDefined();

    if (extensionConnected) {
      // Extension available: engine MUST be 'extension'
      expect(meta!['engine']).toBe('extension');
    } else {
      // Extension unavailable: tool MUST be rejected with degraded=true,
      // NOT silently handled by applescript
      expect(meta!['degraded']).toBe(true);
      // Verify error mentions extension requirement
      if (payload['_rawText']) {
        expect((payload['_rawText'] as string).toLowerCase()).toMatch(/extension|unavailable/);
      }
      // Engine should NOT claim it used 'extension' when it's not available
      expect(meta!['engine']).not.toBe('extension');
    }
  }, 25000);

  // ── Non-extension tools prefer higher tiers ───────────────────────────────

  it('tool with no special requirements uses best available engine (not applescript)', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    // safari_get_text has requirements: {} — selectEngine picks extension > daemon > applescript
    const { payload, meta } = await rawCallTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );
    report.recordCall('safari_get_text', { tabUrl }, meta, !!payload['text']);

    expect(payload['text']).toBeDefined();
    expect((payload['text'] as string)).toContain('Example Domain');

    expect(meta).toBeDefined();
    if (extensionConnected) {
      expect(meta!['engine']).toBe('extension');
    } else if (daemonAvailable) {
      expect(meta!['engine']).toBe('daemon');
    }
    // Key: it should NOT be 'applescript' when higher-tier engines are available
    if (extensionConnected || daemonAvailable) {
      expect(meta!['engine']).not.toBe('applescript');
    }
  }, 25000);

  it('safari_evaluate uses best available engine', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.title' },
      nextId++,
      20000,
    );
    report.recordCall('safari_evaluate', { tabUrl, script: 'return document.title' }, meta, !!payload['value']);

    expect(payload['value']).toBeDefined();
    expect(meta).toBeDefined();

    if (extensionConnected) {
      expect(meta!['engine']).toBe('extension');
    } else if (daemonAvailable) {
      expect(meta!['engine']).toBe('daemon');
    }
  }, 25000);

  // ── Engine field is NEVER empty or invalid ────────────────────────────────

  it('engine field is a valid engine name across multiple tools', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const validEngines = ['extension', 'daemon', 'applescript'];

    const tools = [
      { name: 'safari_health_check', args: {} },
      { name: 'safari_list_tabs', args: {} },
      { name: 'safari_get_text', args: { tabUrl } },
    ];

    for (const { name, args } of tools) {
      const { meta } = await rawCallTool(client, name, args, nextId++, 20000);
      report.recordCall(name, args, meta, true);
      expect(meta).toBeDefined();
      expect(meta!['engine']).toBeDefined();
      expect(validEngines).toContain(meta!['engine']);
      expect(typeof meta!['engine']).toBe('string');
      expect((meta!['engine'] as string).length).toBeGreaterThan(0);
    }
  }, 45000);

  // ── Consistent engine across repeated calls ───────────────────────────────

  it('same tool with same requirements selects the same engine consistently', async () => {
    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    const results = [];
    for (let i = 0; i < 3; i++) {
      const { meta } = await rawCallTool(
        client,
        'safari_get_text',
        { tabUrl },
        nextId++,
        20000,
      );
      report.recordCall('safari_get_text', { tabUrl }, meta, true);
      results.push(meta!['engine']);
    }

    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  }, 45000);
});
