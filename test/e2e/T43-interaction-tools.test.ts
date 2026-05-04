/**
 * T43 — e2e coverage for interaction tools (the ones not exercised by phase3).
 *
 * Covers (one tool per assertion, real Safari, real MCP):
 *   safari_hover
 *   safari_double_click
 *   safari_drag
 *   safari_press_key
 *   safari_type
 *   safari_select_option
 *   safari_scroll
 *   safari_check
 *
 * Fixture page exposes target elements and event listeners that record into
 * `window.__t43_int = []`. Each test asserts the expected event landed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

interface RecordedEvent {
  type: string;
  detail?: number;
  key?: string;
  selectedValue?: string;
  scrollY?: number;
  checked?: boolean;
}

describe('T43 — interaction tools (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string;

  async function readEvents(): Promise<RecordedEvent[]> {
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return JSON.stringify(window.__t43_int || []);' },
      nextId(),
      10_000,
    );
    const raw = (r.payload['value'] ?? r.payload['_rawText']) as string | undefined;
    if (!raw) return [];
    try { return JSON.parse(raw) as RecordedEvent[]; } catch { return []; }
  }

  async function clearEvents(): Promise<void> {
    await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'window.__t43_int = []; return null;' },
      nextId(),
      10_000,
    );
  }

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    const target = `http://127.0.0.1:${fixture.hostPort}/t43-interaction?sp_t43=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId());
    tabUrl = tab.tabUrl as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 35_000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  });

  it('safari_hover triggers a mouseover event on the target', async () => {
    await clearEvents();
    await callTool(client, 'safari_hover', { tabUrl, selector: '#t43-hover' }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 200));
    const events = await readEvents();
    const types = events.map((e) => e.type);
    expect(types, `recorded events: ${JSON.stringify(types)}`).toContain('mouseover');
  }, 25_000);

  it('safari_double_click triggers a dblclick event on the target', async () => {
    await clearEvents();
    await callTool(client, 'safari_double_click', { tabUrl, selector: '#t43-dblclick' }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 200));
    const events = await readEvents();
    const types = events.map((e) => e.type);
    expect(types, `recorded events: ${JSON.stringify(types)}`).toContain('dblclick');
  }, 25_000);

  it('safari_drag triggers drag-related events on source and target', async () => {
    await clearEvents();
    await callTool(
      client,
      'safari_drag',
      { tabUrl, sourceSelector: '#t43-drag-src', targetSelector: '#t43-drag-tgt' },
      nextId(),
      15_000,
    );
    await new Promise((r) => setTimeout(r, 300));
    const events = await readEvents();
    const types = events.map((e) => e.type);
    // The implementation may use mousedown→mousemove→mouseup OR HTML5
    // dragstart→drop events. Either is a valid implementation; we assert
    // that the source dispatched some drag/mouse-down signal.
    expect(
      types.some((t) => t === 'mousedown' || t === 'dragstart'),
      `expected mousedown or dragstart on the source. recorded: ${JSON.stringify(types)}`,
    ).toBe(true);
  }, 25_000);

  it('safari_press_key dispatches a keydown event with the requested key', async () => {
    await clearEvents();
    await callTool(client, 'safari_press_key', { tabUrl, key: 'a' }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 200));
    const events = await readEvents();
    const keydown = events.find((e) => e.type === 'keydown');
    expect(keydown, `expected keydown in: ${JSON.stringify(events)}`).toBeDefined();
    expect(keydown!.key).toBe('a');
  }, 25_000);

  it('safari_type fills text into the targeted input', async () => {
    // Reset value first so prior runs don't pollute.
    await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'document.getElementById("t43-type").value = ""; return null;' },
      nextId(),
      10_000,
    );
    await callTool(
      client,
      'safari_type',
      { tabUrl, selector: '#t43-type', content: 'hello' },
      nextId(),
      15_000,
    );
    await new Promise((r) => setTimeout(r, 300));
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.getElementById("t43-type").value;' },
      nextId(),
      10_000,
    );
    const val = (r.payload['value'] ?? r.payload['_rawText']) as string | undefined;
    expect(val, `safari_type result: ${JSON.stringify(r.payload)}`).toBe('hello');
  }, 25_000);

  it('safari_select_option selects the requested <option>', async () => {
    await clearEvents();
    await callTool(
      client,
      'safari_select_option',
      { tabUrl, selector: '#t43-select', optionValue: 'beta' },
      nextId(),
      15_000,
    );
    await new Promise((r) => setTimeout(r, 200));
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.getElementById("t43-select").value;' },
      nextId(),
      10_000,
    );
    const val = (r.payload['value'] ?? r.payload['_rawText']) as string | undefined;
    expect(val).toBe('beta');
  }, 25_000);

  it('safari_scroll changes window.scrollY', async () => {
    // Initial scrollY = 0 (page just loaded).
    await callTool(client, 'safari_scroll', { tabUrl, direction: 'down', amount: 500 }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 300));
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return window.scrollY;' },
      nextId(),
      10_000,
    );
    const yRaw = r.payload['value'] ?? r.payload['_rawText'];
    const y = typeof yRaw === 'number' ? yRaw : parseInt(String(yRaw), 10);
    expect(y, `expected scrollY > 0 after scroll-down; got ${y}`).toBeGreaterThan(0);
  }, 25_000);

  it('safari_check toggles a checkbox to checked state', async () => {
    // Start unchecked, check it, verify.
    await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'document.getElementById("t43-check").checked = false; return null;' },
      nextId(),
      10_000,
    );
    await callTool(client, 'safari_check', { tabUrl, selector: '#t43-check' }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 200));
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.getElementById("t43-check").checked;' },
      nextId(),
      10_000,
    );
    const checked = (r.payload['value'] ?? r.payload['_rawText']) as boolean | string | undefined;
    expect(checked === true || checked === 'true', `expected checked=true, got ${checked}`).toBe(true);
  }, 25_000);
});
