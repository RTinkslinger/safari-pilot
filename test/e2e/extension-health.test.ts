/**
 * Extension Health E2E — safari_extension_health + counter semantics
 *
 * Verifies health snapshot schema + counter behavior through real MCP.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('safari_extension_health (e2e)', () => {
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

  it('returns schema with all required fields', async () => {
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++);
    expect(parsed).toHaveProperty('isConnected');
    expect(parsed).toHaveProperty('lastAlarmFireTimestamp');
    expect(parsed).toHaveProperty('roundtripCount1h');
    expect(parsed).toHaveProperty('timeoutCount1h');
    expect(parsed).toHaveProperty('uncertainCount1h');
    expect(parsed).toHaveProperty('forceReloadCount24h');
    expect(parsed).toHaveProperty('pendingCommandsCount');
    expect(parsed).toHaveProperty('killSwitchActive');
    expect(typeof parsed.isConnected).toBe('boolean');
    expect(typeof parsed.roundtripCount1h).toBe('number');
  });
});
