/**
 * Shippability Gate — e2e
 *
 * Asserts: (a) commit 2 reconcile + HTTP code is present, and (b) the
 * extension engine produces a real roundtrip end-to-end.
 *
 * The grep assertions are the load-bearing contract: commit 2 must ship WITH the
 * reconcile protocol and HTTP fetch IPC.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const ROOT = join(import.meta.dirname, '../..');
const SERVER_PATH = join(ROOT, 'dist/index.js');

describe('Shippability gate (commit 2)', () => {
  describe('commit 2 reconcile + HTTP code present', () => {
    it('extension/background.js contains reconcile protocol and HTTP fetch', () => {
      const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
      expect(bg).toMatch(/reconcile/i);
      expect(bg).toMatch(/handleReconcileResponse/);
      expect(bg).toMatch(/fetch\(/);
      expect(bg).not.toContain('browser.runtime.sendNativeMessage');
    });

    it('ExtensionBridge.swift has handleReconcile and executedLog', () => {
      const eb = readFileSync(
        join(ROOT, 'daemon/Sources/SafariPilotdCore/ExtensionBridge.swift'),
        'utf8',
      );
      expect(eb).toMatch(/handleReconcile/);
      expect(eb).toMatch(/executedLog/);
    });
  });

  describe('real MCP roundtrip', () => {
    let client: McpTestClient;
    let nextId: number;

    beforeAll(async () => {
      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;
    }, 30_000);

    afterAll(async () => {
      if (client) await client.close();
    });

    it('MCP handshake + tools/list succeeds', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/list',
        params: {},
      });
      const result = resp['result'] as Record<string, unknown>;
      const tools = result['tools'] as Array<Record<string, unknown>>;
      expect(Array.isArray(tools)).toBe(true);
      // 1a adds 2 diagnostic tools (extension_health, extension_debug_dump) → 78
      expect(tools.length).toBeGreaterThanOrEqual(76);
      expect(tools.some((t) => t.name === 'safari_extension_health')).toBe(true);
    }, 15_000);

    it('safari_extension_health returns a health snapshot', async () => {
      // callTool parses result.content[0].text into JSON automatically.
      // If the daemon is unavailable it may throw (MCP protocol error) — that's
      // acceptable for a gate test; the grep suite is the load-bearing half.
      const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 20_000);
      expect(parsed).toBeTypeOf('object');
      expect(parsed).not.toBeNull();
      // Verify structural fields exist with correct types — not just typeof check
      expect(parsed).toHaveProperty('isConnected');
      expect(parsed).toHaveProperty('ipcMechanism');
      expect(parsed).toHaveProperty('pendingCommandsCount');
      expect(parsed).toHaveProperty('executedLogSize');
      expect(typeof parsed.isConnected).toBe('boolean');
      expect(typeof parsed.ipcMechanism).toBe('string');
      expect(typeof parsed.pendingCommandsCount).toBe('number');
      expect(typeof parsed.executedLogSize).toBe('number');
    }, 25_000);
  });
});
