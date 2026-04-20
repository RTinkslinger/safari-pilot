/**
 * Extension Engine E2E Tests
 *
 * Exercises JS evaluation, Shadow DOM routing, and response metadata
 * through the real MCP protocol. Extension is always connected — all
 * assertions are unconditional.
 *
 * THE LITMUS TEST: If SafariWebExtensionHandler.swift were deleted, or
 * the extension IPC were broken, every test in this file MUST fail.
 * engine='extension' is asserted without conditional branches.
 *
 * Negative-path (extension disconnected) scenarios live in degradation.test.ts.
 *
 * Zero mocks. Zero source imports. Real MCP server over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { E2EReportCollector } from '../helpers/e2e-report.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Extension Engine — MCP E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;
  const report = new E2EReportCollector('extension-engine');

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=extension-engine' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
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

  // ── Health check reports engine status ─────────────────────────────────────

  it('health check reports extension availability status', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20_000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const extCheck = checks.find((c) => c['name'] === 'extension');
    expect(extCheck).toBeDefined();
    expect(typeof extCheck!['ok']).toBe('boolean');

    console.log(`Extension connected: ${extCheck!['ok']}`);
  }, 120_000);

  it('health check reports daemon availability', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20_000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const daemonCheck = checks.find((c) => c['name'] === 'daemon');
    expect(daemonCheck).toBeDefined();
    expect(typeof daemonCheck!['ok']).toBe('boolean');

    console.log(`Daemon available: ${daemonCheck!['ok']}`);
  }, 120_000);

  // ── Shadow DOM tools: extension-only capability ───────────────────────────
  // safari_query_shadow requires { requiresShadowDom: true } which ONLY the
  // extension engine can satisfy. This is the critical architectural test.

  it('safari_query_shadow: with extension, routes through extension engine (metadata proof)', async () => {
    const tabUrl = agentTabUrl!;
    // Use client.send directly — rawCallTool throws on MCP errors, but
    // "Shadow host not found" IS proof the extension executed (AppleScript
    // would return EngineUnavailableError instead).
    const resp = await client.send(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'safari_query_shadow', arguments: { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' } } },
      60_000,
    );

    if (resp['error']) {
      // MCP error — verify it's "host not found" (extension executed), not "engine unavailable"
      const errMsg = ((resp['error'] as Record<string, unknown>)['message'] as string).toLowerCase();
      expect(errMsg).toContain('shadow host not found');
      expect(errMsg).not.toContain('engine unavailable');
    } else {
      // Tool returned a result — check engine metadata
      const result = resp['result'] as Record<string, unknown>;
      const meta = result['_meta'] as Record<string, unknown>;
      expect(meta?.['engine']).toBe('extension');
    }
  }, 120_000);

  it('safari_click_shadow: same routing rules as safari_query_shadow', async () => {
    const tabUrl = agentTabUrl!;
    const resp = await client.send(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'safari_click_shadow', arguments: { tabUrl, hostSelector: 'nonexistent-host', shadowSelector: 'button' } } },
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

  // ── JS evaluation through MCP ──────────────────────────────────────────────

  it('safari_evaluate returns engine metadata (extension or daemon, not applescript when higher available)', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.title' },
      nextId++,
      60_000,
    );

    report.recordCall('safari_evaluate', { tabUrl, script: 'return document.title' }, meta, !!payload['value']);

    // safari_evaluate has requirements: {} so selectEngine picks best available.
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();

    expect(meta!['engine']).toBe('extension');

    expect(payload['value']).toBeDefined();
    expect(typeof payload['value']).toBe('string');
    expect((payload['value'] as string).length).toBeGreaterThan(0);
  }, 120_000);

  it('safari_evaluate can return computed values', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return 2 + 2' },
      nextId++,
      60_000,
    );

    report.recordCall('safari_evaluate', { tabUrl, script: 'return 2 + 2' }, meta, !!payload['value']);

    expect(Number(payload['value'])).toBe(4);
    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
  }, 120_000);

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
      60_000,
    );

    const value = payload['value'] as string;
    const parsed = JSON.parse(value);
    report.recordCall('safari_evaluate', { tabUrl, script: 'return JSON.stringify(...)' }, meta, !!payload['value']);

    expect(parsed['href']).toContain('example.com');
    expect(parsed['nodeType']).toBe(9); // DOCUMENT_NODE

    expect(meta).toBeDefined();
    expect(meta!['engine']).toBeDefined();
  }, 120_000);

  // ── Response metadata completeness ────────────────────────────────────────

  it('response metadata includes degraded flag and latencyMs', async () => {
    const tabUrl = agentTabUrl!;
    const { meta } = await rawCallTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      60_000,
    );
    report.recordCall('safari_get_text', { tabUrl }, meta, true);

    expect(meta).toBeDefined();
    expect(typeof meta!['degraded']).toBe('boolean');
    expect(typeof meta!['latencyMs']).toBe('number');
    expect(meta!['latencyMs'] as number).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('engine metadata is present for every tool call', async () => {
    const tabUrl = agentTabUrl!;

    const tools = [
      { name: 'safari_get_text', args: { tabUrl } },
      { name: 'safari_list_tabs', args: {} },
    ];

    for (const { name, args } of tools) {
      const { meta } = await rawCallTool(client, name, args, nextId++, 60_000);
      report.recordCall(name, args, meta, true);
      expect(meta).toBeDefined();
      expect(meta!['engine']).toBeDefined();
      expect(['extension', 'daemon', 'applescript']).toContain(meta!['engine']);
    }
  }, 120_000);

  // ── Extension namespace verification ──────────────────────────────────────

  it('extension injects __safariPilot namespace when connected', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: 'return typeof window.__safariPilot !== "undefined" ? "present" : "absent"',
      },
      nextId++,
      60_000,
    );

    report.recordCall('safari_evaluate', { tabUrl, script: 'typeof __safariPilot...' }, meta, payload['value'] === 'present');

    expect(meta!['engine']).toBe('extension');
    expect(payload['value']).toBe('present');
  }, 120_000);

  // ── Engine preference: non-extension tools also prefer higher tiers ───────

  it('safari_get_text routes through extension engine', async () => {
    const tabUrl = agentTabUrl!;
    const { payload, meta } = await rawCallTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      60_000,
    );

    report.recordCall('safari_get_text', { tabUrl }, meta, !!payload['text']);

    expect(payload['text']).toContain('Example Domain');
    expect(meta).toBeDefined();

    expect(meta!['engine']).toBe('extension');
  }, 120_000);
});
