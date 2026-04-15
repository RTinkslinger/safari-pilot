/**
 * MCP Handshake E2E Tests
 *
 * Verifies the MCP server starts correctly, completes the JSON-RPC handshake,
 * and exposes the full tool catalogue with correct shapes.
 *
 * Zero mocks. Zero source imports. Real process over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('MCP Handshake', () => {
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

  it('initialize returns jsonrpc 2.0', async () => {
    // initClient already did the handshake — send a second initialize to inspect the raw response
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-handshake-test', version: '1.0' },
      },
    });

    expect(resp['jsonrpc']).toBe('2.0');
    expect(resp['id']).toBeDefined();
    expect(resp['result']).toBeDefined();
  }, 15000);

  it('tools/list returns exactly 76 tools', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });

    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    expect(tools).toBeInstanceOf(Array);
    expect(tools.length).toBe(76);
  }, 15000);

  it('all tool names start with safari_', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });

    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    for (const tool of tools) {
      const name = tool['name'] as string;
      expect(name).toMatch(/^safari_/);
    }
  }, 15000);

  it('each tool has name, description, and inputSchema', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });

    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;

    for (const tool of tools) {
      expect(tool['name']).toEqual(expect.any(String));
      expect((tool['name'] as string).length).toBeGreaterThan(0);

      expect(tool['description']).toEqual(expect.any(String));
      expect((tool['description'] as string).length).toBeGreaterThan(0);

      expect(tool['inputSchema']).toBeDefined();
      expect(typeof tool['inputSchema']).toBe('object');
    }
  }, 15000);

  it('health check runs and returns checks array', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);

    expect(result['checks']).toBeInstanceOf(Array);
    expect((result['checks'] as unknown[]).length).toBeGreaterThan(0);
    expect(result).toHaveProperty('healthy');
    expect(result).toHaveProperty('sessionId');
  }, 25000);

  it('health check includes safari_running check', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const safariRunning = checks.find((c) => c['name'] === 'safari_running');
    expect(safariRunning).toBeDefined();
    expect(safariRunning!['ok']).toBe(true);
  }, 25000);

  it('health check includes js_apple_events check', async () => {
    const result = await callTool(client, 'safari_health_check', {}, nextId++, 20000);
    const checks = result['checks'] as Array<Record<string, unknown>>;

    const jsAppleEvents = checks.find((c) => c['name'] === 'js_apple_events');
    expect(jsAppleEvents).toBeDefined();
    // This may be true or false depending on Safari config — just verify the check exists
    expect(typeof jsAppleEvents!['ok']).toBe('boolean');
  }, 25000);
});
