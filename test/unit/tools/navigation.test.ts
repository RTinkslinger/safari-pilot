import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NavigationTools, parseTabList } from '../../../src/tools/navigation.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ─────────────────────────────────────────────────────────────

function makeEngine(overrides: Partial<{
  execute: (script: string, timeout?: number) => Promise<EngineResult>;
  buildNavigateScript: (url: string) => string;
  buildNewTabScript: (url: string, privateWindow?: boolean) => string;
  buildCloseTabScript: (url: string) => string;
  buildListTabsScript: () => string;
  buildTabScript: (url: string, jsCode: string) => string;
}>): AppleScriptEngine {
  return {
    name: 'applescript',
    execute: vi.fn().mockResolvedValue({ ok: true, value: '', elapsed_ms: 1 }),
    buildNavigateScript: vi.fn().mockReturnValue('navigate-script'),
    buildNewTabScript: vi.fn().mockReturnValue('new-tab-script'),
    buildCloseTabScript: vi.fn().mockReturnValue('close-tab-script'),
    buildListTabsScript: vi.fn().mockReturnValue('list-tabs-script'),
    buildTabScript: vi.fn().mockReturnValue('tab-script'),
    isAvailable: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    executeRaw: vi.fn(),
    wrapJavaScript: vi.fn(),
    parseJsResult: vi.fn(),
    parseAppleScriptError: vi.fn(),
    ...overrides,
  } as unknown as AppleScriptEngine;
}

function okResult(value: string = ''): EngineResult {
  return { ok: true, value, elapsed_ms: 1 };
}

function errResult(code: string, message: string): EngineResult {
  return { ok: false, error: { code, message, retryable: false }, elapsed_ms: 1 };
}

// ── Tool registration tests ──────────────────────────────────────────────────

describe('NavigationTools - registration', () => {
  let tools: NavigationTools;

  beforeEach(() => {
    tools = new NavigationTools(makeEngine({}));
  });

  it('registers exactly 7 tools', () => {
    expect(tools.getDefinitions()).toHaveLength(7);
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('registers safari_navigate', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_navigate');
  });

  it('registers safari_navigate_back', () => {
    expect(tools.getDefinitions().map((d) => d.name)).toContain('safari_navigate_back');
  });

  it('registers safari_navigate_forward', () => {
    expect(tools.getDefinitions().map((d) => d.name)).toContain('safari_navigate_forward');
  });

  it('registers safari_reload', () => {
    expect(tools.getDefinitions().map((d) => d.name)).toContain('safari_reload');
  });

  it('registers safari_new_tab', () => {
    expect(tools.getDefinitions().map((d) => d.name)).toContain('safari_new_tab');
  });

  it('registers safari_close_tab', () => {
    expect(tools.getDefinitions().map((d) => d.name)).toContain('safari_close_tab');
  });

  it('registers safari_list_tabs', () => {
    expect(tools.getDefinitions().map((d) => d.name)).toContain('safari_list_tabs');
  });
});

// ── safari_navigate ──────────────────────────────────────────────────────────

describe('safari_navigate', () => {
  it('requires url param (schema has required: ["url"])', () => {
    const tools = new NavigationTools(makeEngine({}));
    const def = tools.getDefinitions().find((d) => d.name === 'safari_navigate')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('url');
  });

  it('calls engine.execute and returns url/title from page info', async () => {
    // After engine.parseJsResult unwraps the JS harness envelope, value is the inner JSON string.
    // So execute() resolves with the already-unwrapped page info string.
    const pageInfo = JSON.stringify({ url: 'https://example.com', title: 'Example' });
    const engine = makeEngine({
      execute: vi.fn()
        .mockResolvedValueOnce(okResult('')) // navigate
        .mockResolvedValueOnce(okResult(pageInfo)), // page info (already unwrapped by engine)
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_navigate');
    const response = await handler({ url: 'https://example.com' });

    expect(engine.execute).toHaveBeenCalled();
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.url).toBe('https://example.com');
    expect(data.title).toBe('Example');
    expect(response.metadata.engine).toBe('applescript');
  });

  it('returns degraded response when navigation fails', async () => {
    const engine = makeEngine({
      execute: vi.fn().mockResolvedValue(errResult('SAFARI_NOT_RUNNING', 'Safari is not running')),
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_navigate');
    const response = await handler({ url: 'https://example.com' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});

// ── safari_list_tabs ─────────────────────────────────────────────────────────

describe('safari_list_tabs', () => {
  it('parses "winIdx|||tabIdx|||url|||title" format correctly', async () => {
    const raw = '1|||1|||https://example.com|||Example Page\n1|||2|||https://google.com|||Google\n';
    const engine = makeEngine({
      execute: vi.fn().mockResolvedValue(okResult(raw)),
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_list_tabs');
    const response = await handler({});

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.tabs).toHaveLength(2);
    expect(data.tabs[0].url).toBe('https://example.com');
    expect(data.tabs[0].title).toBe('Example Page');
    expect(data.tabs[1].url).toBe('https://google.com');
    expect(data.tabs[1].title).toBe('Google');
  });

  it('parses "url\\ttitle" tab-separated format from buildListTabsScript', async () => {
    const raw = 'https://example.com\tExample Page\nhttps://google.com\tGoogle\n';
    const engine = makeEngine({
      execute: vi.fn().mockResolvedValue(okResult(raw)),
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_list_tabs');
    const response = await handler({});

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.tabs).toHaveLength(2);
    expect(data.tabs[0].url).toBe('https://example.com');
    expect(data.tabs[0].title).toBe('Example Page');
  });

  it('returns empty tabs array for empty engine output', async () => {
    const engine = makeEngine({
      execute: vi.fn().mockResolvedValue(okResult('')),
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_list_tabs');
    const response = await handler({});

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.tabs).toEqual([]);
  });
});

// ── safari_new_tab ────────────────────────────────────────────────────────────

describe('safari_new_tab', () => {
  it('creates a new tab and returns tabUrl', async () => {
    const engine = makeEngine({
      execute: vi.fn().mockResolvedValue(okResult('https://about:blank|||1')),
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_new_tab');
    const response = await handler({ url: 'about:blank' });

    expect(engine.buildNewTabScript).toHaveBeenCalled();
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.tabUrl).toBeDefined();
    expect(response.metadata.engine).toBe('applescript');
  });

  it('uses about:blank when no url param provided', async () => {
    const engine = makeEngine({
      execute: vi.fn().mockResolvedValue(okResult('')),
    });

    const tools = new NavigationTools(engine);
    const handler = tools.getHandler('safari_new_tab');
    await handler({});

    expect(engine.buildNewTabScript).toHaveBeenCalledWith('about:blank', false, undefined);
  });
});

// ── parseTabList unit tests ──────────────────────────────────────────────────

describe('parseTabList', () => {
  it('handles empty string', () => {
    expect(parseTabList('')).toEqual([]);
  });

  it('parses pipe-delimited format with 4 parts', () => {
    const tabs = parseTabList('1|||1|||https://example.com|||Example\n');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe('https://example.com');
    expect(tabs[0].title).toBe('Example');
  });

  it('parses tab-separated format', () => {
    const tabs = parseTabList('https://example.com\tExample Title\n');
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBe('https://example.com');
    expect(tabs[0].title).toBe('Example Title');
  });

  it('skips blank lines', () => {
    const tabs = parseTabList('https://a.com\tA\n\nhttps://b.com\tB\n');
    expect(tabs).toHaveLength(2);
  });
});
