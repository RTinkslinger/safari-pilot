/**
 * Phase 5A · 5A.3 — `safari_click` honors `button: 'left'|'right'|'middle'`
 * and `modifiers` against real Safari.
 *
 * Companion to test/unit/tools/click-button-modifiers.test.ts (which verifies
 * the GENERATED action-JS string). This e2e closes the loop end-to-end:
 * MCP → server → engine → Safari → real DOM event handlers fire.
 *
 * Fixture page registers listeners for mousedown/mouseup/click/auxclick/
 * contextmenu and pushes each fired event (with button + modifier flags) to
 * `window.__sp_5A3`. After each safari_click, we read that array via
 * safari_evaluate and assert the sequence matches the W3C UI Events spec for
 * the requested button.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

interface RecordedEvent {
  type: string;
  button: number;
  buttons: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

describe('5A.3 — safari_click button + modifiers (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/right-click.html?sp_t5A3=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    // Settle so content scripts inject and event listeners register.
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  async function clearAndClick(button: 'left' | 'right' | 'middle', modifiers?: string[]): Promise<RecordedEvent[]> {
    // Reset the recording array.
    await rawCallTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: 'window.__sp_5A3 = []; return null;',
    }, nextId(), 10_000);
    // Issue the click.
    const clickParams: Record<string, unknown> = {
      tabUrl: tabUrl!,
      selector: '#t5a3-target',
      button,
    };
    if (modifiers) clickParams['modifiers'] = modifiers;
    await callTool(client, 'safari_click', clickParams, nextId(), 15_000);
    // Brief settle so all dispatched events have run their listeners.
    await new Promise((r) => setTimeout(r, 200));
    // Read back.
    const r = await rawCallTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: 'return JSON.stringify(window.__sp_5A3 || []);',
    }, nextId(), 10_000);
    const raw = r.payload['value'] ?? r.payload['_rawText'];
    const json = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return JSON.parse(json) as RecordedEvent[];
  }

  it('button="right" fires mousedown, mouseup, contextmenu (button=2) — and NOT primary click', async () => {
    const events = await clearAndClick('right');
    const types = events.map((e) => e.type);
    expect(types, `recorded sequence: ${JSON.stringify(types)}`).toContain('mousedown');
    expect(types).toContain('mouseup');
    expect(types).toContain('contextmenu');
    expect(types).not.toContain('click');
    const ctx = events.find((e) => e.type === 'contextmenu');
    expect(ctx?.button, 'contextmenu must carry button=2').toBe(2);
  }, 60_000);

  it('button="middle" fires mousedown, mouseup, auxclick (button=1) — and NOT primary click or contextmenu', async () => {
    const events = await clearAndClick('middle');
    const types = events.map((e) => e.type);
    expect(types, `recorded sequence: ${JSON.stringify(types)}`).toContain('mousedown');
    expect(types).toContain('mouseup');
    expect(types).toContain('auxclick');
    expect(types).not.toContain('click');
    expect(types).not.toContain('contextmenu');
    const aux = events.find((e) => e.type === 'auxclick');
    expect(aux?.button, 'auxclick must carry button=1').toBe(1);
  }, 60_000);

  it('button="left" (default) fires mousedown, mouseup, click (button=0) — preserves prior behavior', async () => {
    const events = await clearAndClick('left');
    const types = events.map((e) => e.type);
    expect(types, `recorded sequence: ${JSON.stringify(types)}`).toContain('mousedown');
    expect(types).toContain('mouseup');
    expect(types).toContain('click');
    expect(types).not.toContain('contextmenu');
    expect(types).not.toContain('auxclick');
    const c = events.find((e) => e.type === 'click');
    expect(c?.button, 'click must carry button=0').toBe(0);
  }, 60_000);

  it('modifiers ["ctrl","shift"] reach the dispatched MouseEvent on the right-click', async () => {
    const events = await clearAndClick('right', ['ctrl', 'shift']);
    const ctx = events.find((e) => e.type === 'contextmenu');
    expect(ctx, `contextmenu event missing — sequence: ${JSON.stringify(events.map((e) => e.type))}`).toBeDefined();
    expect(ctx!.ctrlKey, 'ctrlKey must be true').toBe(true);
    expect(ctx!.shiftKey, 'shiftKey must be true').toBe(true);
    expect(ctx!.altKey, 'altKey must NOT be true (not in modifiers)').toBe(false);
    expect(ctx!.metaKey, 'metaKey must NOT be true (not in modifiers)').toBe(false);
  }, 60_000);
});
