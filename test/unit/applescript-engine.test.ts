import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppleScriptEngine } from '../../src/engines/applescript.js';

// Mock node:child_process so we never actually call osascript
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Helper: get the mocked execFile from child_process
async function getMockedExecFile() {
  const mod = await import('node:child_process');
  return mod.execFile as ReturnType<typeof vi.fn>;
}

describe('AppleScriptEngine', () => {
  let engine: AppleScriptEngine;

  beforeEach(() => {
    engine = new AppleScriptEngine();
    vi.resetAllMocks();
  });

  // ── Test 1: name ────────────────────────────────────────────────────────────
  it('has name "applescript"', () => {
    expect(engine.name).toBe('applescript');
  });

  // ── Test 2: buildTabScript ──────────────────────────────────────────────────
  it('constructs tab-targeting AppleScript', () => {
    const script = engine.buildTabScript('https://example.com', 'return document.title');
    expect(script).toContain('tell application "Safari"');
    expect(script).toContain('https://example.com');
    expect(script).toContain('do JavaScript');
  });

  // ── Test 3: buildNavigateScript ─────────────────────────────────────────────
  it('constructs navigate AppleScript', () => {
    const script = engine.buildNavigateScript('https://example.com/page');
    expect(script).toContain('make new document');
    expect(script).toContain('https://example.com/page');
  });

  // ── Test 4: buildListTabsScript ─────────────────────────────────────────────
  it('constructs list-tabs AppleScript', () => {
    const script = engine.buildListTabsScript();
    expect(script).toContain('every window');
    expect(script).toContain('every tab');
  });

  // ── Test 5: wrapJavaScript ──────────────────────────────────────────────────
  it('wraps JS in serialization harness', () => {
    const wrapped = engine.wrapJavaScript('return 42');
    expect(wrapped).toContain('JSON.stringify');
    expect(wrapped).toContain('ok:true');
  });

  // ── Test 6: error -600 → SAFARI_NOT_RUNNING ─────────────────────────────────
  it('parses AppleScript error -600 as SAFARI_NOT_RUNNING', () => {
    const err = engine.parseAppleScriptError('Application is not running. (-600)');
    expect(err.code).toBe('SAFARI_NOT_RUNNING');
    expect(err.retryable).toBe(true);
  });

  // ── Test 7: error -609 → SAFARI_CRASHED ────────────────────────────────────
  it('parses AppleScript error -609 as SAFARI_CRASHED', () => {
    const err = engine.parseAppleScriptError('Connection is invalid. (-609)');
    expect(err.code).toBe('SAFARI_CRASHED');
    expect(err.retryable).toBe(true);
  });

  // ── Test 8: error -1743 → PERMISSION_DENIED ────────────────────────────────
  it('parses AppleScript error -1743 as PERMISSION_DENIED', () => {
    const err = engine.parseAppleScriptError('Not authorized to send Apple events to Safari. (-1743)');
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.retryable).toBe(false);
  });

  // ── Test 9: error -1728 → ELEMENT_NOT_FOUND ────────────────────────────────
  it('parses AppleScript error -1728 as ELEMENT_NOT_FOUND', () => {
    const err = engine.parseAppleScriptError("Can't get element. (-1728)");
    expect(err.code).toBe('ELEMENT_NOT_FOUND');
    expect(err.retryable).toBe(true);
  });

  // ── Test 10: CSP_BLOCKED detection ─────────────────────────────────────────
  it('detects CSP_BLOCKED from JS return value', () => {
    const result = engine.parseJsResult('blocked by csp policy');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CSP_BLOCKED');
  });

  // ── Test 11: SHADOW_DOM_CLOSED detection ────────────────────────────────────
  it('detects SHADOW_DOM_CLOSED from JS return value', () => {
    const result = engine.parseJsResult('shadow root is closed');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SHADOW_DOM_CLOSED');
  });

  // ── Test 12: successful JS result ──────────────────────────────────────────
  it('parses successful JS result', () => {
    const raw = JSON.stringify({ ok: true, value: 'hello world' });
    const result = engine.parseJsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.value).toBe('hello world');
  });

  // ── Test 13: timeout / killed process ──────────────────────────────────────
  it('handles timeout errors', async () => {
    const execFileMock = await getMockedExecFile();

    // Simulate a killed/timed-out child process error
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error | null) => void) => {
      const err = Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' });
      callback(err);
      return {} as ReturnType<typeof import('node:child_process').execFile>;
    });

    const result = await engine.execute('tell application "Safari" to return 1');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
    expect(result.error?.retryable).toBe(true);
  });

  // ── Test 14: raw string result → success ────────────────────────────────────
  it('handles raw string result', () => {
    const result = engine.parseJsResult('some plain text response');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('some plain text response');
  });
});
