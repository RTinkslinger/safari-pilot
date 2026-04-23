/**
 * safari_evaluate must resolve Promise-returning scripts end-to-end.
 *
 * Before this fix (2026-04-24), `handleEvaluate` wrapped the user script
 * in a SYNCHRONOUS IIFE and serialized the result without awaiting. A
 * script that `return new Promise(...)` ended up packaged as
 * `{ value: <Promise>, type: 'object' }` — when postMessage'd across the
 * content-main → content-isolated → background bridge, structured-clone
 * refused to copy the unresolved Promise and surfaced as a DataCloneError.
 * The e2e workaround (used by phase5-storage-async.test.ts at the time of
 * T6) was fire-and-forget seeding with a synchronous `return { started: true }`.
 *
 * Post-fix: `handleEvaluate` uses an async IIFE + `await` so the wrapper
 * packages a fully-resolved value. The discriminating test below passes a
 * script that explicitly returns a Promise and asserts the resolved value
 * comes back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('safari_evaluate: Promise-returning scripts resolve end-to-end', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    const unique = `https://example.com/?sp_eval_async=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl as string;
    // Wait for the content script to inject before evaluating.
    await new Promise((r) => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
    }
  });

  it('resolves a script that explicitly returns a Promise (discriminating for T6/T14 fix)', async () => {
    // A trivial Promise that resolves after a microtask. Pre-fix: the outer
    // wrapper returned `{value: <Promise>, type: 'object'}` unresolved and
    // structured-clone failed. Post-fix: the async wrapper awaits and the
    // resolved value comes through as a string.
    const raw = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: "return new Promise(r => r('resolved-42'))" },
      nextId(),
      10000,
    );
    expect(raw.meta?.['engine'], 'async evaluate must route through the extension engine').toBe('extension');
    // The payload wraps the resolved value in {value, type}. Shape may vary
    // slightly across extraction path versions — assert on the value content.
    const payloadStr = JSON.stringify(raw.payload);
    expect(payloadStr).toContain('resolved-42');
  }, 20000);

  it('still supports synchronous return values (no regression)', async () => {
    const raw = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return 1 + 2' },
      nextId(),
      10000,
    );
    expect(raw.meta?.['engine']).toBe('extension');
    const payloadStr = JSON.stringify(raw.payload);
    expect(payloadStr).toContain('3');
  }, 15000);

  it('resolves a Promise that awaits a microtask chain (realistic async work)', async () => {
    // Mimics the shape of real callers: fetch-like Promise chains, timers,
    // nested awaits. If the wrapper doesn't properly await, this returns
    // either "[object Promise]" or a DataCloneError.
    const raw = await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: `
          return new Promise(async (resolve) => {
            await Promise.resolve();
            await Promise.resolve();
            resolve({ level: 'deep', ok: true });
          })
        `,
      },
      nextId(),
      10000,
    );
    const payloadStr = JSON.stringify(raw.payload);
    expect(payloadStr).toContain('deep');
    expect(payloadStr).toContain('true');
  }, 15000);
});
