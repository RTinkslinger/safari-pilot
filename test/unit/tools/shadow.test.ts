import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShadowTools } from '../../../src/tools/shadow.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeEngine(): {
  name: 'applescript';
  executeJsInTab: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'applescript' as const,
    executeJsInTab: vi.fn(),
    execute: vi.fn(),
  };
}

function okResult(value: string): EngineResult {
  return { ok: true, value, elapsed_ms: 10 };
}

function errResult(message: string): EngineResult {
  return { ok: false, error: { code: 'JS_ERROR', message, retryable: false }, elapsed_ms: 10 };
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let mockEngine: ReturnType<typeof makeEngine>;
let tools: ShadowTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new ShadowTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('ShadowTools - tool definitions', () => {
  it('registers 2 shadow DOM tools', () => {
    expect(tools.getDefinitions()).toHaveLength(2);
  });

  it('registers safari_query_shadow', () => {
    const defs = tools.getDefinitions();
    expect(defs.find((d) => d.name === 'safari_query_shadow')).toBeDefined();
  });

  it('registers safari_click_shadow', () => {
    const defs = tools.getDefinitions();
    expect(defs.find((d) => d.name === 'safari_click_shadow')).toBeDefined();
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('all shadow tools have requiresShadowDom: true', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.requirements.requiresShadowDom).toBe(true);
    }
  });
});

// ── safari_query_shadow ───────────────────────────────────────────────────────

describe('safari_query_shadow', () => {
  it('requires tabUrl, hostSelector, and shadowSelector', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_query_shadow')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('hostSelector');
    expect(required).toContain('shadowSelector');
  });

  it('returns element metadata when shadow element is found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(
        JSON.stringify({
          found: true,
          element: {
            tagName: 'BUTTON',
            id: 'shadow-btn',
            className: 'primary',
            textContent: 'Click me',
            rect: { x: 10, y: 20, width: 100, height: 40 },
          },
        }),
      ),
    );

    const handler = tools.getHandler('safari_query_shadow')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      hostSelector: 'my-component',
      shadowSelector: 'button.primary',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.found).toBe(true);
    expect(data.element.tagName).toBe('BUTTON');
    expect(data.element.id).toBe('shadow-btn');
  });

  it('passes both selectors to executeJsInTab', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ found: true, element: { tagName: 'SPAN' } })),
    );

    const handler = tools.getHandler('safari_query_shadow')!;
    await handler({
      tabUrl: 'https://example.com',
      hostSelector: '#host',
      shadowSelector: '.inner',
    });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('#host'),
    );
    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('.inner'),
    );
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Shadow host not found: #missing'));

    const handler = tools.getHandler('safari_query_shadow')!;
    await expect(
      handler({ tabUrl: 'https://example.com', hostSelector: '#missing', shadowSelector: 'button' }),
    ).rejects.toThrow('Shadow host not found: #missing');
  });

  it('returns metadata with engine = applescript and degraded = false', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ found: true, element: { tagName: 'DIV' } })),
    );

    const handler = tools.getHandler('safari_query_shadow')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      hostSelector: 'x-app',
      shadowSelector: 'div',
    });

    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
  });
});

// ── safari_click_shadow ───────────────────────────────────────────────────────

describe('safari_click_shadow', () => {
  it('requires tabUrl, hostSelector, and shadowSelector', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_click_shadow')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('hostSelector');
    expect(required).toContain('shadowSelector');
  });

  it('dispatches click events and returns clicked status', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(
        JSON.stringify({
          clicked: true,
          element: { tagName: 'BUTTON', id: 'submit-btn', textContent: 'Submit' },
        }),
      ),
    );

    const handler = tools.getHandler('safari_click_shadow')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      hostSelector: 'my-form',
      shadowSelector: 'button[type=submit]',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.clicked).toBe(true);
    expect(data.element.tagName).toBe('BUTTON');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Element has no shadowRoot: my-form'));

    const handler = tools.getHandler('safari_click_shadow')!;
    await expect(
      handler({ tabUrl: 'https://example.com', hostSelector: 'my-form', shadowSelector: 'button' }),
    ).rejects.toThrow('Element has no shadowRoot: my-form');
  });
});

// ── getHandler ────────────────────────────────────────────────────────────────

describe('getHandler', () => {
  it('returns undefined for unknown tool name', () => {
    expect(tools.getHandler('safari_nonexistent')).toBeUndefined();
  });

  it('returns a function for every registered tool', () => {
    for (const def of tools.getDefinitions()) {
      const handler = tools.getHandler(def.name);
      expect(typeof handler).toBe('function');
    }
  });
});
