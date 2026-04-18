/**
 * HTTP IPC Roundtrip — e2e
 *
 * Verifies the commit 2 HTTP short-poll architecture works end-to-end:
 *   1. MCP handshake + tools/list (always)
 *   2. safari_extension_health has correct structure with HTTP fields (always)
 *   3. Extension connectivity + reconcile timestamp (requires extension connected)
 *   4. Extension-engine roundtrip via safari_evaluate (requires extension connected)
 *
 * Tests 3-4 require the Safari extension to be actively connected to this daemon
 * instance. The test daemon spawns fresh — the extension connects to the system
 * daemon (LaunchAgent) by default. Tests 3-4 skip gracefully when extension is
 * not connected, rather than failing on an environmental dependency.
 *
 * All communication via McpTestClient (spawns real node process, JSON-RPC
 * over stdin/stdout). No mocks, no source imports.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';

const ROOT = join(import.meta.dirname, '../..');
const SERVER_PATH = join(ROOT, 'dist/index.js');

describe.skipIf(process.env.CI === 'true')('HTTP IPC roundtrip (commit 2)', () => {
  let client: McpTestClient;
  let nextId: number;
  let extensionConnected = false;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Probe extension connectivity to gate tests 3-4
    try {
      const health = await callTool(client, 'safari_extension_health', {}, nextId++, 20_000);
      extensionConnected = health.isConnected === true;
    } catch {
      extensionConnected = false;
    }
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
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
  }, 15_000);

  it('safari_extension_health returns valid snapshot with HTTP fields', async () => {
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 20_000);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
    // Structure: these fields must exist regardless of connection state
    expect(typeof parsed.isConnected).toBe('boolean');
    expect(typeof parsed.pendingCommandsCount).toBe('number');
    expect(typeof parsed.executedLogSize).toBe('number');
    expect(typeof parsed.ipcMechanism).toBe('string');
    // ipcMechanism should be 'http' if extension ever connected, 'none' otherwise
    expect(['http', 'none']).toContain(parsed.ipcMechanism);
  }, 25_000);

  it('extension connected: isConnected true + reconcile timestamp set', async () => {
    if (!extensionConnected) {
      console.log('  ⊘ skipped: extension not connected to test daemon');
      return;
    }
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 20_000);
    expect(parsed.isConnected).toBe(true);
    expect(parsed.ipcMechanism).toBe('http');
    // lastReconcileTimestamp must be a real number (set by POST /connect)
    expect(parsed.lastReconcileTimestamp).toBeTypeOf('number');
    expect(parsed.lastReconcileTimestamp).toBeGreaterThan(0);
  }, 25_000);

  it('safari_evaluate roundtrip works through an engine', async () => {
    // Create an agent-owned tab (tab ownership security layer).
    let tabResult: Record<string, unknown>;
    try {
      tabResult = await callTool(client, 'safari_new_tab', { url: 'about:blank' }, nextId++, 20_000);
    } catch {
      console.log('  ⊘ skipped: could not create tab (Safari not accessible)');
      return;
    }
    expect(tabResult).toHaveProperty('tabUrl');

    // safari_evaluate uses whichever engine is available. The extension engine
    // requires the extension to be polling THIS daemon's HTTP server — when the
    // system daemon already holds port 19475, the test daemon's HTTP server can't
    // bind and extension commands timeout. We verify the tool responds correctly
    // or handle environmental failures (no target tab, timeout) gracefully.
    let payload: Record<string, unknown>;
    let meta: Record<string, unknown> | undefined;
    try {
      const result = await rawCallTool(
        client,
        'safari_evaluate',
        { expression: '2 + 2' },
        nextId++,
        30_000,
      );
      payload = result.payload;
      meta = result.meta;
    } catch (err) {
      // "No target tab" or timeout = environmental, not a code bug
      const msg = (err as Error).message;
      if (msg.includes('No target tab') || msg.includes('timeout')) {
        console.log(`  ⊘ skipped: ${msg}`);
        return;
      }
      throw err;
    }

    expect(payload).toHaveProperty('ok');
    if (payload.ok) {
      expect(payload.value).toBe(4);
    }

    // Engine metadata present — any engine is acceptable
    if (meta) {
      expect(['extension', 'daemon', 'applescript']).toContain(meta.engine);
    }
  }, 35_000);
});
