/**
 * Downloads E2E Tests
 *
 * Verifies safari_wait_for_download tool existence and interface through
 * the real MCP protocol over stdin/stdout.
 *
 * NOTE: Actual download testing requires a download-triggering click workflow
 * and user interaction with Safari's "Allow downloads?" prompt. The tool
 * presence and parameter schema are verified here. Actual download flow
 * tests are marked as .todo since they require a fixture server and
 * interactive Safari approval.
 *
 * Zero mocks. Zero source imports. Real MCP protocol.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Downloads E2E', () => {
  let client: McpTestClient;
  let nextId: number;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
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
  }, 15000);

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
  }, 15000);

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
