/**
 * Extension Background Script — Event-Page Source Checks
 *
 * background.js runs inside Safari's extension sandbox — we can't execute it
 * in Node. These tests verify the source code follows the MV3 event-page
 * contract (persistent:false): no IIFE, no ES module syntax, listeners at top
 * level, storage-backed queue, drain-on-wake sequence, alarm keepalive.
 *
 * After the commit 1a event-page pivot, the previous service-worker-polling
 * assertions (IIFE wrapper, pollForCommands, POLL_IDLE_MS, response.value.command)
 * are REMOVED — those patterns are incompatible with event-page lifecycle.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const BG = readFileSync(resolve(ROOT, 'extension/background.js'), 'utf-8');

describe('Extension background.js — event-page form', () => {
  it('has no IIFE wrapper at top', () => {
    const firstCode = BG.split('\n').find(
      (l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('/*')
    );
    expect(firstCode).not.toMatch(/^\(function/);
  });

  it('has no ES module syntax', () => {
    expect(BG).not.toMatch(/^import\s/m);
    expect(BG).not.toMatch(/^export\s/m);
  });

  it('has HTTP poll loop (commit 2, replaces native message chain)', () => {
    expect(BG).toMatch(/pollLoop/);
    expect(BG).not.toMatch(/pollForCommands/);
    expect(BG).not.toMatch(/switchToActivePolling/);
    expect(BG).not.toMatch(/switchToIdlePolling/);
    expect(BG).not.toMatch(/nativeMessageChain/);
    expect(BG).not.toMatch(/POLL_IDLE_MS/);
    expect(BG).not.toMatch(/POLL_ACTIVE_MS/);
  });

  it('has wake sequence + storage-backed queue', () => {
    expect(BG).toMatch(/storage\.local/);
    expect(BG).toMatch(/STORAGE_KEY_PENDING|pending_commands/);
    expect(BG).toMatch(/browser\.runtime\.onStartup\.addListener/);
    expect(BG).toMatch(/browser\.runtime\.onInstalled\.addListener/);
    expect(BG).toMatch(/browser\.alarms\.onAlarm\.addListener/);
  });

  it('listenersAttached idempotency flag present', () => {
    expect(BG).toMatch(/listenersAttached/);
  });

  it('alarm keepalive present', () => {
    expect(BG).toMatch(/keepalive/);
    expect(BG).toMatch(/browser\.alarms\.create/);
  });

  it('reconcile protocol present (commit 2)', () => {
    expect(BG).toMatch(/reconcile/);
    expect(BG).toMatch(/handleReconcileResponse/);
  });

  it('line count within <=390 target (HTTP poll rewrite + audit fixes)', () => {
    const lines = BG.split('\n').length;
    expect(lines).toBeLessThanOrEqual(390);
  });

  it('uses HTTP fetch for daemon communication (commit 2)', () => {
    expect(BG).toMatch(/fetch\(/);
    expect(BG).toMatch(/127\.0\.0\.1:19475/);
  });
});

describe('background.js — preserved protocol invariants', () => {
  it('uses HTTP fetch (no sendNativeMessage, no connectNative)', () => {
    expect(BG).not.toContain('browser.runtime.sendNativeMessage');
    expect(BG).not.toContain('connectNative');
    expect(BG).toContain('fetch(');
  });

  it('targets the correct bundle ID', () => {
    expect(BG).toContain("'com.safari-pilot.app'");
  });

  it("connects and reconciles on wake (commit 2)", () => {
    expect(BG).toMatch(/connectAndReconcile/);
    expect(BG).toMatch(/\/connect/);
  });

  it("sends reconcile on connect (commit 2)", () => {
    expect(BG).toMatch(/connectAndReconcile/);
  });

  it("sends results via HTTP postResult (commit 2)", () => {
    expect(BG).toMatch(/postResult/);
    expect(BG).toMatch(/\/result/);
  });

  it('uses browser.scripting.executeScript with MAIN world as fallback', () => {
    expect(BG).toContain('browser.scripting.executeScript');
    expect(BG).toContain("world: 'MAIN'");
  });

  it('queries all tabs + normalizes trailing slash for URL match', () => {
    expect(BG).toContain('browser.tabs.query({})');
    expect(BG).toMatch(/replace\s*\(\s*\/\\\/\$\/\s*,\s*''\s*\)/);
  });

  it('falls back to active tab when no URL match', () => {
    expect(BG).toContain('active: true, currentWindow: true');
  });
});

describe('background.js — preserved handlers', () => {
  it('preserves cookie handlers', () => {
    expect(BG).toMatch(/handleCookieGet\b/);
    expect(BG).toMatch(/handleCookieSet\b/);
    expect(BG).toMatch(/handleCookieRemove\b/);
    expect(BG).toMatch(/handleCookieGetAll\b/);
  });

  it('preserves DNR handlers', () => {
    expect(BG).toMatch(/handleDnrAddRule\b/);
    expect(BG).toMatch(/handleDnrRemoveRule\b/);
  });

  it('preserves execute_in_main forwarding', () => {
    expect(BG).toMatch(/handleExecuteInMain\b/);
  });

  it('preserves health-check ping handler with extensionVersion', () => {
    expect(BG).toMatch(/type:\s*'pong'/);
    expect(BG).toMatch(/extensionVersion/);
  });

  it('preserves SAFARI_PILOT_COMMAND dispatch', () => {
    expect(BG).toMatch(/SAFARI_PILOT_COMMAND/);
  });

  it('handles session_start / session_end as wake triggers', () => {
    expect(BG).toMatch(/session_start/);
    expect(BG).toMatch(/session_end/);
  });
});

describe('background.js — security constraints', () => {
  it('uses strict mode', () => {
    expect(BG).toContain("'use strict'");
  });

  it('does NOT use eval()', () => {
    // Page-side `new Function(...)` in executeScript args is intentional — it
    // runs in the page's MAIN world, not the extension background.
    expect(BG).not.toMatch(/[^.]\beval\s*\(/);
  });
});
