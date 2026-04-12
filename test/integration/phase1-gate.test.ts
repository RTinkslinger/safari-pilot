/**
 * Phase 1 Integration Gate
 *
 * Verifies that the SafariPilotServer wires all tool modules correctly and that
 * all P0 quality-gate contracts hold before Phase 2 work begins.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SafariPilotServer } from '../../src/server.js';
import { AuditLog } from '../../src/security/audit-log.js';
import { TabOwnership } from '../../src/security/tab-ownership.js';
import { TabNotOwnedError } from '../../src/errors.js';

// ── Expected tool inventory ───────────────────────────────────────────────────

const NAVIGATION_TOOLS = [
  'safari_navigate',
  'safari_navigate_back',
  'safari_navigate_forward',
  'safari_reload',
  'safari_new_tab',
  'safari_close_tab',
  'safari_list_tabs',
];

const INTERACTION_TOOLS = [
  'safari_click',
  'safari_double_click',
  'safari_fill',
  'safari_select_option',
  'safari_check',
  'safari_hover',
  'safari_type',
  'safari_press_key',
  'safari_scroll',
  'safari_drag',
];

const EXTRACTION_TOOLS = [
  'safari_snapshot',
  'safari_get_text',
  'safari_get_html',
  'safari_get_attribute',
  'safari_evaluate',
  'safari_take_screenshot',
  'safari_get_console_messages',
];

const NETWORK_TOOLS = [
  'safari_list_network_requests',
  'safari_get_network_request',
  'safari_intercept_requests',
];

const STORAGE_TOOLS = [
  'safari_get_cookies',
  'safari_set_cookie',
  'safari_delete_cookie',
  'safari_storage_state_export',
  'safari_storage_state_import',
];

const HEALTH_TOOLS = ['safari_health_check'];

const ALL_P0_TOOLS = [
  ...NAVIGATION_TOOLS,
  ...INTERACTION_TOOLS,
  ...EXTRACTION_TOOLS,
  ...NETWORK_TOOLS,
  ...STORAGE_TOOLS,
  ...HEALTH_TOOLS,
];

// ── Server fixture ────────────────────────────────────────────────────────────

async function makeServer(): Promise<SafariPilotServer> {
  const server = new SafariPilotServer();
  await server.initialize();
  return server;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Phase 1 Integration Gate — Server wiring', () => {
  let server: SafariPilotServer;

  beforeEach(async () => {
    server = await makeServer();
  });

  it('server instantiates and initializes without throwing', async () => {
    expect(server).toBeInstanceOf(SafariPilotServer);
    expect(server.getToolNames().length).toBeGreaterThan(0);
  });

  it('all 33 P0 tools are registered', () => {
    const names = new Set(server.getToolNames());
    expect(names.size).toBeGreaterThanOrEqual(33);
    for (const tool of ALL_P0_TOOLS) {
      expect(names.has(tool), `Tool "${tool}" should be registered`).toBe(true);
    }
  });

  it('all tool names follow the safari_ prefix convention', () => {
    for (const name of server.getToolNames()) {
      expect(name, `"${name}" must start with safari_`).toMatch(/^safari_/);
    }
  });

  it('all tool names are under 64 chars when namespaced as mcp__safari__<name>', () => {
    for (const name of server.getToolNames()) {
      const namespaced = `mcp__safari__${name}`;
      expect(namespaced.length, `"${namespaced}" exceeds 64 chars`).toBeLessThanOrEqual(64);
    }
  });

  it('all navigation tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of NAVIGATION_TOOLS) {
      expect(names.has(tool), `Navigation tool "${tool}" missing`).toBe(true);
    }
  });

  it('all interaction tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of INTERACTION_TOOLS) {
      expect(names.has(tool), `Interaction tool "${tool}" missing`).toBe(true);
    }
  });

  it('all extraction tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of EXTRACTION_TOOLS) {
      expect(names.has(tool), `Extraction tool "${tool}" missing`).toBe(true);
    }
  });

  it('all network tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of NETWORK_TOOLS) {
      expect(names.has(tool), `Network tool "${tool}" missing`).toBe(true);
    }
  });

  it('all storage tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of STORAGE_TOOLS) {
      expect(names.has(tool), `Storage tool "${tool}" missing`).toBe(true);
    }
  });

  it('unknown tool call throws with descriptive error', async () => {
    await expect(server.callTool('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
  });

  it('server provides a stable session ID', () => {
    const id = server.getSessionId();
    expect(id).toMatch(/^sess_/);
    expect(server.getSessionId()).toBe(id);
  });
});

describe('Phase 1 Integration Gate — ToolResponse shape', () => {
  let server: SafariPilotServer;

  beforeEach(async () => {
    server = await makeServer();
  });

  /**
   * The health check makes real osascript / screencapture calls (each capped at 3s).
   * Total budget: 3 checks × 3s + overhead = ~15s. We pass that as the test timeout.
   * The checks will succeed or fail gracefully depending on the environment;
   * what we're validating here is the ToolResponse *shape*, not the actual health status.
   */
  it('safari_health_check returns valid ToolResponse shape', { timeout: 60000 }, async () => {
    const response = await server.callTool('safari_health_check', {});

    // Top-level shape
    expect(response).toHaveProperty('content');
    expect(response).toHaveProperty('metadata');

    // content is a non-empty array
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);

    // first content item has type
    const firstItem = response.content[0];
    expect(firstItem).toHaveProperty('type');
    expect(['text', 'image']).toContain(firstItem.type);

    // metadata fields
    expect(response.metadata).toHaveProperty('engine');
    expect(response.metadata).toHaveProperty('degraded');
    expect(response.metadata).toHaveProperty('latencyMs');
    expect(typeof response.metadata.latencyMs).toBe('number');

    // health check specific: parseable JSON payload with required fields
    if (firstItem.type === 'text' && firstItem.text) {
      const payload = JSON.parse(firstItem.text);
      expect(payload).toHaveProperty('healthy');
      expect(payload).toHaveProperty('checks');
      expect(Array.isArray(payload.checks)).toBe(true);
      expect(payload).toHaveProperty('sessionId');
      // All 5 check names are present regardless of ok/fail status
      const checkNames = (payload.checks as Array<{ name: string }>).map((c) => c.name);
      expect(checkNames).toContain('safari_running');
      expect(checkNames).toContain('js_apple_events');
      expect(checkNames).toContain('screen_recording');
      expect(checkNames).toContain('daemon');
      expect(checkNames).toContain('extension');
    }
  }, 15_000); // 15s: 3 checks × 3s cap each + ample headroom
});

