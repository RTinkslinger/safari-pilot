import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InteractionTools } from '../../../src/tools/interaction.js';
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

// ── Shared engine and tools ───────────────────────────────────────────────────

let mockEngine: ReturnType<typeof makeEngine>;
let tools: InteractionTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new InteractionTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('InteractionTools - tool definitions', () => {
  it('registers 11 interaction tools (10 P0 + 1 P1)', () => {
    expect(tools.getDefinitions()).toHaveLength(11);
  });

  const expectedTools = [
    'safari_click',
    'safari_double_click',
    'safari_fill',
    'safari_select_option',
    'safari_check',
    'safari_hover',
    'safari_type',
    'safari_press_key',
    'safari_scroll',
    'safari_drag',
    'safari_handle_dialog',
  ];

  for (const name of expectedTools) {
    it(`registers ${name}`, () => {
      const defs = tools.getDefinitions();
      expect(defs.find((d) => d.name === name)).toBeDefined();
    });
  }

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });
});

// ── safari_click ──────────────────────────────────────────────────────────────

describe('safari_click', () => {
  it('requires tabUrl in schema (selector is optional — ref/locator also accepted)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_click')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
    expect((def.inputSchema as any).properties).toHaveProperty('selector');
    expect((def.inputSchema as any).properties).toHaveProperty('ref');
    expect((def.inputSchema as any).properties).toHaveProperty('role');
  });

  it('dispatches click event via JS and returns element info', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ clicked: true, element: { tagName: 'BUTTON', id: 'submit', textContent: 'Submit' } })),
      );

    const handler = tools.getHandler('safari_click')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: '#submit' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.clicked).toBe(true);
    expect(data.element.tagName).toBe('BUTTON');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(errResult('Element not found: #missing'));

    const handler = tools.getHandler('safari_click')!;
    await expect(handler({ tabUrl: 'https://example.com', selector: '#missing' })).rejects.toThrow(
      'Element not found: #missing',
    );
  });

  it('returns metadata with engine = applescript', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ clicked: true, element: { tagName: 'A', id: undefined, textContent: 'Link' } })),
      );

    const handler = tools.getHandler('safari_click')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: 'a' });
    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
  });
});

// ── safari_double_click ───────────────────────────────────────────────────────

describe('safari_double_click', () => {
  it('requires tabUrl (selector optional)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_double_click')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
    expect((def.inputSchema as any).properties).toHaveProperty('ref');
  });

  it('dispatches dblclick and returns selectedText', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ clicked: true, element: { tagName: 'P' }, selectedText: 'hello world' })),
      );

    const handler = tools.getHandler('safari_double_click')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: 'p.content' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.clicked).toBe(true);
    expect(data.selectedText).toBe('hello world');
  });
});

// ── safari_fill ───────────────────────────────────────────────────────────────

describe('safari_fill', () => {
  it('requires tabUrl and value (selector optional)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_fill')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('value');
    expect(required).not.toContain('selector');
  });

  it('fills input with framework-aware events and returns filled status', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(
          JSON.stringify({
            filled: true,
            element: { tagName: 'INPUT', id: 'email', name: 'email', type: 'email' },
            framework: 'vanilla',
            verifiedValue: 'user@example.com',
          }),
        ),
      );

    const handler = tools.getHandler('safari_fill')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      selector: '#email',
      value: 'user@example.com',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.filled).toBe(true);
    expect(data.verifiedValue).toBe('user@example.com');
    expect(data.framework).toBe('vanilla');
  });

  it('passes framework hint when specified', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ filled: true, framework: 'react', verifiedValue: 'test' })),
      );

    const handler = tools.getHandler('safari_fill')!;
    await handler({ tabUrl: 'https://example.com', selector: '#name', value: 'test', framework: 'react' });

    const actionCallArgs = mockEngine.executeJsInTab.mock.calls[1];
    expect(actionCallArgs[1]).toContain('react');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(errResult('Element not found: #missing'));

    const handler = tools.getHandler('safari_fill')!;
    await expect(
      handler({ tabUrl: 'https://example.com', selector: '#missing', value: 'x' }),
    ).rejects.toThrow('Element not found: #missing');
  });
});

// ── safari_select_option ──────────────────────────────────────────────────────

describe('safari_select_option', () => {
  it('requires tabUrl (selector optional)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_select_option')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).not.toContain('selector');
  });

  it('selects option and returns selected info', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ selected: true, option: { value: 'us', label: 'United States', index: 0 } })),
      );

    const handler = tools.getHandler('safari_select_option')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: '#country', optionValue: 'us' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.selected).toBe(true);
    expect(data.option.value).toBe('us');
  });
});

// ── safari_check ─────────────────────────────────────────────────────────────

describe('safari_check', () => {
  it('requires tabUrl and checked (selector optional)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_check')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('checked');
    expect(required).not.toContain('selector');
  });

  it('toggles checkbox state and returns result', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ toggled: true, element: { tagName: 'INPUT', type: 'checkbox' }, checked: true })),
      );

    const handler = tools.getHandler('safari_check')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: '#terms', checked: true });
    const data = JSON.parse(result.content[0].text!);

    expect(data.toggled).toBe(true);
    expect(data.checked).toBe(true);
  });
});

// ── safari_hover ──────────────────────────────────────────────────────────────

describe('safari_hover', () => {
  it('requires tabUrl (selector optional)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_hover')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).not.toContain('selector');
  });

  it('dispatches hover events and returns hovered status', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(JSON.stringify({ hovered: true, element: { tagName: 'DIV', id: 'menu' } })),
      );

    const handler = tools.getHandler('safari_hover')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: '#menu' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.hovered).toBe(true);
  });
});

// ── safari_type ───────────────────────────────────────────────────────────────

