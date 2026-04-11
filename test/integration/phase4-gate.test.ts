/**
 * Phase 4 Integration Gate
 *
 * Verifies that:
 *  1. All Phase 1-3 tools still registered (regression)
 *  2. Server has all 7 security layers initialized
 *  3. All 63 tools still registered
 *  4. Security pipeline executes in correct order
 *  5. All tool names are under 64 chars (mcp__safari__ prefix included)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SafariPilotServer } from '../../src/server.js';
import { KillSwitchActiveError, CircuitBreakerOpenError, RateLimitedError } from '../../src/errors.js';

// ── Full tool list (Phase 1-3, 63 tools) ─────────────────────────────────────

const ALL_TOOLS = [
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

// ── Fixture ───────────────────────────────────────────────────────────────────

let server: SafariPilotServer;

beforeAll(async () => {
  server = new SafariPilotServer();
  await server.initialize();
});

afterAll(async () => {
  await server.shutdown();
});

// ── Gate 1: Regression — All Phase 1-3 tools still registered ─────────────────

describe('Phase 4 Gate — Regression: all prior tools still registered', () => {
  it('registers 63 or more tools in total', () => {
    const count = server.getToolNames().length;
    expect(count, `Expected >= 63 tools, got ${count}`).toBeGreaterThanOrEqual(63);
  });

  it('all 63 Phase 1-3 tools are still registered', () => {
    const names = new Set(server.getToolNames());
    for (const tool of ALL_TOOLS) {
      expect(names.has(tool), `Tool "${tool}" is missing after Phase 4 changes`).toBe(true);
    }
  });

  it('unknown tool call still throws with descriptive error', async () => {
    await expect(server.callTool('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
  });
});

// ── Gate 2: Security layers are initialized on the server ─────────────────────

describe('Phase 4 Gate — Security layers initialized', () => {
  it('server exposes a KillSwitch instance', () => {
    expect(server.killSwitch).toBeDefined();
    expect(typeof server.killSwitch.checkBeforeAction).toBe('function');
    expect(typeof server.killSwitch.isActive).toBe('function');
  });

  it('server exposes a TabOwnership instance', () => {
    expect(server.tabOwnership).toBeDefined();
    expect(typeof server.tabOwnership.registerTab).toBe('function');
    expect(typeof server.tabOwnership.assertOwnership).toBe('function');
  });

  it('server exposes an AuditLog instance', () => {
    expect(server.auditLog).toBeDefined();
    expect(typeof server.auditLog.record).toBe('function');
    expect(typeof server.auditLog.getEntries).toBe('function');
  });

  it('server exposes a DomainPolicy instance', () => {
    expect(server.domainPolicy).toBeDefined();
    expect(typeof server.domainPolicy.evaluate).toBe('function');
  });

  it('server exposes a RateLimiter instance', () => {
    expect(server.rateLimiter).toBeDefined();
    expect(typeof server.rateLimiter.checkLimit).toBe('function');
    expect(typeof server.rateLimiter.recordAction).toBe('function');
  });

  it('server exposes a CircuitBreaker instance', () => {
    expect(server.circuitBreaker).toBeDefined();
    expect(typeof server.circuitBreaker.isOpen).toBe('function');
    expect(typeof server.circuitBreaker.recordSuccess).toBe('function');
  });

  it('server exposes an IdpiScanner instance', () => {
    expect(server.idpiScanner).toBeDefined();
    expect(typeof server.idpiScanner.scan).toBe('function');
  });
});

// ── Gate 3: All 63 tools still registered (explicit count check) ──────────────

describe('Phase 4 Gate — Tool count', () => {
  it('tool count is exactly 63', () => {
    expect(server.getToolNames().length).toBe(63);
  });

  it('all tool names begin with safari_', () => {
    for (const name of server.getToolNames()) {
      expect(name, `"${name}" must start with safari_`).toMatch(/^safari_/);
    }
  });
});

// ── Gate 4: Security pipeline executes in correct order ───────────────────────

describe('Phase 4 Gate — Security pipeline order', () => {
  it('executeToolWithSecurity exists on the server', () => {
    expect(typeof server.executeToolWithSecurity).toBe('function');
  });

  it('kill switch blocks execution before any tool logic runs', async () => {
    server.killSwitch.activate('gate test — kill switch');
    try {
      await expect(
        server.executeToolWithSecurity('safari_health_check', {}),
      ).rejects.toThrow(KillSwitchActiveError);
    } finally {
      server.killSwitch.deactivate();
    }
  });

  it('rate limiter blocks execution when domain quota is exhausted', async () => {
    // Use a fresh server to avoid shared state side effects
    const s = new SafariPilotServer();
    await s.initialize();

    try {
      // Set a very low per-domain limit so we can exhaust it without real tool calls
      s.rateLimiter.setDomainLimit('example.com', 0);

      // checkLimit with limit 0 means allowed:false immediately
      const check = s.rateLimiter.checkLimit('example.com');
      expect(check.allowed).toBe(false);

      // executeToolWithSecurity should throw RateLimitedError because checkLimit fails
      await expect(
        s.executeToolWithSecurity('safari_navigate', { url: 'https://example.com' }),
      ).rejects.toThrow(RateLimitedError);
    } finally {
      await s.shutdown();
    }
  });

  it('circuit breaker blocks execution after repeated domain failures', async () => {
    const s = new SafariPilotServer();
    await s.initialize();

    try {
      // Manually trip the circuit breaker for a domain
      for (let i = 0; i < 5; i++) {
        s.circuitBreaker.recordFailure('tripped.com');
      }
      expect(s.circuitBreaker.isOpen('tripped.com')).toBe(true);

      // executeToolWithSecurity should throw CircuitBreakerOpenError
      await expect(
        s.executeToolWithSecurity('safari_navigate', { url: 'https://tripped.com/page' }),
      ).rejects.toThrow(CircuitBreakerOpenError);
    } finally {
      await s.shutdown();
    }
  });

  it('successful tool calls are recorded in the audit log', async () => {
    const s = new SafariPilotServer();
    await s.initialize();

    // Intercept callTool so we don't need a real Safari instance
    const originalCallTool = s.callTool.bind(s);
    s.callTool = async (name, params) => {
      if (name === 'safari_health_check') {
        return {
          content: [{ type: 'text', text: '{"healthy":true}' }],
          metadata: { engine: 'applescript', degraded: false, latencyMs: 0 },
        };
      }
      return originalCallTool(name, params);
    };

    try {
      await s.executeToolWithSecurity('safari_health_check', {});
      const entries = s.auditLog.getEntries();
      expect(entries.length).toBeGreaterThan(0);
      const entry = entries.find((e) => e.tool === 'safari_health_check');
      expect(entry).toBeDefined();
      expect(entry!.result).toBe('ok');
    } finally {
      await s.shutdown();
    }
  });
});

// ── Gate 5: Tool names under 64 chars with mcp__safari__ prefix ───────────────

describe('Phase 4 Gate — Tool name length constraint', () => {
  it('all namespaced tool names (mcp__safari__<name>) are <= 64 characters', () => {
    for (const name of server.getToolNames()) {
      const namespaced = `mcp__safari__${name}`;
      expect(
        namespaced.length,
        `"${namespaced}" (${namespaced.length} chars) exceeds 64-char limit`,
      ).toBeLessThanOrEqual(64);
    }
  });

  it('session ID still has the sess_ prefix (regression)', () => {
    expect(server.getSessionId()).toMatch(/^sess_/);
  });
});
