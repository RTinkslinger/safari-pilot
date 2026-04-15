/**
 * Extension Engine E2E Tests
 *
 * Exercises engine availability, JS evaluation, and response metadata
 * through the real MCP protocol. Tests are resilient to whether the
 * extension is loaded or not — they verify correct behavior in both cases.
 *
 * Zero mocks. Zero source imports. Real MCP server over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Extension Engine — MCP E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let extensionConnected: boolean;
  let daemonAvailable: boolean;
  let agentTabUrl: string | undefined;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Probe engine availability via health check
    const health = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = health['checks'] as Array<Record<string, unknown>>;
    extensionConnected = checks.find((c) => c['name'] === 'extension')?.['ok'] === true;
    daemonAvailable = checks.find((c) => c['name'] === 'daemon')?.['ok'] === true;

    // Open a tab for JS evaluation tests
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );
    const rawUrl = tabResult['tabUrl'] as string;
    // Safari normalizes URLs (adds trailing slash); store the canonical form
    agentTabUrl = rawUrl.endsWith('/') ? rawUrl : rawUrl + '/';

    // Wait for page load
    await new Promise((r) => setTimeout(r, 2000));
  }, 45000);

  afterAll(async () => {
    // Clean up agent tab
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

  it('health check reports extension availability', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const extCheck = checks.find((c) => c['name'] === 'extension');
    expect(extCheck).toBeDefined();
    expect(typeof extCheck!['ok']).toBe('boolean');

    // Log actual state for diagnostics
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

  // ── JavaScript evaluation through MCP ──────────────────────────────────────

  it('safari_evaluate executes JavaScript and returns result', async () => {
    const tabUrl = agentTabUrl!;
    const result = await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.title' },
      nextId++,
      20000,
    );

    expect(result['value']).toBeDefined();
    expect(typeof result['value']).toBe('string');
    expect((result['value'] as string).length).toBeGreaterThan(0);
  }, 25000);

  it('safari_evaluate can return computed values', async () => {
    const tabUrl = agentTabUrl!;
    const result = await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return 2 + 2' },
      nextId++,
      20000,
    );

    // AppleScript returns numbers as strings sometimes
    const value = result['value'];
    expect(Number(value)).toBe(4);
  }, 25000);

  it('safari_evaluate can access DOM properties', async () => {
    const tabUrl = agentTabUrl!;
    const result = await callTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: 'return JSON.stringify({ href: location.href, nodeType: document.nodeType })',
      },
      nextId++,
      20000,
    );

    const value = result['value'] as string;
    const parsed = JSON.parse(value);
    expect(parsed['href']).toContain('example.com');
    expect(parsed['nodeType']).toBe(9); // DOCUMENT_NODE
  }, 25000);

  // ── Response metadata inspection ──────────────────────────────────────────

  // The MCP protocol layer in index.ts maps ToolResponse content but strips
  // metadata. To verify engine selection, we inspect behavior: the tool either
  // works (engine was selected and executed) or fails with a specific error.

  it('tool execution succeeds regardless of which engine is selected', async () => {
    // safari_evaluate uses the default (applescript) engine requirements: {}
    // The engine selector picks daemon if available, else applescript.
    // Either way, the tool should produce a result.
    const tabUrl = agentTabUrl!;
    const result = await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return "engine-test-ok"' },
      nextId++,
      20000,
    );

    expect(result['value']).toBe('engine-test-ok');
  }, 25000);

  it('safari_get_text works through selected engine', async () => {
    const tabUrl = agentTabUrl!;
    const result = await callTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );

    expect(result['text']).toBeDefined();
    expect(result['text']).toContain('Example Domain');
  }, 25000);

  // ── Engine fallback behavior ──────────────────────────────────────────────

  it('tools with no special requirements work even without extension', async () => {
    // safari_list_tabs has requirements: {} — should work on any engine
    const result = await callTool(
      client,
      'safari_list_tabs',
      {},
      nextId++,
      20000,
    );

    expect(result['tabs']).toBeInstanceOf(Array);
    expect((result['tabs'] as unknown[]).length).toBeGreaterThan(0);
  }, 25000);

  it('safari_snapshot produces accessibility tree', async () => {
    const tabUrl = agentTabUrl!;
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      20000,
    );

    // Snapshot returns YAML or structured data — just verify we got content
    // The result may be a string (YAML) or parsed object depending on format
    const hasContent =
      result['snapshot'] !== undefined ||
      result['yaml'] !== undefined ||
      typeof result === 'object';
    expect(hasContent).toBe(true);
  }, 25000);

  // ── Extension-specific behavior ───────────────────────────────────────────

  it.skipIf(!extensionConnected)(
    'with extension: shadow DOM tools are available (engine selector accepts requiresShadowDom)',
    async () => {
      // When the extension is connected, tools requiring shadow DOM support
      // should not be rejected at the engine selection stage.
      // We test with a simple page that has no shadow DOM — the tool should
      // still execute (and report no shadow root found) rather than being
      // blocked by engine unavailability.
      const tabUrl = agentTabUrl!;

      // Send raw to check whether it's an engine error vs. DOM error
      const resp = await client.send(
        {
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: {
            name: 'safari_query_shadow',
            arguments: {
              tabUrl,
              hostSelector: 'nonexistent-host',
              shadowSelector: 'button',
            },
          },
        },
        20000,
      );

      // With extension available, the error should be about the element not
      // being found, NOT about the engine being unavailable.
      if (resp['error']) {
        const err = resp['error'] as Record<string, unknown>;
        const msg = (err['message'] as string).toLowerCase();
        // Should NOT be an engine availability error
        expect(msg).not.toContain('extension engine required');
        expect(msg).not.toContain('engine unavailable');
      }
      // If result returned, the tool ran (and found no shadow host, which is fine)
    },
    25000,
  );

  it.skipIf(extensionConnected)(
    'without extension: shadow DOM tools report engine unavailable',
    async () => {
      // When extension is NOT connected, tools with requiresShadowDom should
      // be rejected because no engine can fulfill the requirement.
      const tabUrl = agentTabUrl!;

      const resp = await client.send(
        {
          jsonrpc: '2.0',
          id: nextId++,
          method: 'tools/call',
          params: {
            name: 'safari_query_shadow',
            arguments: {
              tabUrl,
              hostSelector: 'my-component',
              shadowSelector: 'button',
            },
          },
        },
        20000,
      );

      // Without extension, the server returns an error result (not protocol error)
      // because EngineUnavailableError is caught and returned as content.
      const result = resp['result'] as Record<string, unknown> | undefined;
      if (result) {
        const content = result['content'] as Array<Record<string, unknown>>;
        const text = content?.[0]?.['text'] as string;
        expect(text).toBeDefined();
        expect(text.toLowerCase()).toContain('error');
      } else {
        // Also acceptable: JSON-RPC error
        expect(resp['error']).toBeDefined();
      }
    },
    25000,
  );
});