describe('Phase 1 Integration Gate — Tab ownership', () => {
  it('TabOwnership blocks operations on non-owned tabs', () => {
    const ownership = new TabOwnership();

    // Register some pre-existing tabs
    ownership.recordPreExisting(1001);
    ownership.recordPreExisting(1002);

    // Agent opens a new tab
    ownership.registerTab(2001, 'https://example.com/');

    // Agent-owned tab: should pass
    expect(() => ownership.assertOwnership(2001)).not.toThrow();

    // Pre-existing tab: should be blocked
    expect(() => ownership.assertOwnership(1001)).toThrow(TabNotOwnedError);

    // Unknown tab: should be blocked
    expect(() => ownership.assertOwnership(9999)).toThrow(TabNotOwnedError);
  });

  it('closing an agent-owned tab removes it from the registry', () => {
    const ownership = new TabOwnership();
    ownership.registerTab(2001, 'https://example.com/');

    expect(ownership.isOwned(2001)).toBe(true);
    ownership.removeTab(2001);
    expect(ownership.isOwned(2001)).toBe(false);

    // After removal, assertOwnership should throw
    expect(() => ownership.assertOwnership(2001)).toThrow(TabNotOwnedError);
  });

  it('URL updates are tracked for owned tabs only', () => {
    const ownership = new TabOwnership();
    ownership.registerTab(2001, 'https://example.com/');
    ownership.recordPreExisting(1001);

    // Owned tab URL update works
    ownership.updateUrl(2001, 'https://example.com/page2');
    expect(ownership.getUrl(2001)).toBe('https://example.com/page2');

    // Pre-existing tab update is a no-op (should not silently adopt foreign tabs)
    ownership.updateUrl(1001, 'https://evil.com/');
    expect(ownership.getUrl(1001)).toBeUndefined();
  });

  it('findByUrl resolves to the correct owned tab', () => {
    const ownership = new TabOwnership();
    ownership.registerTab(2001, 'https://example.com/');
    ownership.registerTab(2002, 'https://github.com/');

    expect(ownership.findByUrl('https://example.com/')).toBe(2001);
    expect(ownership.findByUrl('https://github.com/')).toBe(2002);
    expect(ownership.findByUrl('https://not-open.com/')).toBeUndefined();
  });
});