describe('safari_type', () => {
  it('requires tabUrl and content (selector optional, text renamed to content)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_type')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('content');
    expect(required).not.toContain('selector');
  });

  it('types text and returns typed status', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ typed: true, length: 5 })),
    );

    const handler = tools.getHandler('safari_type')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: '#search', content: 'hello' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.typed).toBe(true);
    expect(data.length).toBe(5);
  });
});

// ── safari_press_key ──────────────────────────────────────────────────────────

describe('safari_press_key', () => {
  it('requires tabUrl and key', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_press_key')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('key');
  });

  it('presses key and returns pressed status', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ pressed: true, key: 'Enter', modifiers: [] })),
    );

    const handler = tools.getHandler('safari_press_key')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'Enter' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.pressed).toBe(true);
    expect(data.key).toBe('Enter');
  });
});

// ── safari_scroll ─────────────────────────────────────────────────────────────

describe('safari_scroll', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_scroll')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('scrolls page and returns position', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(
        JSON.stringify({ scrolled: true, scrollPosition: { x: 0, y: 500 }, atTop: false, atBottom: false }),
      ),
    );

    const handler = tools.getHandler('safari_scroll')!;
    const result = await handler({ tabUrl: 'https://example.com', direction: 'down', amount: 500 });
    const data = JSON.parse(result.content[0].text!);

    expect(data.scrolled).toBe(true);
    expect(data.scrollPosition.y).toBe(500);
    expect(data.atTop).toBe(false);
  });

  it('scrolls to top when toTop is true', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ scrolled: true, scrollPosition: { x: 0, y: 0 }, atTop: true, atBottom: false })),
    );

    const handler = tools.getHandler('safari_scroll')!;
    const result = await handler({ tabUrl: 'https://example.com', toTop: true });
    const data = JSON.parse(result.content[0].text!);

    expect(data.atTop).toBe(true);
  });
});

// ── safari_drag ───────────────────────────────────────────────────────────────

describe('safari_drag', () => {
  it('requires tabUrl (sourceSelector/targetSelector optional — refs also accepted)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_drag')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect((def.inputSchema as any).properties).toHaveProperty('sourceRef');
    expect((def.inputSchema as any).properties).toHaveProperty('targetRef');
  });

  it('drags element to target and returns dragged status', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(okResult(JSON.stringify({ ready: true })))
      .mockResolvedValueOnce(
        okResult(
          JSON.stringify({
            dragged: true,
            source: { tagName: 'DIV', id: 'item1' },
            target: { tagName: 'DIV', id: 'bucket' },
          }),
        ),
      );

    const handler = tools.getHandler('safari_drag')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      sourceSelector: '#item1',
      targetSelector: '#bucket',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.dragged).toBe(true);
    expect(data.source.id).toBe('item1');
    expect(data.target.id).toBe('bucket');
  });
});

// ── safari_handle_dialog ──────────────────────────────────────────────────────

describe('safari_handle_dialog', () => {
  it('requires tabUrl, autoHandle, and action in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_handle_dialog')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('autoHandle');
    expect(required).toContain('action');
  });

  it('schema has optional promptText param', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_handle_dialog')!;
    expect((def.inputSchema as any).properties).toHaveProperty('promptText');
  });

  it('action enum has accept and dismiss', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_handle_dialog')!;
    const actionEnum = (def.inputSchema as any).properties.action.enum;
    expect(actionEnum).toContain('accept');
    expect(actionEnum).toContain('dismiss');
  });

  it('has requiresDialogIntercept requirement', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_handle_dialog')!;
    expect(def.requirements.requiresDialogIntercept).toBe(true);
  });

  it('returns installed status when autoHandle is true', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ status: 'installed', action: 'accept', promptText: '' })),
    );

    const handler = tools.getHandler('safari_handle_dialog')!;
    const result = await handler({ tabUrl: 'https://example.com', autoHandle: true, action: 'accept' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('installed');
    expect(parsed.action).toBe('accept');
  });

  it('returns restored status when autoHandle is false', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ status: 'restored', intercepted: 2 })),
    );

    const handler = tools.getHandler('safari_handle_dialog')!;
    const result = await handler({ tabUrl: 'https://example.com', autoHandle: false, action: 'dismiss' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('restored');
    expect(parsed.intercepted).toBe(2);
  });

  it('supports dismiss action', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ status: 'installed', action: 'dismiss', promptText: '' })),
    );

    const handler = tools.getHandler('safari_handle_dialog')!;
    const result = await handler({ tabUrl: 'https://example.com', autoHandle: true, action: 'dismiss' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.action).toBe('dismiss');
  });

  it('supports promptText for prompt dialogs', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ status: 'installed', action: 'accept', promptText: 'my answer' })),
    );

    const handler = tools.getHandler('safari_handle_dialog')!;
    const result = await handler({ tabUrl: 'https://example.com', autoHandle: true, action: 'accept', promptText: 'my answer' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.promptText).toBe('my answer');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ status: 'installed', action: 'accept', promptText: '' })),
    );

    const handler = tools.getHandler('safari_handle_dialog')!;
    await handler({ tabUrl: 'https://example.com', autoHandle: true, action: 'accept' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Handle dialog failed'));

    const handler = tools.getHandler('safari_handle_dialog')!;
    await expect(
      handler({ tabUrl: 'https://example.com', autoHandle: true, action: 'accept' }),
    ).rejects.toThrow('Handle dialog failed');
  });

  it('returns metadata with engine = applescript', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ status: 'installed', action: 'accept', promptText: '' })),
    );

    const handler = tools.getHandler('safari_handle_dialog')!;
    const result = await handler({ tabUrl: 'https://example.com', autoHandle: true, action: 'accept' });

    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
  });
});

// ── getHandler returns undefined for unknown tools ────────────────────────────

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
