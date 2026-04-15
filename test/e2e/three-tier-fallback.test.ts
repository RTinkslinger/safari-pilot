/**
 * Three-Tier Fallback E2E Tests
 *
 * Verifies the three-tier engine model (Extension > Daemon > AppleScript) is
 * correctly reflected in MCP response metadata. Tests prove:
 *
 * 1. Engine metadata (_meta.engine) is populated in every MCP response
 * 2. The engine selected matches the highest available tier
 * 3. Extension-required tools are rejected (not silently fallen through) when
 *    the extension is unavailable
 * 4. Non-extension tools prefer daemon over applescript when daemon is available
 *
 * Zero mocks. Zero source imports. Real process over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Three-Tier Fallback', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;
  let extensionConnected: boolean;
  let daemonAvailable: boolean;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Probe engine availability
    const health = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = health['checks'] as Array<Record<string, unknown>>;
    extensionConnected = checks.find((c) => c['name'] === 'extension')?.['ok'] === true;
    daemonAvailable = checks.find((c) => c['name'] === 'daemon')?.['ok'] === true;
  }, 30000);

  afterAll(async () => {
    if (agentTabUrl && client) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10000);
      } catch { /* tab may already be closed */ }
    }
    if (client) await client.close();
  });

  // ── Health check: all three tiers reported ────────────────────────────────

  it('health check reports all three engine tiers', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
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
  }, 25000);

  // ── Engine tier routing with metadata proof ───────────────────────────────

  it('extension-required tools: routed to extension or properly rejected', async () => {
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );

    expect(tabResult['tabUrl']).toBeDefined();
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 3000));

    const tabUrl = agentTabUrl.endsWith('/') ? agentTabUrl : agentTabUrl + '/';

    // safari_query_shadow requires extension (requiresShadowDom: true)
    const { payload: shadowPayload, meta: shadowMeta } = await rawCallTool(
      client,
      'safari_query_shadow',
      { tabUrl, hostSelector: 'nonexistent', shadowSelector: 'button' },
      nextId++,
      20000,
    );

    expect(shadowMeta).toBeDefined();

    if (extensionConnected) {
      // Extension available: must route through extension
      expect(shadowMeta!['engine']).toBe('extension');
    } else {
      // Extension unavailable: must reject, not silently fall through to applescript
      expect(shadowMeta!['degraded']).toBe(true);
      if (shadowPayload['_rawText']) {
        expect((shadowPayload['_rawText'] as string).toLowerCase()).toMatch(/extension|unavailable/);
      }
    }
  }, 45000);

  it('non-extension tools prefer highest available tier', async () => {
    if (!agentTabUrl) {
      const tabResult = await callTool(
        client,
        'safari_new_tab',
        { url: 'https://example.com' },
        nextId++,
        20000,
      );
      agentTabUrl = tabResult['tabUrl'] as string;
      await new Promise((r) => setTimeout(r, 2000));
    }

    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    // safari_get_text has requirements: {} — selectEngine follows priority chain
    const { payload, meta } = await rawCallTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );

    expect(payload['text']).toContain('Example Domain');
    expect(meta).toBeDefined();

    if (extensionConnected) {
      expect(meta!['engine']).toBe('extension');
    } else if (daemonAvailable) {
      expect(meta!['engine']).toBe('daemon');
    } else {
      expect(meta!['engine']).toBe('applescript');
    }
  }, 35000);

  // ── Metadata correctly reflects which engine ran ──────────────────────────

  it('MCP response _meta is populated with engine info for every tool call', async () => {
    const resp = await client.send(
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: 'safari_health_check', arguments: {} },
      },
      20000,
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
  }, 25000);

  // ── Engine preference order verification ──────────────────────────────────

  it('engine selection follows Extension > Daemon > AppleScript priority', async () => {
    if (!agentTabUrl) {
      const tabResult = await callTool(
        client,
        'safari_new_tab',
        { url: 'https://example.com' },
        nextId++,
        20000,
      );
      agentTabUrl = tabResult['tabUrl'] as string;
      await new Promise((r) => setTimeout(r, 2000));
    }

    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    const { meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return "tier-test"' },
      nextId++,
      20000,
    );

    expect(meta).toBeDefined();
    const engine = meta!['engine'] as string;

    if (extensionConnected) {
      expect(engine).toBe('extension');
    } else if (daemonAvailable) {
      expect(engine).toBe('daemon');
    } else {
      expect(engine).toBe('applescript');
    }
  }, 30000);
});
