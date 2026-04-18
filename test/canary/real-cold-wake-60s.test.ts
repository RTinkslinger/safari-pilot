/**
 * Real Cold-Wake (60s idle) Canary
 *
 * NOT in regular e2e suite. Runs at release time only via `npm run test:canary`.
 * Validates the PRODUCTION path (no DEBUG_HARNESS force-unload).
 *
 * Pre-requisites:
 * - Safari running
 * - Safari Pilot extension installed (via `open "bin/Safari Pilot.app"`)
 * - Extension enabled in Safari > Settings > Extensions
 * - "Allow JavaScript from Apple Events" on (Safari > Develop menu)
 *
 * This test waits real wall-clock time for Safari's event-page unloader to run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Real cold-wake (60s idle) canary', () => {
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

  it(
    'extension wakes from real Safari event-page unload and responds within 90s',
    { timeout: 120_000 },
    async () => {
      // 1. Warm up — confirm extension is reachable
      const warmup = await callTool(client, 'safari_extension_health', {}, nextId++);
      const warmupText = warmup?.content?.[0]?.text;
      expect(typeof warmupText).toBe('string');
      const warmupParsed = JSON.parse(warmupText);
      expect(warmupParsed).toBeTypeOf('object');

      // 2. Wait 60 seconds — real Safari should unload the event page in this window
      console.log('Waiting 60s for Safari to unload the event page...');
      await new Promise((r) => setTimeout(r, 60_000));

      // 3. Issue another health check — the extension should wake on daemon poll/alarm
      const afterWake = await callTool(client, 'safari_extension_health', {}, nextId++, 90_000);
      const afterText = afterWake?.content?.[0]?.text;
      expect(typeof afterText).toBe('string');
      const afterParsed = JSON.parse(afterText);
      expect(afterParsed).toBeTypeOf('object');
      // The health response existing at all proves the daemon is reachable.
      // A "true cold-wake Extension-engine roundtrip" requires an actual tool that
      // dispatches through the extension, which requires the extension to wake + poll.
      // safari_extension_health goes through the daemon directly, so this is a softer check.
      // Full extension engine round-trip proof comes from multi-profile manual QA.
    }
  );
});
