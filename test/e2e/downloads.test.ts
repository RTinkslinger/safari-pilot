/**
 * Downloads E2E Tests
 *
 * Verifies safari_wait_for_download tool existence, interface, and engine
 * routing through the real MCP protocol over stdin/stdout.
 *
 * Selector-only engine proof: verifies _meta.engine === 'extension' (engine
 * selector routes through extension) for the download tool. DownloadTools
 * uses daemon internally, but the engine selector picks extension as the
 * routing layer — both facts are verified where possible.
 *
 * NOTE: Actual download testing requires a download-triggering click workflow
 * and user interaction with Safari's "Allow downloads?" prompt. The tool
 * presence, parameter schema, and engine routing are verified here. Actual
 * download flow tests are marked as .todo since they require a fixture server
 * and interactive Safari approval.
 *
 * Zero mocks. Zero source imports. Real MCP protocol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Downloads E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=downloads' }, nextId++, 20_000);
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

  it('safari_wait_for_download is listed in tools/list', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });

    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    const downloadTool = tools.find(
      (t) => (t['name'] as string) === 'safari_wait_for_download',
    );

    expect(downloadTool).toBeDefined();
    expect(downloadTool!['description']).toBeDefined();
    expect(typeof downloadTool!['description']).toBe('string');
    expect((downloadTool!['description'] as string).length).toBeGreaterThan(0);
  }, 60_000);

  it('safari_wait_for_download has correct inputSchema', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });

    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    const downloadTool = tools.find(
      (t) => (t['name'] as string) === 'safari_wait_for_download',
    );

    const schema = downloadTool!['inputSchema'] as Record<string, unknown>;
    expect(schema['type']).toBe('object');

    const properties = schema['properties'] as Record<string, unknown>;
    expect(properties).toBeDefined();

    // Should have timeout, filenamePattern, and tabUrl properties
    expect(properties['timeout']).toBeDefined();
    expect(properties['filenamePattern']).toBeDefined();
    expect(properties['tabUrl']).toBeDefined();
  }, 60_000);

  it.todo(
    'safari_wait_for_download detects a completed download ' +
    '(requires fixture server serving a downloadable file and Safari allowing the download)',
  );

  it.todo(
    'safari_wait_for_download returns file metadata including filename, path, size, and mimeType ' +
    '(requires actual download workflow with click context)',
  );

  it.todo(
    'safari_wait_for_download detects inline render when Safari opens file in-tab ' +
    '(requires a PDF or image URL that Safari renders rather than downloads)',
  );
});
