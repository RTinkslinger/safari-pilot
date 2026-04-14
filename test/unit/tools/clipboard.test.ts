import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClipboardTools } from '../../../src/tools/clipboard.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ─────────────────────────────────────────────────────────────

function makeEngine(overrides: Partial<{
  executeJsInTab: (tabUrl: string, jsCode: string, timeout?: number) => Promise<EngineResult>;
}>): IEngine {
  return {
    name: 'applescript',
    execute: vi.fn().mockResolvedValue({ ok: true, value: '', elapsed_ms: 1 }),
    executeJsInTab: vi.fn().mockResolvedValue({ ok: true, value: '', elapsed_ms: 1 }),
    isAvailable: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IEngine;
}

function okResult(value: string): EngineResult {
  return { ok: true, value, elapsed_ms: 1 };
}

function errResult(code: string, message: string): EngineResult {
  return { ok: false, error: { code, message, retryable: false }, elapsed_ms: 1 };
}

// ── Tool registration ────────────────────────────────────────────────────────

describe('ClipboardTools - registration', () => {
  let tools: ClipboardTools;

  beforeEach(() => {
    tools = new ClipboardTools(makeEngine({}));
  });

  it('registers exactly 2 tools', () => {
    expect(tools.getDefinitions()).toHaveLength(2);
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('registers safari_clipboard_read', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_clipboard_read');
  });

  it('registers safari_clipboard_write', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_clipboard_write');
  });

  it('safari_clipboard_read requires tabUrl', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_clipboard_read')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('safari_clipboard_write requires tabUrl and text', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_clipboard_write')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('text');
  });

  it('getHandler throws for unknown tool name', () => {
    expect(() => tools.getHandler('safari_unknown')).toThrow(/unknown tool/);
  });
});

// ── safari_clipboard_read ────────────────────────────────────────────────────

describe('safari_clipboard_read', () => {
  it('returns clipboard text when available', async () => {
    const payload = JSON.stringify({ text: 'hello world', clipboardAvailable: true });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ClipboardTools(engine);
    const handler = tools.getHandler('safari_clipboard_read');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.text).toBe('hello world');
    expect(data.clipboardAvailable).toBe(true);
    expect(response.metadata.engine).toBe('applescript');
    expect(response.metadata.degraded).toBe(false);
  });

  it('returns clipboardAvailable: false when gesture required', async () => {
    const payload = JSON.stringify({ text: null, clipboardAvailable: false, error: 'NotAllowedError' });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ClipboardTools(engine);
    const handler = tools.getHandler('safari_clipboard_read');
    const response = await handler({ tabUrl: 'https://example.com' });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.clipboardAvailable).toBe(false);
    expect(data.text).toBeNull();
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('PERMISSION_DENIED', 'Permission denied')),
    });
    const tools = new ClipboardTools(engine);
    const handler = tools.getHandler('safari_clipboard_read');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });

  it('returns fallback when engine returns empty value', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult('')),
    });
    const tools = new ClipboardTools(engine);
    const handler = tools.getHandler('safari_clipboard_read');
    const response = await handler({ tabUrl: 'https://example.com' });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.clipboardAvailable).toBe(false);
  });
});

// ── safari_clipboard_write ───────────────────────────────────────────────────

describe('safari_clipboard_write', () => {
  it('returns written: true on success', async () => {
    const payload = JSON.stringify({ written: true, text: 'my text' });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ClipboardTools(engine);
    const handler = tools.getHandler('safari_clipboard_write');
    const response = await handler({ tabUrl: 'https://example.com', text: 'my text' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.stringContaining('my text'));
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.written).toBe(true);
    expect(response.metadata.degraded).toBe(false);
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('SAFARI_CRASHED', 'Safari crashed')),
    });
    const tools = new ClipboardTools(engine);
    const handler = tools.getHandler('safari_clipboard_write');
    const response = await handler({ tabUrl: 'https://example.com', text: 'text' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});
