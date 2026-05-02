/**
 * Phase 5A · 5A.4 — XPath as a first-class locator end-to-end through Safari.
 *
 * Companion to test/unit/locators/xpath-locator.test.ts. The unit suite
 * verifies the GENERATED resolution-body JS; this e2e closes the loop:
 * MCP → server → engine → real Safari → document.evaluate → element stamp →
 * tool action.
 *
 * Fixture: a button #xpath-target uniquely identified by its position in the
 * DOM (#not-target sits before it, both share `data-testid="conflict"`).
 * XPath `//button[@id="xpath-target"]` should resolve only to the second
 * one — even when testId is also passed (priority test).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('5A.4 — xpath locator (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/xpath-target.html?sp_t5A4=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('safari_get_text with xpath resolves the element document.evaluate finds', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      xpath: '//li[@class="middle"]',
    }, nextId(), 15_000);
    expect(r['text'], `text payload: ${JSON.stringify(r)}`).toContain('second');
  }, 60_000);

  it('safari_get_attribute with xpath returns the attribute of the matched node', async () => {
    const r = await callTool(client, 'safari_get_attribute', {
      tabUrl: tabUrl!,
      xpath: '//input[@type="text"]',
      attribute: 'placeholder',
    }, nextId(), 15_000);
    expect(r['value']).toBe('Enter email');
  }, 60_000);

  it('xpath wins over testId — the second button (id=xpath-target) is the resolved match, not the first', async () => {
    // Both #not-target and #xpath-target carry data-testid="conflict".
    // testId alone would resolve to the FIRST match (#not-target). xpath
    // takes priority and pins the second one.
    const r = await callTool(client, 'safari_get_attribute', {
      tabUrl: tabUrl!,
      xpath: '//button[@id="xpath-target"]',
      testId: 'conflict',
      attribute: 'id',
    }, nextId(), 15_000);
    expect(r['value'], `xpath should win — got id=${r['value']} (raw: ${JSON.stringify(r)})`).toBe('xpath-target');
  }, 60_000);

  it('malformed xpath surfaces as a typed error, not a SyntaxError leak', async () => {
    let caught: unknown = null;
    let payload: Record<string, unknown> | null = null;
    try {
      const r = await rawCallTool(client, 'safari_get_text', {
        tabUrl: tabUrl!,
        xpath: '//[this is invalid',
      }, nextId(), 15_000);
      payload = r.payload;
    } catch (e) {
      caught = e;
    }
    const errStr = caught
      ? (caught instanceof Error ? caught.message : JSON.stringify(caught))
      : JSON.stringify(payload);
    // The error must mention malformed xpath, not bubble up a raw DOMException.
    expect(errStr, `error/payload: ${errStr}`).toMatch(/[Mm]alformed.*[Xx][Pp]ath|XPath|invalid/i);
  }, 60_000);
});
