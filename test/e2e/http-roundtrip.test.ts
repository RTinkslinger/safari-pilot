/**
 * HTTP IPC Roundtrip — e2e
 *
 * Verifies the HTTP short-poll architecture works end-to-end:
 *   1. MCP handshake + tools/list (always)
 *   2. safari_extension_health has correct structure with HTTP fields (always)
 *   3. Extension connectivity + reconcile timestamp (extension is always connected)
 *   4. Extension-engine roundtrip via safari_evaluate (extension is always connected)
 *
 * Extension-always-connected architecture: all tests run unconditionally.
 * No skipIf, no extensionConnected probing. Wake probe in beforeAll asserts
 * the extension is live before any test runs.
 *
 * All communication via McpTestClient (spawns real node process, JSON-RPC
 * over stdin/stdout). No mocks, no source imports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const ROOT = join(import.meta.dirname, '../..');
const SERVER_PATH = join(ROOT, 'dist/index.js');

describe('HTTP IPC roundtrip (commit 2)', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=http-roundtrip' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      if (agentTabUrl && client) {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  it('MCP handshake + tools/list returns ≥76 tools including extension_health', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(76);
    expect(tools.some((t) => t.name === 'safari_extension_health')).toBe(true);
    expect(tools.some((t) => t.name === 'safari_evaluate')).toBe(true);
  }, 60_000);

  it('safari_extension_health returns valid snapshot with HTTP fields', async () => {
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 60_000);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
    expect(typeof parsed.isConnected).toBe('boolean');
    expect(typeof parsed.pendingCommandsCount).toBe('number');
    expect(typeof parsed.executedLogSize).toBe('number');
    expect(typeof parsed.ipcMechanism).toBe('string');
    expect(['http', 'none']).toContain(parsed.ipcMechanism);
  }, 60_000);

  it('extension connected: isConnected true + reconcile timestamp set', async () => {
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 60_000);
    expect(parsed.isConnected).toBe(true);
    expect(parsed.ipcMechanism).toBe('http');
    // lastReconcileTimestamp must be a real number (set by POST /connect)
    expect(parsed.lastReconcileTimestamp).toBeTypeOf('number');
    expect(parsed.lastReconcileTimestamp).toBeGreaterThan(0);
  }, 120_000);

  it('safari_evaluate roundtrip works through extension engine', async () => {
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_evaluate',
      { script: 'return 2 + 2', tabUrl: agentTabUrl },
      'extension',
      nextId++,
      60_000,
    );

    expect(payload).toBeDefined();
    const hasError = payload._isError || payload.error;
    expect(hasError).toBeFalsy();

    expect(meta!['engine']).toBe('extension');
  }, 120_000);
});
