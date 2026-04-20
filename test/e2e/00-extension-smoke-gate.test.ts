/**
 * Extension Engine Smoke Test — GATE
 *
 * This file MUST run before all other e2e tests (00- prefix forces alphabetical-first).
 * It proves the extension engine path works end-to-end: MCP → server → engine selector
 * → extension engine → daemon → extension background.js → content script → result.
 *
 * If ANY test fails here, the extension engine is broken. Do not proceed to Phase 2.
 *
 * Zero mocks. Zero source imports. Real process over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Extension Engine Smoke Gate', () => {
  let client: McpTestClient;
  let nextId: number;
  let tab1Url: string | undefined;
  let tab2Url: string | undefined;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30_000);

  afterAll(async () => {
    try {
      if (tab1Url && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: tab1Url }, nextId++, 10_000)
          .catch(() => {});
      }
      if (tab2Url && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: tab2Url }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  it('Test 1 — extension health reports ipcMechanism http', async () => {
    const result = await callTool(
      client,
      'safari_extension_health',
      {},
      nextId++,
      20_000,
    );

    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    expect(parsed['ipcMechanism']).toBe('http');
    expect(parsed['isConnected']).toBe(true);
  }, 90_000);

  it('Test 2 — simple JS execution through extension engine', async () => {
    // Use unique URL with timestamp to avoid stale tab cache collisions.
    // Safari's tab cache (persistent across extension restarts) may have
    // entries from previous test runs at the same URL. findTargetTab matches
    // the FIRST entry (oldest), which might be an orphaned tab.
    const uniqueUrl = `https://example.com/?e2e=smoke-t2&ts=${Date.now()}`;
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: uniqueUrl },
      nextId++,
      20_000,
    );
    tab1Url = tabResult['tabUrl'] as string;
    expect(tab1Url).toBeDefined();

    await new Promise(r => setTimeout(r, 3000));

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return document.title', tabUrl: tab1Url },
      nextId++,
      90_000,
    );

    expect(meta?.['engine']).toBe('extension');
    // handleEvaluate wraps script: return { value: __userResult, type: typeof __userResult }
    const evalResult = payload['value'] as Record<string, unknown> | string;
    const actualValue = typeof evalResult === 'object' && evalResult !== null ? evalResult['value'] : evalResult;
    expect(String(actualValue)).toContain('Example Domain');
  }, 90_000);

  it('Test 3 — complex result marshaling through extension', async () => {
    expect(tab1Url).toBeDefined();

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return JSON.stringify({a: 1, b: "hello", c: [1,2,3]})', tabUrl: tab1Url },
      nextId++,
      90_000,
    );

    expect(meta?.['engine']).toBe('extension');

    // Result comes as { value: <scriptResult>, type: "string" } from handleEvaluate wrapper
    const evalResult = payload['value'] as Record<string, unknown>;
    const value = typeof evalResult === 'object' ? evalResult['value'] : evalResult;
    expect(value).toBeDefined();
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    expect(parsed).toEqual({ a: 1, b: 'hello', c: [1, 2, 3] });
  }, 90_000);

  it('Test 4 — URL with query params (findTargetTab stress test)', async () => {
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com/?e2e=smoke&ts=12345' },
      nextId++,
      20_000,
    );
    tab2Url = tabResult['tabUrl'] as string;
    expect(tab2Url).toBeDefined();

    await new Promise(r => setTimeout(r, 3000));

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return document.title', tabUrl: tab2Url },
      nextId++,
      90_000,
    );

    expect(meta?.['engine']).toBe('extension');
    expect(payload['value']).toBeDefined();
  }, 90_000);

  it('Test 5 — sequential commands (no deadlock)', async () => {
    expect(tab1Url).toBeDefined();

    const { payload: p1, meta: m1 } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return 1 + 1', tabUrl: tab1Url },
      nextId++,
      90_000,
    );
    expect(m1?.['engine']).toBe('extension');
    // handleEvaluate wraps: { value: 2, type: "number" }
    const v1 = (p1['value'] as Record<string, unknown>)?.['value'] ?? p1['value'];
    expect(v1).toBe(2);

    const { payload: p2, meta: m2 } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return "hello" + " world"', tabUrl: tab1Url },
      nextId++,
      90_000,
    );
    expect(m2?.['engine']).toBe('extension');
    const v2 = (p2['value'] as Record<string, unknown>)?.['value'] ?? p2['value'];
    expect(v2).toBe('hello world');
  }, 90_000);
});
