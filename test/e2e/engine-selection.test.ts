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
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Engine Selection', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;
  const report = new E2EReportCollector('engine-selection');

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    report.setExtensionConnected(true);

    const newTabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=engine-selection' }, nextId++, 20_000);
    agentTabUrl = newTabResult['tabUrl'] as string | undefined;

    await new Promise((r) => setTimeout(r, 3000));

    nextId = await ensureExtensionAwake(client, agentTabUrl!, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      report.writeReport();
      if (agentTabUrl && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  // ── Engine metadata is present ────────────────────────────────────────────

  it('every tool response includes _meta with engine field', async () => {
    const tabUrl = agentTabUrl!;
    const { meta } = await rawCallTool(client, 'safari_get_text', { tabUrl }, nextId++, 60_000);
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
    expect(['extension', 'daemon', 'applescript']).toContain(meta!['engine']);
  }, 120_000);

  it('_meta includes degraded and latencyMs fields', async () => {
    const tabUrl = agentTabUrl!;
    const { meta } = await rawCallTool(client, 'safari_get_text', { tabUrl }, nextId++, 60_000);
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta).toBeDefined();
    expect(typeof meta!['degraded']).toBe('boolean');
    expect(typeof meta!['latencyMs']).toBe('number');
    expect(meta!['latencyMs'] as number).toBeGreaterThanOrEqual(0);
  }, 120_000);

  // ── Extension-required tools: engine routing ──────────────────────────────

  it('tool with requiresShadowDom: selects extension engine', async () => {
    const tabUrl = agentTabUrl!;

    // safari_query_shadow requires { requiresShadowDom: true } — only extension can handle it.
    // With nonexistent host, the tool errors — but the ERROR proves extension ran
    // (AppleScript would return EngineUnavailableError, not "Shadow host not found").
    const resp = await client.send(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'safari_query_shadow', arguments: { tabUrl, hostSelector: 'nonexistent', shadowSelector: 'button' } } },
      60_000,
    );

    if (resp['error']) {
      const errMsg = ((resp['error'] as Record<string, unknown>)['message'] as string).toLowerCase();
      expect(errMsg).toContain('shadow host not found');
      expect(errMsg).not.toContain('engine unavailable');
    } else {
      const result = resp['result'] as Record<string, unknown>;
      const meta = result['_meta'] as Record<string, unknown>;
      expect(meta?.['engine']).toBe('extension');
    }
  }, 120_000);

  // ── Non-extension tools prefer higher tiers ───────────────────────────────

  it('tool with no special requirements uses best available engine (not applescript)', async () => {
    const tabUrl = agentTabUrl!;

    // safari_get_text has requirements: {} — selectEngine picks extension > daemon > applescript
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_get_text',
      { tabUrl },
      'extension',
      nextId++,
      60_000,
    );
    report.recordCall('safari_get_text', { tabUrl }, meta, !!payload['text']);

    expect(payload['text']).toBeDefined();
    expect((payload['text'] as string)).toContain('Example Domain');

    expect(meta!['engine']).toBe('extension');
    expect(meta!['engine']).not.toBe('applescript');
  }, 120_000);

  it('safari_evaluate uses best available engine', async () => {
    const tabUrl = agentTabUrl!;

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.title' },
      nextId++,
      60_000,
    );
    report.recordCall('safari_evaluate', { tabUrl, script: 'return document.title' }, meta, !!payload['value']);

    expect(payload['value']).toBeDefined();
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBe('extension');
  }, 120_000);

  // ── Engine field is NEVER empty or invalid ────────────────────────────────

  it('engine field is a valid engine name across multiple tools', async () => {
    const tabUrl = agentTabUrl!;
    const validEngines = ['extension', 'daemon', 'applescript'];

    const tools = [
      { name: 'safari_health_check', args: {} },
      { name: 'safari_list_tabs', args: {} },
      { name: 'safari_get_text', args: { tabUrl } },
    ];

    for (const { name, args } of tools) {
      const { meta } = await rawCallTool(client, name, args, nextId++, 60_000);
      report.recordCall(name, args, meta, true);
      expect(meta).toBeDefined();
      expect(meta!['engine']).toBeDefined();
      expect(validEngines).toContain(meta!['engine']);
      expect(typeof meta!['engine']).toBe('string');
      expect((meta!['engine'] as string).length).toBeGreaterThan(0);
    }
  }, 120_000);

  // ── Consistent engine across repeated calls ───────────────────────────────

  it('same tool with same requirements selects the same engine consistently', async () => {
    const tabUrl = agentTabUrl!;

    for (let i = 0; i < 3; i++) {
      const { meta } = await callToolExpectingEngine(
        client,
        'safari_get_text',
        { tabUrl },
        'extension',
        nextId++,
        60_000,
      );
      report.recordCall('safari_get_text', { tabUrl }, meta, true);
    }
  }, 120_000);

  // ── __safariPilot namespace is present via extension ──────────────────────

  it('__safariPilot namespace is available via extension', async () => {
    const tabUrl = agentTabUrl!;

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return typeof window.__safariPilot' },
      nextId++,
      60_000,
    );
    report.recordCall('safari_evaluate', { tabUrl, script: 'return typeof window.__safariPilot' }, meta, true);

    expect(meta).toBeDefined();
    expect(meta!['engine']).toBe('extension');
    // __safariPilot is injected by the content script — 'object' or 'function', not 'undefined'
    expect(payload['value']).not.toBe('undefined');
  }, 120_000);

  // ── Prefers extension over lower-tier engines ─────────────────────────────

  it('prefers extension over daemon and applescript for general tools', async () => {
    const tabUrl = agentTabUrl!;

    const { meta } = await callToolExpectingEngine(
      client,
      'safari_get_text',
      { tabUrl },
      'extension',
      nextId++,
      60_000,
    );
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta!['engine']).toBe('extension');
  }, 120_000);
});
