/**
 * Degradation Scenarios E2E Tests
 *
 * Tests graceful degradation when the extension engine is disabled or unavailable.
 * Each scenario uses its own MCP server instance and restores config in afterAll.
 *
 * Zero mocks. Zero source imports. Real MCP server over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { E2EReportCollector } from '../helpers/e2e-report.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const CONFIG_PATH = join(import.meta.dirname, '../../safari-pilot.config.json');

describe('Degradation Scenarios', () => {

  // ── Scenario 1: Config kill-switch ──────────────────────────────────────
  describe('config kill-switch disables extension engine', () => {
    let client: McpTestClient;
    let nextId: number;
    let originalConfig: string;
    const report = new E2EReportCollector('degradation-killswitch');

    beforeAll(async () => {
      originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(originalConfig);
      config.extension = config.extension || {};
      config.extension.enabled = false;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;
      report.setExtensionConnected(false);
    }, 180_000);

    afterAll(async () => {
      try {
        report.writeReport();
        await client?.close().catch(() => {});
      } finally {
        writeFileSync(CONFIG_PATH, originalConfig);
      }
    });

    it('tools fall back to daemon/applescript when extension disabled', async () => {
      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-ks' }, nextId++, 20_000);
      const tabUrl = tabResult['tabUrl'] as string;
      await new Promise(r => setTimeout(r, 2000));

      const { meta } = await rawCallTool(client, 'safari_evaluate', { script: 'return 1', tabUrl }, nextId++, 60_000);
      expect(meta?.['engine']).not.toBe('extension');
      expect(['daemon', 'applescript']).toContain(meta?.['engine']);
      report.recordCall('safari_evaluate', { tabUrl }, meta, true);

      // Cleanup tab
      await rawCallTool(client, 'safari_close_tab', { tabUrl }, nextId++, 10_000).catch(() => {});
    }, 120_000);
  });

  // ── Scenario 2: Circuit breaker trip + recovery ─────────────────────────
  describe('circuit breaker trips after errors and recovers after cooldown', () => {
    let client: McpTestClient;
    let nextId: number;
    let agentTabUrl: string;

    beforeAll(async () => {
      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;

      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-cb' }, nextId++, 20_000);
      agentTabUrl = tabResult['tabUrl'] as string;
      await new Promise(r => setTimeout(r, 3000));
    }, 180_000);

    afterAll(async () => {
      try {
        if (agentTabUrl && client) {
          await rawCallTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000).catch(() => {});
        }
      } finally {
        await client?.close().catch(() => {});
      }
    });

    it('trips after 5 errors and recovers after cooldown', { timeout: 300_000 }, async () => {
      // Trigger 5 errors to trip the domain circuit breaker
      for (let i = 0; i < 5; i++) {
        await rawCallTool(
          client,
          'safari_evaluate',
          { script: '(function(){throw new Error("trip")})()', tabUrl: agentTabUrl },
          nextId++,
          10_000,
        ).catch(() => {}); // errors expected
      }

      // 6th call should get CIRCUIT_BREAKER_OPEN — rawCallTool throws on protocol errors,
      // so catch the error and verify the message contains the circuit breaker indicator.
      let cbErrorMessage = '';
      try {
        const { payload } = await rawCallTool(
          client, 'safari_evaluate',
          { script: 'return 1', tabUrl: agentTabUrl },
          nextId++, 10_000,
        );
        // If no throw, the payload itself should carry the error text
        cbErrorMessage = String(payload['_rawText'] ?? JSON.stringify(payload));
      } catch (err) {
        cbErrorMessage = String((err as Error).message);
      }
      expect(cbErrorMessage).toMatch(/circuit.?breaker.*(open|trip)|cooldown/i);

      // Wait for cooldown (120s from config)
      await new Promise(r => setTimeout(r, 125_000));

      // Verify recovery
      const { meta } = await rawCallTool(
        client, 'safari_evaluate',
        { script: 'return 1', tabUrl: agentTabUrl },
        nextId++, 60_000,
      );
      expect(meta?.['engine']).toBe('extension');
    });
  });

  // ── Scenario 3: Extension-unavailable selector path ─────────────────────
  describe('extension-unavailable: extension-required tools throw', () => {
    let client: McpTestClient;
    let nextId: number;
    let originalConfig: string;

    beforeAll(async () => {
      originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(originalConfig);
      config.extension = config.extension || {};
      config.extension.enabled = false;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;
    }, 180_000);

    afterAll(async () => {
      try {
        await client?.close().catch(() => {});
      } finally {
        writeFileSync(CONFIG_PATH, originalConfig);
      }
    });

    it('MCP server lists tools even without extension', async () => {
      const resp = await client.send(
        { jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} },
        20_000,
      ) as Record<string, unknown>;
      const result = resp['result'] as Record<string, unknown>;
      const tools = result['tools'] as unknown[];
      expect(tools.length).toBeGreaterThanOrEqual(75);
    }, 120_000);

    it('extension-requiring tools throw EngineUnavailableError', async () => {
      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-eu' }, nextId++, 20_000);
      const tabUrl = tabResult['tabUrl'] as string;
      await new Promise(r => setTimeout(r, 2000));

      const resp = await client.send(
        { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'safari_query_shadow', arguments: { tabUrl, hostSelector: 'div', shadowSelector: 'span' } } },
        60_000,
      ) as Record<string, unknown>;

      // Should get an error, not a result
      if (resp['error']) {
        const errMsg = ((resp['error'] as Record<string, unknown>)['message'] as string).toLowerCase();
        expect(errMsg).toMatch(/engine.*unavailable|extension.*required|extension.*not.*available|unavailable/i);
      } else {
        const result = resp['result'] as Record<string, unknown>;
        const content = result['content'] as Array<Record<string, unknown>>;
        const text = content?.[0]?.['text'] as string ?? '';
        expect(text.toLowerCase()).toMatch(/engine.*unavailable|extension.*required|extension.*not.*available|unavailable/i);
      }

      // Cleanup
      await rawCallTool(client, 'safari_close_tab', { tabUrl }, nextId++, 10_000).catch(() => {});
    }, 120_000);
  });

  // ── Scenario 4: Extension disconnect (OPTIONAL) ─────────────────────────
  const hasDebugHarness = process.env['SAFARI_PILOT_TEST_MODE'] === '1';
  describe.skipIf(!hasDebugHarness)('extension disconnect during use', () => {
    it('TODO: send force-unload, verify disconnect, verify reconnect', () => {
      expect(hasDebugHarness).toBe(true);
    });
  });
});
