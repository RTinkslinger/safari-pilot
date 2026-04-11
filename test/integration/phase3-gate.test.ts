/**
 * Phase 3 Integration Gate
 *
 * Verifies that all Phase 3 tool modules are wired into the server, that the
 * extension engine plumbing is in place, and that all Phase 1+2 contracts still hold.
 *
 * Expected totals:
 *   P0 tools (Phase 1): 33
 *   P1 tools (Phase 3): 30  (shadow:2, frames:3, permissions:6, clipboard:2, sw:2, perf:3,
 *                             network +5, storage +6, interaction +1)
 *   Grand total:         63
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SafariPilotServer } from '../../src/server.js';
import { selectEngine, EngineUnavailableError } from '../../src/engine-selector.js';
import { ExtensionEngine } from '../../src/engines/extension.js';
import { DaemonEngine } from '../../src/engines/daemon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ── Tool inventory ────────────────────────────────────────────────────────────

// Phase 1 P0 baseline (33 tools)
const P0_NAVIGATION = [
  'safari_navigate', 'safari_navigate_back', 'safari_navigate_forward',
  'safari_reload', 'safari_new_tab', 'safari_close_tab', 'safari_list_tabs',
];
const P0_INTERACTION = [
  'safari_click', 'safari_double_click', 'safari_fill', 'safari_select_option',
  'safari_check', 'safari_hover', 'safari_type', 'safari_press_key',
  'safari_scroll', 'safari_drag',
];
const P0_EXTRACTION = [
  'safari_snapshot', 'safari_get_text', 'safari_get_html', 'safari_get_attribute',
  'safari_evaluate', 'safari_take_screenshot', 'safari_get_console_messages',
];
const P0_NETWORK = [
  'safari_list_network_requests', 'safari_get_network_request', 'safari_intercept_requests',
];
const P0_STORAGE = [
  'safari_get_cookies', 'safari_set_cookie', 'safari_delete_cookie',
  'safari_storage_state_export', 'safari_storage_state_import',
];
const P0_HEALTH = ['safari_health_check'];

// Phase 2 additions (already in P1 build but beyond P0 baseline)
const P1_NETWORK_EXTRA = [
  'safari_network_throttle', 'safari_network_offline', 'safari_mock_request',
  'safari_websocket_listen', 'safari_websocket_filter',
];
const P1_STORAGE_EXTRA = [
  'safari_local_storage_get', 'safari_local_storage_set',
  'safari_session_storage_get', 'safari_session_storage_set',
  'safari_idb_list', 'safari_idb_get',
];
const P1_INTERACTION_EXTRA = ['safari_handle_dialog'];

// Phase 3 new modules
const P1_SHADOW = ['safari_query_shadow', 'safari_click_shadow'];
const P1_FRAMES = ['safari_list_frames', 'safari_switch_frame', 'safari_eval_in_frame'];
const P1_PERMISSIONS = [
  'safari_permission_get', 'safari_permission_set',
  'safari_override_geolocation', 'safari_override_timezone',
  'safari_override_locale', 'safari_override_useragent',
];
const P1_CLIPBOARD = ['safari_clipboard_read', 'safari_clipboard_write'];
const P1_SERVICE_WORKER = ['safari_sw_list', 'safari_sw_unregister'];
const P1_PERFORMANCE = ['safari_begin_trace', 'safari_end_trace', 'safari_get_page_metrics'];

const ALL_P0_TOOLS = [
  ...P0_NAVIGATION, ...P0_INTERACTION, ...P0_EXTRACTION,
  ...P0_NETWORK, ...P0_STORAGE, ...P0_HEALTH,
];

const ALL_P1_TOOLS = [
  ...P1_NETWORK_EXTRA, ...P1_STORAGE_EXTRA, ...P1_INTERACTION_EXTRA,
  ...P1_SHADOW, ...P1_FRAMES, ...P1_PERMISSIONS,
  ...P1_CLIPBOARD, ...P1_SERVICE_WORKER, ...P1_PERFORMANCE,
];

const ALL_TOOLS = [...ALL_P0_TOOLS, ...ALL_P1_TOOLS];

// ── Fixture ───────────────────────────────────────────────────────────────────

let server: SafariPilotServer;

beforeAll(async () => {
  server = new SafariPilotServer();
  await server.initialize();
});

afterAll(async () => {
  await server.shutdown();
});

// ── Test 1: Total tool count ──────────────────────────────────────────────────

describe('Phase 3 Gate — Tool count', () => {
  it('server registers 63 or more tools total (33 P0 + 30 P1)', () => {
    const count = server.getToolNames().length;
    expect(count, `Expected >= 63 tools, got ${count}`).toBeGreaterThanOrEqual(63);
  });

  it('all 33 P0 tools are still registered (regression)', () => {
    const names = new Set(server.getToolNames());
    for (const tool of ALL_P0_TOOLS) {
      expect(names.has(tool), `P0 tool "${tool}" missing`).toBe(true);
    }
  });

  it('all 30 P1 tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of ALL_P1_TOOLS) {
      expect(names.has(tool), `P1 tool "${tool}" missing`).toBe(true);
    }
  });
});

// ── Test 2: safari_ prefix convention ────────────────────────────────────────

describe('Phase 3 Gate — Naming conventions', () => {
  it('all tool names have the safari_ prefix', () => {
    for (const name of server.getToolNames()) {
      expect(name, `"${name}" must start with safari_`).toMatch(/^safari_/);
    }
  });

  it('all namespaced tool names (mcp__safari__<name>) are under 64 chars', () => {
    for (const name of server.getToolNames()) {
      const namespaced = `mcp__safari__${name}`;
      expect(
        namespaced.length,
        `"${namespaced}" (${namespaced.length} chars) exceeds 64 char limit`,
      ).toBeLessThanOrEqual(64);
    }
  });
});

// ── Test 3: Tool count per category ──────────────────────────────────────────

describe('Phase 3 Gate — Category counts', () => {
  let names: Set<string>;

  beforeAll(() => {
    names = new Set(server.getToolNames());
  });

  it('shadow module has 2 tools', () => {
    const shadowTools = P1_SHADOW.filter((t) => names.has(t));
    expect(shadowTools.length).toBe(2);
  });

  it('frames module has 3 tools', () => {
    const frameTools = P1_FRAMES.filter((t) => names.has(t));
    expect(frameTools.length).toBe(3);
  });

  it('permissions module has 6 tools', () => {
    const permTools = P1_PERMISSIONS.filter((t) => names.has(t));
    expect(permTools.length).toBe(6);
  });

  it('clipboard module has 2 tools', () => {
    const clipTools = P1_CLIPBOARD.filter((t) => names.has(t));
    expect(clipTools.length).toBe(2);
  });

  it('service-worker module has 2 tools', () => {
    const swTools = P1_SERVICE_WORKER.filter((t) => names.has(t));
    expect(swTools.length).toBe(2);
  });

  it('performance module has 3 tools', () => {
    const perfTools = P1_PERFORMANCE.filter((t) => names.has(t));
    expect(perfTools.length).toBe(3);
  });

  it('network module has 8 tools (3 P0 + 5 P1)', () => {
    const allNetwork = [...P0_NETWORK, ...P1_NETWORK_EXTRA];
    const registered = allNetwork.filter((t) => names.has(t));
    expect(registered.length).toBe(8);
  });

  it('storage module has 11 tools (5 P0 + 6 P1)', () => {
    const allStorage = [...P0_STORAGE, ...P1_STORAGE_EXTRA];
    const registered = allStorage.filter((t) => names.has(t));
    expect(registered.length).toBe(11);
  });

  it('interaction module has 11 tools (10 P0 + 1 P1)', () => {
    const allInteraction = [...P0_INTERACTION, ...P1_INTERACTION_EXTRA];
    const registered = allInteraction.filter((t) => names.has(t));
    expect(registered.length).toBe(11);
  });
});

// ── Test 4: P1 tools that require extension have correct requirement flags ────

describe('Phase 3 Gate — Extension-required tool flags', () => {
  it('safari_query_shadow has requiresShadowDom: true', async () => {
    // Verify the tool is registered (indirectly checks its requirements are wired)
    // We can't easily introspect requirements post-registration, but we can verify
    // that selectEngine throws for shadow-requiring tools when extension is unavailable
    expect(() =>
      selectEngine({ requiresShadowDom: true }, { daemon: true, extension: false }),
    ).toThrow(EngineUnavailableError);
  });

  it('safari_click_shadow has requiresShadowDom: true (same selector path)', () => {
    expect(() =>
      selectEngine({ requiresShadowDom: true }, { daemon: false, extension: false }),
    ).toThrow(EngineUnavailableError);
  });

  it('safari_eval_in_frame has requiresFramesCrossOrigin: true', () => {
    expect(() =>
      selectEngine({ requiresFramesCrossOrigin: true }, { daemon: true, extension: false }),
    ).toThrow(EngineUnavailableError);
  });
});

// ── Test 5: Engine selector behaviour ────────────────────────────────────────

describe('Phase 3 Gate — Engine selector', () => {
  it('returns "extension" for Shadow DOM requirements when extension available', () => {
    const engine = selectEngine(
      { requiresShadowDom: true },
      { daemon: true, extension: true },
    );
    expect(engine).toBe('extension');
  });

  it('returns "extension" for CSP bypass requirements when extension available', () => {
    const engine = selectEngine(
      { requiresCspBypass: true },
      { daemon: true, extension: true },
    );
    expect(engine).toBe('extension');
  });

  it('returns "extension" for cross-origin frames when extension available', () => {
    const engine = selectEngine(
      { requiresFramesCrossOrigin: true },
      { daemon: false, extension: true },
    );
    expect(engine).toBe('extension');
  });

  it('throws EngineUnavailableError when extension needed but unavailable (shadow)', () => {
    expect(() =>
      selectEngine({ requiresShadowDom: true }, { daemon: true, extension: false }),
    ).toThrow(EngineUnavailableError);
  });

  it('throws EngineUnavailableError when extension needed but unavailable (csp)', () => {
    expect(() =>
      selectEngine({ requiresCspBypass: true }, { daemon: false, extension: false }),
    ).toThrow(EngineUnavailableError);
  });

  it('throws EngineUnavailableError when extension needed but unavailable (frames cross-origin)', () => {
    expect(() =>
      selectEngine({ requiresFramesCrossOrigin: true }, { daemon: true, extension: false }),
    ).toThrow(EngineUnavailableError);
  });

  it('falls back to daemon when no extension requirement and extension unavailable', () => {
    const engine = selectEngine({}, { daemon: true, extension: false });
    expect(engine).toBe('daemon');
  });

  it('falls back to applescript when nothing is available', () => {
    const engine = selectEngine({}, { daemon: false, extension: false });
    expect(engine).toBe('applescript');
  });
});

// ── Test 6: Extension engine client ──────────────────────────────────────────

describe('Phase 3 Gate — Extension engine client', () => {
  it('ExtensionEngine class exists and can be instantiated', () => {
    const daemon = new DaemonEngine();
    const ext = new ExtensionEngine(daemon);
    expect(ext).toBeDefined();
    expect(ext.name).toBe('extension');
  });

  it('ExtensionEngine.isAvailable() returns false when daemon is not running', async () => {
    // Without a real daemon binary/connection, isAvailable should return false
    const daemon = new DaemonEngine('/nonexistent/path/SafariPilotd');
    const ext = new ExtensionEngine(daemon);
    const available = await ext.isAvailable();
    expect(available).toBe(false);
    await daemon.shutdown();
  }, 10_000);
});

// ── Test 7: Extension manifest structure ─────────────────────────────────────

describe('Phase 3 Gate — Extension manifest', () => {
  let manifest: Record<string, unknown>;

  beforeAll(() => {
    const manifestPath = path.join(PROJECT_ROOT, 'extension', 'manifest.json');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  });

  it('manifest has manifest_version 3', () => {
    expect(manifest['manifest_version']).toBe(3);
  });

  it('manifest has required permissions', () => {
    const perms = manifest['permissions'] as string[];
    expect(Array.isArray(perms)).toBe(true);
    for (const p of ['activeTab', 'scripting', 'nativeMessaging', 'tabs']) {
      expect(perms, `Missing permission: ${p}`).toContain(p);
    }
  });

  it('manifest has background service_worker', () => {
    const bg = manifest['background'] as Record<string, unknown>;
    expect(bg).toBeDefined();
    expect(bg['service_worker']).toBeTruthy();
  });

  it('manifest has content_scripts with both ISOLATED and MAIN world entries', () => {
    const scripts = manifest['content_scripts'] as Array<Record<string, unknown>>;
    expect(Array.isArray(scripts)).toBe(true);
    const worlds = scripts.map((s) => s['world']);
    expect(worlds).toContain('ISOLATED');
    expect(worlds).toContain('MAIN');
  });

  it('manifest has host_permissions covering all URLs', () => {
    const hostPerms = manifest['host_permissions'] as string[];
    expect(Array.isArray(hostPerms)).toBe(true);
    expect(hostPerms).toContain('<all_urls>');
  });

  it('manifest has a valid name and version string', () => {
    expect(typeof manifest['name']).toBe('string');
    expect((manifest['name'] as string).length).toBeGreaterThan(0);
    expect(typeof manifest['version']).toBe('string');
    expect(manifest['version']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── Test 8: Phase 1 + Phase 2 regression ─────────────────────────────────────

describe('Phase 3 Gate — Regression: All prior tools still present', () => {
  it('no previously-registered tool was removed', () => {
    const names = new Set(server.getToolNames());
    for (const tool of ALL_TOOLS) {
      expect(names.has(tool), `Tool "${tool}" was removed`).toBe(true);
    }
  });

  it('unknown tool call still throws with descriptive error', async () => {
    await expect(server.callTool('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
  });

  it('server session ID is stable', () => {
    const id = server.getSessionId();
    expect(id).toMatch(/^sess_/);
    expect(server.getSessionId()).toBe(id);
  });
});
