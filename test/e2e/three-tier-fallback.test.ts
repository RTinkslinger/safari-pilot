/**
 * Three-Tier Fallback E2E Tests
 *
 * Verifies the three-tier engine model (Extension > Daemon > AppleScript) is
 * reported correctly through the MCP protocol, and that basic navigation
 * works regardless of which engines are available.
 *
 * Zero mocks. Zero source imports. Real process over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Three-Tier Fallback', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30000);

  afterAll(async () => {
    if (agentTabUrl && client) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10000);
      } catch { /* tab may already be closed */ }
    }
    if (client) await client.close();
  });

  it('health check reports all engine statuses', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    // Must report on all three engine tiers
    const checkNames = checks.map((c) => c['name'] as string);

    expect(checkNames).toContain('safari_running');
    expect(checkNames).toContain('daemon');
    expect(checkNames).toContain('extension');

    // Safari must be running for any e2e test to work
    const safariCheck = checks.find((c) => c['name'] === 'safari_running');
    expect(safariCheck!['ok']).toBe(true);

    // Daemon and extension may or may not be available — just verify the check ran
    const daemonCheck = checks.find((c) => c['name'] === 'daemon');
    expect(typeof daemonCheck!['ok']).toBe('boolean');

    const extensionCheck = checks.find((c) => c['name'] === 'extension');
    expect(typeof extensionCheck!['ok']).toBe('boolean');

    console.log(
      'Engine status:',
      checks.map((c) => `${c['name']}=${c['ok']}`).join(', '),
    );
  }, 25000);

  it('navigation tool works via best available engine', async () => {
    const result = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );

    expect(result['tabUrl']).toBeDefined();
    expect(typeof result['tabUrl']).toBe('string');
    agentTabUrl = result['tabUrl'] as string;

    // Wait for load, then verify content is accessible
    await new Promise((r) => setTimeout(r, 3000));

    const tabUrl = agentTabUrl.endsWith('/') ? agentTabUrl : agentTabUrl + '/';
    const textResult = await callTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );

    expect(textResult['text']).toBeDefined();
    expect((textResult['text'] as string)).toContain('Example Domain');
  }, 35000);

  it('response has engine metadata in MCP payload', async () => {
    // Inspect the raw MCP response to verify the server includes content
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

    expect(content).toBeInstanceOf(Array);
    expect(content.length).toBeGreaterThan(0);
    expect(content[0]['type']).toBe('text');

    // The text content should be valid JSON with health check data
    const payload = JSON.parse(content[0]['text'] as string) as Record<string, unknown>;
    expect(payload['checks']).toBeInstanceOf(Array);
    expect(payload).toHaveProperty('healthy');

    // The checks array includes engine status (daemon, extension)
    // which proves engine metadata flows through the full MCP pipeline
    const checks = payload['checks'] as Array<Record<string, unknown>>;
    const engineChecks = checks.filter((c) =>
      ['daemon', 'extension'].includes(c['name'] as string),
    );
    expect(engineChecks.length).toBe(2);
  }, 25000);
});
