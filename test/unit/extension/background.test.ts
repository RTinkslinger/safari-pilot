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

  it('connects to native messaging host', () => {
    expect(src).toContain('browser.runtime.connectNative');
  });

  it('uses the correct native app identifier', () => {
    expect(src).toContain('com.safari-pilot.daemon');
  });

  it('listens for runtime messages', () => {
    expect(src).toContain('browser.runtime.onMessage.addListener');
  });

  it('handles ping with pong response', () => {
    expect(src).toContain("'ping'");
    expect(src).toContain("'pong'");
    expect(src).toContain("extensionVersion: '0.1.0'");
  });

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

  it('handles declarativeNetRequest add rule', () => {
    expect(src).toContain('dnr_add_rule');
    expect(src).toContain('declarativeNetRequest');
  });

  it('handles declarativeNetRequest remove rule', () => {
    expect(src).toContain('dnr_remove_rule');
  });

  it('tracks tabs via onUpdated', () => {
    expect(src).toContain('browser.tabs.onUpdated');
  });

  it('tracks tabs via onRemoved', () => {
    expect(src).toContain('browser.tabs.onRemoved');
  });

  it('auto-reconnects native port on disconnect', () => {
    expect(src).toContain('handleNativeDisconnect');
    expect(src).toContain('setTimeout');
    expect(src).toContain('connectNative');
  });

  it('rejects pending requests on disconnect', () => {
    expect(src).toContain('pendingRequests');
    expect(src).toContain("Native port disconnected");
  });

  it('returns true from onMessage listener for async responses', () => {
    expect(src).toContain('return true');
  });

  it('routes SAFARI_PILOT_COMMAND messages', () => {
    expect(src).toContain('SAFARI_PILOT_COMMAND');
  });

  it('handles execute_in_main command', () => {
    expect(src).toContain('execute_in_main');
  });

  it('does NOT use eval()', () => {
    // eval() is a security risk in extensions — it allows arbitrary code execution
    expect(src).not.toMatch(/\beval\s*\(/);
  });

  it('does NOT use Function() constructor', () => {
    // new Function() is equivalent to eval — both violate CSP in extensions
    expect(src).not.toMatch(/new\s+Function\s*\(/);
  });

  it('does NOT use postMessage with wildcard origin', () => {
    // postMessage(*, '*') leaks data to any origin — not acceptable in an extension
    expect(src).not.toContain("postMessage(*, '*')");
    expect(src).not.toMatch(/postMessage\([^)]*,\s*['"]\*['"]/);
  });

  it('wraps everything in an IIFE to avoid global namespace pollution', () => {
    expect(src).toMatch(/\(function\s*\(\s*\)/);
  });
});
