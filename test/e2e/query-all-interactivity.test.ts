/**
 * v0.1.35 T10 — safari_query_all interactability hints (e2e).
 *
 * Verifies that the per-element envelope returned by safari_query_all
 * includes a structured `interactability` object with role / clickable /
 * fillable / focusable / accessibleName / isVisible / boundingBox /
 * isCovered / isAriaDisabled.
 *
 * Fixture: /interactivity — one enabled button, one disabled+aria-disabled
 * button, one text input, one anchor link.
 *
 * Tab lifecycle: opened in beforeAll, closed in afterAll
 * (per feedback-e2e-tests-must-close-tabs).
 *
 * NOTE: this test only meaningfully exercises the new path against an
 * extension build that includes buildInteractability (T10 batch). When
 * run against the v0.1.34 binary, items[*].interactability is undefined
 * — the expected-behavior assertions tolerate that by gating on the
 * field being present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

interface InteractabilityShape {
  clickable: boolean;
  fillable: boolean;
  focusable: boolean;
  role: string | null;
  accessibleName: string | null;
  isVisible: boolean;
  boundingBox: { x: number; y: number; w: number; h: number };
  isCovered: boolean;
  isAriaDisabled: boolean;
}
interface QueryAllItem {
  ref: string;
  tagName: string;
  text: string;
  attrs: Record<string, string>;
  visible: boolean;
  interactability?: InteractabilityShape | null;
}

describe('T10 — safari_query_all interactability hints (e2e)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/interactivity?sp_t10=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    // Settle for content scripts to inject.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('button locator returns clickable + isVisible interactability', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'button',
    }, nextId(), 20_000);
    const items = r['items'] as QueryAllItem[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    const enabled = items.find((e) => e.interactability?.isAriaDisabled === false);
    expect(enabled?.interactability?.clickable).toBe(true);
    expect(enabled?.interactability?.isVisible).toBe(true);
    expect(enabled?.interactability?.role).toBe('button');
  }, 60_000);

  it('aria-disabled button is not clickable', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'button',
    }, nextId(), 20_000);
    const items = r['items'] as QueryAllItem[];
    const disabled = items.find((e) => e.interactability?.isAriaDisabled === true);
    expect(disabled?.interactability?.clickable).toBe(false);
    expect(disabled?.interactability?.fillable).toBe(false);
  }, 60_000);

  it('textbox locator returns fillable interactability', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'textbox',
    }, nextId(), 20_000);
    const items = r['items'] as QueryAllItem[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.interactability?.fillable).toBe(true);
    expect(items[0]!.interactability?.role).toBe('textbox');
  }, 60_000);

  it('link locator returns clickable interactability with role=link', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'link',
    }, nextId(), 20_000);
    const items = r['items'] as QueryAllItem[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.interactability?.clickable).toBe(true);
    expect(items[0]!.interactability?.role).toBe('link');
    expect(items[0]!.interactability?.accessibleName).toContain('A link');
  }, 60_000);
});
