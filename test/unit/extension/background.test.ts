import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const src = readFileSync(resolve(ROOT, 'extension/background.js'), 'utf-8');

describe('Extension Background Script — file structure', () => {
  it('background.js file exists and is non-empty', () => {
    expect(src.length).toBeGreaterThan(100);
  });

  it('uses strict mode', () => {
    expect(src).toContain("'use strict'");
  });

  // ─── Native Messaging: sendNativeMessage (not connectNative) ──────────────

  it('uses browser.runtime.sendNativeMessage for native messaging', () => {
    expect(src).toContain('browser.runtime.sendNativeMessage');
  });

  it('does NOT use browser.runtime.connectNative (persistent port)', () => {
    expect(src).not.toContain('browser.runtime.connectNative');
    expect(src).not.toContain('connectNative(');
  });

  it('uses the correct app bundle identifier', () => {
    expect(src).toContain('com.safari-pilot.app');
  });

  it('does NOT reference the old daemon app identifier', () => {
    expect(src).not.toContain('com.safari-pilot.daemon');
  });

  // ─── Polling ────────────────────────────────────────────────────────────────

  it('implements adaptive polling for daemon commands', () => {
    expect(src).toContain('pollForCommands');
    expect(src).toContain('setInterval');
    expect(src).toContain('POLL_IDLE_MS');
    expect(src).toContain('POLL_ACTIVE_MS');
    expect(src).toContain('switchToActivePolling');
    expect(src).toContain('switchToIdlePolling');
  });

  it('sends poll messages with type "poll"', () => {
    expect(src).toContain("type: 'poll'");
  });

  it('sends result messages with type "result"', () => {
    expect(src).toContain("type: 'result'");
  });

  it('sends status check on startup', () => {
    expect(src).toContain("type: 'status'");
  });

  // ─── Runtime Message Listener ─────────────────────────────────────────────

  it('listens for runtime messages', () => {
    expect(src).toContain('browser.runtime.onMessage.addListener');
  });

  it('handles ping with pong response', () => {
    expect(src).toContain("'ping'");
    expect(src).toContain("'pong'");
    expect(src).toMatch(/extensionVersion: '\d+\.\d+\.\d+'/);
  });

  // ─── Cookie Operations ────────────────────────────────────────────────────

  it('handles cookie_get command', () => {
    expect(src).toContain('cookie_get');
    expect(src).toContain('browser.cookies.get');
  });

  it('handles cookie_set command', () => {
    expect(src).toContain('cookie_set');
    expect(src).toContain('browser.cookies.set');
  });

  it('handles cookie_remove command', () => {
    expect(src).toContain('cookie_remove');
    expect(src).toContain('browser.cookies.remove');
  });

  it('handles cookie_get_all command', () => {
    expect(src).toContain('cookie_get_all');
    expect(src).toContain('browser.cookies.getAll');
  });

  // ─── DNR Operations ──────────────────────────────────────────────────────

  it('handles declarativeNetRequest add rule', () => {
    expect(src).toContain('dnr_add_rule');
    expect(src).toContain('declarativeNetRequest');
  });

  it('handles declarativeNetRequest remove rule', () => {
    expect(src).toContain('dnr_remove_rule');
  });

  // ─── Tab Tracking ─────────────────────────────────────────────────────────

  it('tracks tabs via onUpdated', () => {
    expect(src).toContain('browser.tabs.onUpdated');
  });

  it('tracks tabs via onRemoved', () => {
    expect(src).toContain('browser.tabs.onRemoved');
  });

  // ─── Command Routing ──────────────────────────────────────────────────────

  it('returns true from onMessage listener for async responses', () => {
    expect(src).toContain('return true');
  });

  it('routes SAFARI_PILOT_COMMAND messages', () => {
    expect(src).toContain('SAFARI_PILOT_COMMAND');
  });

  it('handles execute_in_main command', () => {
    expect(src).toContain('execute_in_main');
  });

  // ─── Security ─────────────────────────────────────────────────────────────

  it('does NOT use eval()', () => {
    expect(src).not.toMatch(/\beval\s*\(/);
  });

  it('does NOT use Function() constructor', () => {
    expect(src).not.toMatch(/new\s+Function\s*\(/);
  });

  it('does NOT use postMessage with wildcard origin', () => {
    expect(src).not.toContain("postMessage(*, '*')");
    expect(src).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]/);
  });

  it('wraps everything in an IIFE to avoid global namespace pollution', () => {
    expect(src).toMatch(/\(function\s*\(\s*\)/);
  });
});
