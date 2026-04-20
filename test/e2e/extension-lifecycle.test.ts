/**
 * Extension Lifecycle E2E — Event-page wake + storage-backed queue
 *
 * Verifies:
 * - Force-unload hook (DEBUG_HARNESS-gated) exists in background.js source
 * - Storage-backed queue health is reachable via MCP
 * - Non-idempotent tools NEVER auto-retry on ambiguous disconnect (caller-decides)
 *
 * Requires SAFARI_PILOT_TEST_MODE=1 when the extension was built, so the
 * force-unload hook exists in the bundled background.js. Full force-unload
 * round-trip requires a canary environment (Task 22); this test verifies the
 * structural contracts and health-probe reachability.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const ROOT = join(import.meta.dirname, '../..');
const SERVER_PATH = join(ROOT, 'dist/index.js');

describe('Extension lifecycle (event-page)', () => {
  let client: McpTestClient;
  let nextId: number;
  let testModeAvailable: boolean;
  let agentTabUrl: string;

  beforeAll(async () => {
    testModeAvailable = process.env.SAFARI_PILOT_TEST_MODE === '1';
    if (!testModeAvailable) {
      // eslint-disable-next-line no-console
      console.warn('SAFARI_PILOT_TEST_MODE=1 not set — lifecycle tests will be skipped individually');
    }
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=extension-lifecycle' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      if (agentTabUrl && client) {
        try {
          await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10000);
        } catch {
          // Best-effort cleanup
        }
      }
    } finally {
      if (client) await client.close();
    }
  });

  describe('DEBUG_HARNESS structural checks', () => {
    it('background.js contains the force-unload hook inside DEBUG_HARNESS markers', () => {
      const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
      expect(bg).toContain('/*@DEBUG_HARNESS_BEGIN@*/');
      expect(bg).toContain('/*@DEBUG_HARNESS_END@*/');
      expect(bg).toContain('__safari_pilot_test_force_unload__');
      expect(bg).toContain('browser.runtime.reload()');
    });
  });

  describe('health probe reachability', () => {
    it.skipIf(!testModeAvailable)('extension health responds before and after simulated delay', async () => {
      // Verify the extension health tool is reachable.
      const snapshotBefore = await callTool(client, 'safari_extension_health', {}, nextId++, 60_000);
      expect(snapshotBefore).toBeTypeOf('object');
      expect(snapshotBefore).not.toBeNull();

      // We cannot directly invoke __safari_pilot_test_force_unload__ from the MCP
      // side without an extension-page caller. At commit 1a, the MCP server doesn't
      // expose a "send native message to extension" tool; the DEBUG_HARNESS hook is
      // reachable only via browser.runtime.onMessage, which requires an extension-page
      // context. A 100ms delay is a proxy for "simulated scenario."
      await new Promise((r) => setTimeout(r, 100));

      const snapshotAfter = await callTool(client, 'safari_extension_health', {}, nextId++, 60_000);
      expect(snapshotAfter).toBeTypeOf('object');
      expect(snapshotAfter).not.toBeNull();

      // NOTE: A full force-unload round-trip requires either (a) a page context to
      // send the test message, or (b) an MCP-level "raw daemon command" tool. The
      // hook is declared in background.js; Task 22 canary exercises the real unload.
    }, 120_000);
  });

  describe('EXTENSION_UNCERTAIN retry safety', () => {
    it('ExtensionUncertainError has retryable=false in errors.ts', () => {
      const errorsSrc = readFileSync(join(ROOT, 'src/errors.ts'), 'utf8');
      expect(errorsSrc).toMatch(/ExtensionUncertainError/);
      // retryable must be false — non-idempotent tools are NEVER auto-retried.
      expect(errorsSrc).toMatch(/retryable\s*=\s*false/);
    });

    it('EXTENSION_UNCERTAIN error code is defined', () => {
      const errorsSrc = readFileSync(join(ROOT, 'src/errors.ts'), 'utf8');
      expect(errorsSrc).toMatch(/EXTENSION_UNCERTAIN:\s*'EXTENSION_UNCERTAIN'/);
    });
  });
});
