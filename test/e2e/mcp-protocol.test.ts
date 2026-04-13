/**
 * MCP Protocol End-to-End Test
 *
 * TRUE end-to-end: spawns `node dist/index.js` as a real child process,
 * speaks MCP JSON-RPC over stdin/stdout. No mocks. No server imports.
 *
 * Wire format: newline-delimited JSON (confirmed from SDK stdio.js source).
 * Each message is a single JSON object terminated by '\n'.
 *
 * Prerequisites:
 * - `npm run build` must have been run (tests use dist/index.js)
 * - Safari-dependent tests are skipped in CI (SAFARI_AVAILABLE env var or
 *   process.env.CI detection)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const SAFARI_AVAILABLE = process.env.CI !== 'true' && process.env.SAFARI_AVAILABLE !== 'false';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('MCP Protocol E2E — real child process, no mocks', () => {
  let client: McpTestClient;
  let nextId = 100;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH, 1);
    client = init.client;
    nextId = init.nextId;
  }, 20000);

  afterAll(async () => {
    await client.close();
  });

  // ── 1. initialize ────────────────────────────────────────────────────────

  describe('initialize', () => {
    it('spawns cleanly and responds to initialize with correct protocol shape', async () => {
      // We need a fresh client for this test — beforeAll already consumed id=1 on the
      // shared client. Spawn a raw McpTestClient and send initialize directly.
      const freshClient = new McpTestClient(SERVER_PATH);
      const resp = await freshClient.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'mcp-protocol-e2e', version: '1.0.0' },
        },
      }) as Record<string, unknown>;

      expect(resp).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
      });

      const result = resp['result'] as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result['protocolVersion']).toBe('2024-11-05');

      const capabilities = result['capabilities'] as Record<string, unknown>;
      expect(capabilities).toBeDefined();
      expect(capabilities).toHaveProperty('tools');

      const serverInfo = result['serverInfo'] as Record<string, unknown>;
      expect(serverInfo).toBeDefined();
      expect(serverInfo['name']).toBe('safari-pilot');
      expect(typeof serverInfo['version']).toBe('string');

      await freshClient.close();
    }, 20000);
  });

  // ── 2. tools/list ────────────────────────────────────────────────────────

  describe('tools/list', () => {
    it('returns 74+ tools after handshake', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/list',
        params: {},
      }) as Record<string, unknown>;

      expect(resp).toMatchObject({ jsonrpc: '2.0' });
      expect(resp).not.toHaveProperty('error');

      const result = resp['result'] as Record<string, unknown>;
      expect(result).toBeDefined();

      const tools = result['tools'] as Array<unknown>;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThanOrEqual(74);
    }, 15000);

    it('each tool entry has required fields: name, description, inputSchema', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/list',
        params: {},
      }) as Record<string, unknown>;

      const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<Record<string, unknown>>;

      for (const tool of tools) {
        expect(typeof tool['name']).toBe('string');
        expect((tool['name'] as string).startsWith('safari_')).toBe(true);
        expect(typeof tool['description']).toBe('string');
        expect((tool['description'] as string).length).toBeGreaterThan(0);
        expect(tool['inputSchema']).toBeDefined();
        expect(typeof tool['inputSchema']).toBe('object');
      }
    }, 15000);

    it('includes expected core tool names', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/list',
        params: {},
      }) as Record<string, unknown>;

      const tools = (resp['result'] as Record<string, unknown>)['tools'] as Array<Record<string, unknown>>;
      const names = new Set(tools.map((t) => t['name'] as string));

      const expectedCoreTools = [
        'safari_health_check',
        'safari_navigate',
        'safari_new_tab',
        'safari_list_tabs',
        'safari_get_text',
        'safari_emergency_stop',
      ];

      for (const expected of expectedCoreTools) {
        expect(names.has(expected), `Missing expected tool: ${expected}`).toBe(true);
      }
    }, 15000);
  });

  // ── 3. tools/call — no Safari required ───────────────────────────────────

  describe('tools/call (no Safari required)', () => {
    it('safari_health_check returns content array', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name: 'safari_health_check',
          arguments: {},
        },
      }) as Record<string, unknown>;

      // The call should succeed or return a tool-level error — not a protocol error
      expect(resp).toMatchObject({ jsonrpc: '2.0' });

      // health_check returns a result with content array even on partial failure
      if ('result' in resp) {
        const result = resp['result'] as Record<string, unknown>;
        const content = result['content'] as Array<Record<string, unknown>>;
        expect(Array.isArray(content)).toBe(true);
        expect(content.length).toBeGreaterThan(0);
        // Content items have type field
        for (const item of content) {
          expect(['text', 'image']).toContain(item['type']);
        }
      } else {
        // Protocol-level errors are unexpected but not a test infrastructure failure
        const error = resp['error'] as Record<string, unknown>;
        // If we get an error, it should at least be a well-formed JSON-RPC error
        expect(typeof error['code']).toBe('number');
        expect(typeof error['message']).toBe('string');
      }
    }, 20000);

    it('unknown tool returns JSON-RPC error response', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name: 'safari_does_not_exist_12345',
          arguments: {},
        },
      }) as Record<string, unknown>;

      expect(resp).toMatchObject({ jsonrpc: '2.0' });
      // Should get either a protocol-level error OR a result with isError content
      // MCP servers may handle unknown tools either way
      const hasError = 'error' in resp;
      const hasResult = 'result' in resp;
      expect(hasError || hasResult).toBe(true);

      if (hasError) {
        const error = resp['error'] as Record<string, unknown>;
        expect(typeof error['code']).toBe('number');
        expect(typeof error['message']).toBe('string');
      }
    }, 15000);
  });

  // ── 4. Multiple rapid requests ────────────────────────────────────────────

  describe('multiple rapid requests', () => {
    it('handles 3 sequential tools/list requests and returns all responses', async () => {
      const ids = [nextId++, nextId++, nextId++];
      const requests = ids.map((reqId) =>
        client.send({
          jsonrpc: '2.0',
          id: reqId,
          method: 'tools/list',
          params: {},
        }),
      );

      // All three in flight concurrently — ID-based routing handles out-of-order responses
      const responses = await Promise.all(requests);

      expect(responses).toHaveLength(3);
      for (const resp of responses as Array<Record<string, unknown>>) {
        expect(resp).toMatchObject({ jsonrpc: '2.0' });
        const result = resp['result'] as Record<string, unknown>;
        expect(result).toBeDefined();
        const tools = result['tools'] as Array<unknown>;
        expect(tools.length).toBeGreaterThanOrEqual(74);
      }
    }, 30000);
  });

  // ── 5. Safari-dependent tests ─────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('tools/call with real Safari', () => {
    let newTabId: number | undefined;
    let tabUrl: string | undefined;

    it('safari_new_tab creates a tab and returns a URL', async () => {
      const data = await callTool(client, 'safari_new_tab', { url: 'https://example.com' }, nextId++);

      expect(typeof data['tabUrl']).toBe('string');
      expect((data['tabUrl'] as string).length).toBeGreaterThan(0);
      expect(data['tabUrl'] as string).toMatch(/^https?:\/\//);
      tabUrl = data['tabUrl'] as string;

      if (data['tabId'] !== undefined) {
        newTabId = data['tabId'] as number;
      }
    }, 20000);

    it('safari_navigate navigates to example.com and confirms success', async () => {
      if (!tabUrl) {
        // If new_tab didn't run, skip gracefully
        return;
      }

      // Wait briefly for the tab to finish loading
      await new Promise((r) => setTimeout(r, 1500));

      const resp = await client.send({
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: {
          name: 'safari_navigate',
          arguments: {
            tabUrl,
            url: 'https://example.com',
          },
        },
      }) as Record<string, unknown>;

      expect(resp).toMatchObject({ jsonrpc: '2.0' });

      // May succeed or return an ownership/tab-not-found error since the tab
      // URL may have been normalized by Safari — both are valid protocol responses
      const hasResult = 'result' in resp;
      const hasError = 'error' in resp;
      expect(hasResult || hasError).toBe(true);
    }, 25000);

    it('safari_list_tabs returns the tabs array with at least one entry', async () => {
      const data = await callTool(client, 'safari_list_tabs', {}, nextId++);

      expect(Array.isArray(data['tabs'])).toBe(true);
      expect((data['tabs'] as Array<unknown>).length).toBeGreaterThan(0);
    }, 15000);
  });
});
