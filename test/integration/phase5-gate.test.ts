/**
 * Phase 5 Integration Gate
 *
 * Verifies that:
 *  1. All Phase 1-4 tools still registered (63 from before — regression guard)
 *  2. All 10 Phase 5 tools are registered
 *  3. safari_emergency_stop is registered
 *  4. Total tool count is 76 (63 + 10 + 1 + 2 [downloads + pdf])
 *  5. All tool names under 64-char MCP limit (mcp__safari__<name>)
 *  6. All tool names have safari_ prefix
 *  7. Emergency stop activates the kill switch
 *  8. Server initializes without error
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SafariPilotServer } from '../../src/server.js';

// ── Phase 1-4 baseline (63 tools) ─────────────────────────────────────────────

const PHASE_1_4_TOOLS = [
  // Navigation (7)
  'safari_navigate', 'safari_navigate_back', 'safari_navigate_forward',
  'safari_reload', 'safari_new_tab', 'safari_close_tab', 'safari_list_tabs',
  // Interaction (11)
  'safari_click', 'safari_double_click', 'safari_fill', 'safari_select_option',
  'safari_check', 'safari_hover', 'safari_type', 'safari_press_key',
  'safari_scroll', 'safari_drag', 'safari_handle_dialog',
  // Extraction (7)
  'safari_snapshot', 'safari_get_text', 'safari_get_html', 'safari_get_attribute',
  'safari_evaluate', 'safari_take_screenshot', 'safari_get_console_messages',
  // Network (8)
  'safari_list_network_requests', 'safari_get_network_request', 'safari_intercept_requests',
  'safari_network_throttle', 'safari_network_offline', 'safari_mock_request',
  'safari_websocket_listen', 'safari_websocket_filter',
  // Storage (11)
  'safari_get_cookies', 'safari_set_cookie', 'safari_delete_cookie',
  'safari_storage_state_export', 'safari_storage_state_import',
  'safari_local_storage_get', 'safari_local_storage_set',
  'safari_session_storage_get', 'safari_session_storage_set',
  'safari_idb_list', 'safari_idb_get',
  // Shadow (2)
  'safari_query_shadow', 'safari_click_shadow',
  // Frames (3)
  'safari_list_frames', 'safari_switch_frame', 'safari_eval_in_frame',
  // Permissions (6)
  'safari_permission_get', 'safari_permission_set',
  'safari_override_geolocation', 'safari_override_timezone',
  'safari_override_locale', 'safari_override_useragent',
  // Clipboard (2)
  'safari_clipboard_read', 'safari_clipboard_write',
  // Service Worker (2)
  'safari_sw_list', 'safari_sw_unregister',
  // Performance (3)
  'safari_begin_trace', 'safari_end_trace', 'safari_get_page_metrics',
  // Health (1)
  'safari_health_check',
];

// ── Phase 5 new tools ─────────────────────────────────────────────────────────

const PHASE_5_TOOLS = [
  // StructuredExtractionTools (5)
  'safari_smart_scrape',
  'safari_extract_tables',
  'safari_extract_links',
  'safari_extract_images',
  'safari_extract_metadata',
  // WaitTools (1)
  'safari_wait_for',
  // CompoundTools (4)
  'safari_test_flow',
  'safari_monitor_page',
  'safari_paginate_scrape',
  'safari_media_control',
];

const PHASE_6_TOOLS = [
  // DownloadTools (1)
  'safari_wait_for_download',
  // PdfTools (1)
  'safari_export_pdf',
];

const EMERGENCY_STOP = 'safari_emergency_stop';

const EXPECTED_TOTAL = PHASE_1_4_TOOLS.length + PHASE_5_TOOLS.length + 1 + PHASE_6_TOOLS.length; // 63 + 10 + 1 + 2 = 76

// ── Fixture ───────────────────────────────────────────────────────────────────

let server: SafariPilotServer;

beforeAll(async () => {
  server = new SafariPilotServer();
  await server.initialize();
});

afterAll(async () => {
  await server.shutdown();
});

// ── Gate 1: Server initializes without error ──────────────────────────────────

describe('Phase 5 Gate — Server initialization', () => {
  it('server instance exists after initialize()', () => {
    expect(server).toBeDefined();
    expect(server.getToolNames).toBeDefined();
  });

  it('session ID has sess_ prefix', () => {
    expect(server.getSessionId()).toMatch(/^sess_/);
  });
});

// ── Gate 2: Regression — All Phase 1-4 tools still registered ────────────────

describe('Phase 5 Gate — Regression: all Phase 1-4 tools still registered', () => {
  it('registers at least 63 prior tools', () => {
    const count = server.getToolNames().length;
    expect(count, `Expected >= 63 tools, got ${count}`).toBeGreaterThanOrEqual(63);
  });

  it('all 63 Phase 1-4 tools are still present', () => {
    const names = new Set(server.getToolNames());
    for (const tool of PHASE_1_4_TOOLS) {
      expect(names.has(tool), `Regression: Phase 1-4 tool "${tool}" is missing`).toBe(true);
    }
  });
});

// ── Gate 3: Phase 5 tools are registered ─────────────────────────────────────

describe('Phase 5 Gate — Phase 5 tools registered', () => {
  it('all 10 Phase 5 module tools are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of PHASE_5_TOOLS) {
      expect(names.has(tool), `Phase 5 tool "${tool}" is missing`).toBe(true);
    }
  });

  it('safari_emergency_stop is registered', () => {
    const names = new Set(server.getToolNames());
    expect(names.has(EMERGENCY_STOP), 'safari_emergency_stop is missing').toBe(true);
  });

  it('all Phase 6 tools (downloads + pdf) are registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of PHASE_6_TOOLS) {
      expect(names.has(tool), `Phase 6 tool "${tool}" is missing`).toBe(true);
    }
  });
});

// ── Gate 4: Total tool count ──────────────────────────────────────────────────

describe('Phase 5 Gate — Tool count', () => {
  it(`total tool count is ${EXPECTED_TOTAL}`, () => {
    expect(server.getToolNames().length).toBe(EXPECTED_TOTAL);
  });
});

// ── Gate 5: Tool name constraints ────────────────────────────────────────────

describe('Phase 5 Gate — Tool name constraints', () => {
  it('all tool names begin with safari_', () => {
    for (const name of server.getToolNames()) {
      expect(name, `"${name}" must start with safari_`).toMatch(/^safari_/);
    }
  });

  it('all namespaced tool names (mcp__safari__<name>) are <= 64 characters', () => {
    for (const name of server.getToolNames()) {
      const namespaced = `mcp__safari__${name}`;
      expect(
        namespaced.length,
        `"${namespaced}" (${namespaced.length} chars) exceeds 64-char limit`,
      ).toBeLessThanOrEqual(64);
    }
  });
});

// ── Gate 6: Emergency stop activates the kill switch ─────────────────────────

describe('Phase 5 Gate — Emergency stop', () => {
  it('calling safari_emergency_stop activates the kill switch', async () => {
    // Use a fresh server to avoid affecting other tests
    const s = new SafariPilotServer();
    await s.initialize();

    try {
      expect(s.killSwitch.isActive()).toBe(false);

      const result = await s.callTool('safari_emergency_stop', { reason: 'gate test' });
      const payload = JSON.parse(result.content[0]!.text as string);

      expect(payload.stopped).toBe(true);
      expect(payload.reason).toBe('gate test');
      expect(s.killSwitch.isActive()).toBe(true);
    } finally {
      s.killSwitch.deactivate();
      await s.shutdown();
    }
  });

  it('emergency stop uses default reason when none provided', async () => {
    const s = new SafariPilotServer();
    await s.initialize();

    try {
      const result = await s.callTool('safari_emergency_stop', {});
      const payload = JSON.parse(result.content[0]!.text as string);

      expect(payload.stopped).toBe(true);
      expect(payload.reason).toBe('emergency_stop called');
      expect(s.killSwitch.isActive()).toBe(true);
    } finally {
      s.killSwitch.deactivate();
      await s.shutdown();
    }
  });
});
