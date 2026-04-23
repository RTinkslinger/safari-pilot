/**
 * Security — Tab Ownership Enforcement
 *
 * Proves that navigation/interaction tools cannot be exploited to touch
 * user-owned Safari tabs. These tests target the shipped security
 * architecture (schema-declared contracts + server-side ownership checks +
 * handler-level validation), not internal APIs.
 *
 * T1 coverage: `safari_navigate` rejects missing / empty-string / non-string
 * tabUrl so that the ownership check at server.ts cannot be bypassed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initClient, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';

describe('Security: Tab ownership enforcement', () => {
  let client: McpTestClient;
  let nextId: number;

  beforeAll(async () => {
    const result = await initClient('dist/index.js');
    client = result.client;
    nextId = result.nextId;
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
  });

  // ── T1: safari_navigate requires tabUrl ───────────────────────────────────

  it('T1: safari_navigate advertises tabUrl as required in its schema', async () => {
    const resp = (await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    })) as Record<string, unknown>;
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;
    const navTool = tools.find((t) => t['name'] === 'safari_navigate');
    expect(navTool, 'safari_navigate tool should be registered').toBeDefined();
    const schema = navTool!['inputSchema'] as Record<string, unknown>;
    const required = schema['required'] as string[];
    expect(required).toContain('url');
    expect(required).toContain('tabUrl');
  }, 10000);

  it('T1: safari_navigate rejects missing tabUrl (no front-tab fallback)', async () => {
    // No tabUrl → must be rejected before any AppleScript runs.
    await expect(
      rawCallTool(
        client,
        'safari_navigate',
        { url: 'https://example.com' },
        nextId++,
        10000,
      ),
    ).rejects.toThrow(/tabUrl/);
  }, 15000);

  it('T1: safari_navigate rejects empty-string tabUrl', async () => {
    // Empty string is falsy — previously slipped through the ownership gate.
    // Handler-level validation must treat it as missing.
    await expect(
      rawCallTool(
        client,
        'safari_navigate',
        { url: 'https://example.com', tabUrl: '' },
        nextId++,
        10000,
      ),
    ).rejects.toThrow(/tabUrl/);
  }, 15000);

  it('T1: safari_navigate rejects non-string tabUrl', async () => {
    // Schema says string; without runtime enforcement, agents could pass
    // any type. Handler must reject non-strings explicitly.
    await expect(
      rawCallTool(
        client,
        'safari_navigate',
        { url: 'https://example.com', tabUrl: null as unknown as string },
        nextId++,
        10000,
      ),
    ).rejects.toThrow(/tabUrl/);
  }, 15000);
});
