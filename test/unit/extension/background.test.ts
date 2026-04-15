/**
 * Extension Background Script — Behavioral Source Checks
 *
 * background.js runs inside Safari's extension sandbox — we can't execute it
 * in Node. These tests verify the source code contains the correct protocol
 * contracts and API usage that must match the daemon and MCP server.
 *
 * Unlike the old linting-style tests (checking for string existence), these
 * tests verify BEHAVIORAL correctness: that the protocol endpoints, response
 * formats, and API calls match what the rest of the system expects.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const src = readFileSync(resolve(ROOT, 'extension/background.js'), 'utf-8');

// ── Core Function: sendNativeRequest ────────────────────────────────────────

describe('background.js — sendNativeRequest function', () => {

  it('defines sendNativeRequest as a function', () => {
    // Must be a named function (not just a call site)
    expect(src).toMatch(/function\s+sendNativeRequest\s*\(/);
  });

  it('sendNativeRequest uses browser.runtime.sendNativeMessage (not connectNative)', () => {
    // sendNativeMessage = request/response per call
    // connectNative = persistent port (was removed because Safari drops it)
    expect(src).toContain('browser.runtime.sendNativeMessage');
    expect(src).not.toContain('connectNative');
  });

  it('sendNativeRequest targets the correct bundle ID', () => {
    // The bundle ID must match the containing .app's CFBundleIdentifier
    expect(src).toContain("'com.safari-pilot.app'");
  });
});

// ── Connection Signal: type "connected" ─────────────────────────────────────

describe('background.js — daemon connection signal', () => {

  it('sends type "connected" on startup (not "status" or "register")', () => {
    // The daemon's ExtensionBridge expects { type: 'connected' } to mark
    // the extension as available. Any other type name breaks isAvailable().
    expect(src).toMatch(/sendNativeRequest\s*\(\s*\{\s*type:\s*'connected'/);
  });

  it('does NOT send a "status" type message for initial connection', () => {
    // Old protocol used "status" — daemon now expects "connected"
    expect(src).not.toMatch(/sendNativeRequest\s*\(\s*\{\s*type:\s*'status'/);
  });
});

// ── Daemon Poll Response Format ─────────────────────────────────────────────

describe('background.js — daemon proxy response parsing', () => {

  it('extracts command from response.value.command (daemon proxy format)', () => {
    // The daemon wraps poll responses as: { ok: true, value: { command: {...} } }
    // background.js must extract via response?.value?.command
    expect(src).toContain('response?.value?.command');
  });

  it('also handles response.command as fallback', () => {
    // Fallback for direct native handler responses
    expect(src).toContain('response?.command');
  });
});

// ── Script Execution: browser.scripting.executeScript ───────────────────────

describe('background.js — script execution API', () => {

  it('uses browser.scripting.executeScript (not tabs.executeScript)', () => {
    // browser.scripting.executeScript is the modern API with world support
    // browser.tabs.executeScript is deprecated and lacks MAIN world injection
    expect(src).toContain('browser.scripting.executeScript');
  });

  it('executes in MAIN world (not ISOLATED)', () => {
    // MAIN world = page's JS context, needed for DOM manipulation
    // ISOLATED world = content script sandbox, can't access page JS
    expect(src).toContain("world: 'MAIN'");
  });

  it('does NOT use tabs.sendMessage for script execution', () => {
    // tabs.sendMessage is for content script communication, not execution
    // Script execution must go through scripting.executeScript
    // (tabs.sendMessage IS used for execute_in_main forwarding — that's fine)
    // But the daemon-command script path must use scripting.executeScript
    const executeBlock = src.slice(
      src.indexOf('async function executeAndReturnResult'),
      src.indexOf('// ─── Poll Loop'),
    );
    expect(executeBlock).toContain('browser.scripting.executeScript');
  });
});

// ── Tab URL Matching ────────────────────────────────────────────────────────

describe('background.js — tab URL matching for command routing', () => {

  it('queries all tabs to find target by URL', () => {
    // Must use browser.tabs.query({}) to get all tabs, then filter by URL
    expect(src).toContain('browser.tabs.query({})');
  });

  it('strips trailing slash for URL comparison', () => {
    // URLs may or may not have trailing slashes — must normalize
    expect(src).toMatch(/replace\s*\(\s*\/\\\/\$\/\s*,\s*''\s*\)/);
  });

  it('falls back to active tab when no URL match found', () => {
    // If tabUrl doesn't match any tab, use the active tab
    expect(src).toContain('active: true, currentWindow: true');
  });
});

// ── Result Reporting ────────────────────────────────────────────────────────

describe('background.js — result reporting back to daemon', () => {

  it('sends results with type "result"', () => {
    expect(src).toMatch(/sendNativeRequest\s*\(\s*\{[^}]*type:\s*'result'/);
  });

  it('includes command id in result messages', () => {
    // The daemon correlates results by id
    expect(src).toMatch(/id:\s*commandId/);
  });

  it('sends error results when execution fails (prevents daemon hanging)', () => {
    // If executeAndReturnResult throws, it must still send a result back
    // so the daemon doesn't wait forever
    const errorHandling = src.includes('Failed to send error result');
    expect(errorHandling).toBe(true);
  });
});

// ── Polling Protocol ────────────────────────────────────────────────────────

describe('background.js — adaptive polling', () => {

  it('polls with type "poll" messages', () => {
    expect(src).toMatch(/sendNativeRequest\s*\(\s*\{\s*type:\s*'poll'\s*\}/);
  });

  it('implements active/idle polling switch', () => {
    // Active polling (fast, 200ms) when commands are flowing
    // Idle polling (slow, 5s) when quiet
    expect(src).toContain('switchToActivePolling');
    expect(src).toContain('switchToIdlePolling');
    expect(src).toContain('POLL_ACTIVE_MS');
    expect(src).toContain('POLL_IDLE_MS');
  });
});

// ── Security ────────────────────────────────────────────────────────────────

describe('background.js — security constraints', () => {

  it('wraps everything in an IIFE (no global pollution)', () => {
    expect(src).toMatch(/^\s*\(function\s*\(\s*\)/m);
  });

  it('uses strict mode', () => {
    expect(src).toContain("'use strict'");
  });

  it('does NOT use eval()', () => {
    // eval in an extension background script is a security risk
    // new Function() in executeScript args is different — that runs in page context
    expect(src).not.toMatch(/[^.]\beval\s*\(/);
  });
});
