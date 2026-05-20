/**
 * v0.1.37 Bug-MCP-1 — production verification.
 *
 * The unit suite at test/unit/tools/safari-evaluate-contract.test.ts proves
 * wrapEvaluateScript's algorithm under Node's `new Function`. That's
 * necessary but not sufficient: production runs the wrapped string through
 * the extension bridge into a real Safari page context, where CSP, Trusted
 * Types, and the content-main / content-isolated postMessage envelope
 * apply. This e2e probe exercises the SHIPPED architecture:
 *
 *   handleEvaluate → wrapEvaluateScript → engine.executeJsInTab
 *     → ExtensionEngine HTTP/storage bus
 *     → content-isolated postMessage
 *     → content-main injected `await fn()` execution
 *     → result postMessage back
 *     → SP_RESULT envelope
 *
 * Three script shapes are tested. Pre-fix all returned `{type:"undefined"}`.
 * Post-fix all must return the actual value:
 *   1. Bare expression                  — `document.title`
 *   2. Self-invoked arrow IIFE          — `(() => "ok")()`
 *   3. JSON.stringify expression        — `JSON.stringify({a: 1})`
 *
 * One body-path back-compat case is also included:
 *   4. Multi-statement with return      — `const x = 7; return x;`
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('Bug-MCP-1: safari_evaluate accepts bare expressions / IIFEs in production', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const unique = `https://example.com/?sp_bugMcp1=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl as string;
    // Wait for content script injection.
    await new Promise((r) => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* noop */ }
    }
  });

  it('bare expression `document.title` returns the page title, not undefined', async () => {
    const result = await callTool(client, 'safari_evaluate', {
      tabUrl,
      script: 'document.title',
    }, nextId());
    // example.com page title is "Example Domain".
    expect(result.type).toBe('string');
    expect(result.value).toBe('Example Domain');
  });

  it('self-invoked arrow IIFE returns its inner value, not undefined', async () => {
    const result = await callTool(client, 'safari_evaluate', {
      tabUrl,
      script: '(() => "ok")()',
    }, nextId());
    expect(result.type).toBe('string');
    expect(result.value).toBe('ok');
  });

  it('JSON.stringify expression returns the JSON string, not undefined', async () => {
    const result = await callTool(client, 'safari_evaluate', {
      tabUrl,
      script: 'JSON.stringify({a: 1, b: "x"})',
    }, nextId());
    expect(result.type).toBe('string');
    expect(result.value).toBe('{"a":1,"b":"x"}');
  });

  it('multi-statement script with top-level return preserves back-compat', async () => {
    const result = await callTool(client, 'safari_evaluate', {
      tabUrl,
      script: 'const x = 7; return x * 6;',
    }, nextId());
    expect(result.type).toBe('number');
    expect(result.value).toBe(42);
  });
});