describe('Phase 1 Integration Gate — Audit log', () => {
  it('AuditLog records tool calls', () => {
    const log = new AuditLog();

    log.record({
      tool: 'safari_navigate',
      tabUrl: 'https://example.com/',
      engine: 'applescript',
      params: { url: 'https://example.com/', tabUrl: 'about:blank' },
      result: 'ok',
      elapsed_ms: 42,
      session: 'sess_test123',
    });

    const entries = log.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].tool).toBe('safari_navigate');
    expect(entries[0].result).toBe('ok');
    expect(entries[0].session).toBe('sess_test123');
    expect(entries[0].timestamp).toBeTruthy();
  });

  it('AuditLog redacts sensitive values', () => {
    const log = new AuditLog();

    log.record({
      tool: 'safari_fill',
      tabUrl: 'https://example.com/login',
      engine: 'applescript',
      params: { selector: '#password', value: 'super-secret-password' },
      result: 'ok',
      elapsed_ms: 15,
      session: 'sess_test123',
    });

    const entries = log.getEntries();
    expect(entries[0].params['value']).toBe('[REDACTED]');
    expect(entries[0].params['selector']).toBe('#password'); // non-sensitive field preserved
  });

  it('AuditLog can filter by session', () => {
    const log = new AuditLog();

    for (const session of ['sess_a', 'sess_b', 'sess_a']) {
      log.record({
        tool: 'safari_navigate',
        tabUrl: 'https://example.com/',
        engine: 'applescript',
        params: {},
        result: 'ok',
        elapsed_ms: 10,
        session,
      });
    }

    expect(log.getEntriesForSession('sess_a').length).toBe(2);
    expect(log.getEntriesForSession('sess_b').length).toBe(1);
    expect(log.getEntriesForSession('sess_c').length).toBe(0);
  });

  it('AuditLog enforces maxEntries FIFO eviction', () => {
    const log = new AuditLog({ maxEntries: 3 });

    for (let i = 0; i < 5; i++) {
      log.record({
        tool: `safari_navigate`,
        tabUrl: `https://example.com/${i}`,
        engine: 'applescript',
        params: { i },
        result: 'ok',
        elapsed_ms: i,
        session: 'sess_test',
      });
    }

    const entries = log.getEntries();
    expect(entries.length).toBe(3);
    // The last 3 entries should survive
    expect(entries[0].params['i']).toBe(2);
    expect(entries[2].params['i']).toBe(4);
  });

  it('AuditLog.getEntries respects the limit parameter', () => {
    const log = new AuditLog();

    for (let i = 0; i < 10; i++) {
      log.record({
        tool: 'safari_snapshot',
        tabUrl: 'https://example.com/',
        engine: 'applescript',
        params: { i },
        result: 'ok',
        elapsed_ms: 5,
        session: 'sess_test',
      });
    }

    expect(log.getEntries(3).length).toBe(3);
    expect(log.getEntries(10).length).toBe(10);
    expect(log.getEntries(100).length).toBe(10); // clamps to actual size
  });
});
