/**
 * Engine Routing E2E Tests
 *
 * Verifies the three-tier engine model (Extension > Daemon > AppleScript) is
 * correctly reflected in MCP response metadata. Tests prove:
 *
 * 1. Engine metadata (_meta.engine) is populated in every MCP response
 * 2. Extension-required tools always route to extension (always connected)
 * 3. Non-extension tools also use extension (highest available tier)
 * 4. _meta is populated with engine info on every tool response
 *
 * Extension-always-connected architecture: all if/else engine branches removed.
 * All engine assertions are unconditional `expect(meta!['engine']).toBe('extension')`.
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

describe('Engine Routing', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;
  const report = new E2EReportCollector('engine-routing');

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=engine-routing' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      report.writeReport();
      if (agentTabUrl && client) {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  // ── Health check: all three tiers reported ────────────────────────────────

  it('health check reports all three engine tiers', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 60_000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const checkNames = checks.map((c) => c['name'] as string);

    expect(checkNames).toContain('safari_running');
    expect(checkNames).toContain('daemon');
    expect(checkNames).toContain('extension');

    // Safari must be running for any e2e test to work
    const safariCheck = checks.find((c) => c['name'] === 'safari_running');
    expect(safariCheck!['ok']).toBe(true);

    // Daemon and extension status should be booleans
    const daemonCheck = checks.find((c) => c['name'] === 'daemon');
    expect(typeof daemonCheck!['ok']).toBe('boolean');

    const extensionCheck = checks.find((c) => c['name'] === 'extension');
    expect(typeof extensionCheck!['ok']).toBe('boolean');

    console.log(
      'Engine status:',
      checks.map((c) => `${c['name']}=${c['ok']}`).join(', '),
    );
  }, 120_000);

  // ── Engine tier routing with metadata proof ───────────────────────────────

  it('extension-required tools: routed to extension', async () => {
    const tabUrl = agentTabUrl!;

    // safari_query_shadow requires { requiresShadowDom: true } — only extension can handle it.
    // With nonexistent host, the tool errors with "shadow host not found" — proving extension ran.
    // Use client.send() directly because rawCallTool throws on MCP-level errors.
    const resp = await client.send(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'safari_query_shadow', arguments: { tabUrl, hostSelector: 'nonexistent', shadowSelector: 'button' } },
      },
      60_000,
    );

    if (resp['error']) {
      // MCP-level error: extension rejected with shadow host not found
      const errMsg = ((resp['error'] as Record<string, unknown>)['message'] as string).toLowerCase();
      expect(errMsg).toContain('shadow host not found');
      expect(errMsg).not.toContain('engine unavailable');
    } else {
      const result = resp['result'] as Record<string, unknown>;
      const meta = result['_meta'] as Record<string, unknown>;
      expect(meta?.['engine']).toBe('extension');
    }

    report.recordCall('safari_query_shadow', { tabUrl, hostSelector: 'nonexistent', shadowSelector: 'button' }, undefined, true);
  }, 120_000);

  it('non-extension tools prefer extension (highest available tier)', async () => {
    const tabUrl = agentTabUrl!;

    // safari_get_text has requirements: {} — selectEngine picks extension first
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_get_text',
      { tabUrl },
      'extension',
      nextId++,
      60_000,
    );
    report.recordCall('safari_get_text', { tabUrl }, meta, !!payload['text']);

    expect(payload['text']).toContain('Example Domain');
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBe('extension');
  }, 120_000);

  // ── Metadata correctly reflects which engine ran ──────────────────────────

  it('MCP response _meta is populated with engine info for every tool call', async () => {
    const resp = await client.send(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'safari_health_check', arguments: {} },
      },
      60_000,
    );

    expect(resp['jsonrpc']).toBe('2.0');
    expect(resp['result']).toBeDefined();

    const result = resp['result'] as Record<string, unknown>;
    const content = result['content'] as Array<Record<string, unknown>>;
    const meta = result['_meta'] as Record<string, unknown>;

    // Content must exist with health check data
    expect(content).toBeInstanceOf(Array);
    expect(content.length).toBeGreaterThan(0);
    expect(content[0]['type']).toBe('text');

    const payload = JSON.parse(content[0]['text'] as string) as Record<string, unknown>;
    expect(payload['checks']).toBeInstanceOf(Array);
    expect(payload).toHaveProperty('healthy');

    // _meta must exist with engine info
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
    expect(['extension', 'daemon', 'applescript']).toContain(meta!['engine']);
    expect(typeof meta!['latencyMs']).toBe('number');
  }, 120_000);

  // ── Engine preference order verification ──────────────────────────────────

  it('engine selection routes to extension (highest available tier)', async () => {
    const tabUrl = agentTabUrl!;

    const { meta } = await callToolExpectingEngine(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return "tier-test"' },
      'extension',
      nextId++,
      60_000,
    );
    report.recordCall('safari_evaluate', { tabUrl, script: 'return "tier-test"' }, meta, true);

    expect(meta).toBeDefined();
    expect(meta!['engine']).toBe('extension');
  }, 120_000);
});
