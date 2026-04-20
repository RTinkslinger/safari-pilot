import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FrameTools } from '../../../src/tools/frames.js';
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
let tools: FrameTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new FrameTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('FrameTools - tool definitions', () => {
  it('registers 3 frame tools', () => {
    expect(tools.getDefinitions()).toHaveLength(3);
  });

  it('registers safari_list_frames', () => {
    expect(tools.getDefinitions().find((d) => d.name === 'safari_list_frames')).toBeDefined();
  });

  it('registers safari_switch_frame', () => {
    expect(tools.getDefinitions().find((d) => d.name === 'safari_switch_frame')).toBeDefined();
  });

  it('registers safari_eval_in_frame', () => {
    expect(tools.getDefinitions().find((d) => d.name === 'safari_eval_in_frame')).toBeDefined();
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('safari_eval_in_frame has no special engine requirements', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_eval_in_frame')!;
    expect(def.requirements).toEqual({});
  });
});

// ── safari_list_frames ────────────────────────────────────────────────────────

describe('safari_list_frames', () => {
  it('requires tabUrl', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_list_frames')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
  });

  it('returns frame list with count and metadata', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(
        JSON.stringify({
          count: 2,
          frames: [
            { index: 0, src: 'https://ads.example.com/banner', name: 'ad-banner', id: null, width: 300, height: 250, sandbox: null },
            { index: 1, src: 'https://chat.example.com/widget', name: 'chat', id: 'chat-frame', width: 400, height: 600, sandbox: 'allow-scripts' },
          ],
        }),
      ),
    );

    const handler = tools.getHandler('safari_list_frames')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.count).toBe(2);
    expect(data.frames).toHaveLength(2);
    expect(data.frames[0].src).toBe('https://ads.example.com/banner');
    expect(data.frames[1].name).toBe('chat');
  });

  it('returns empty frames array when no iframes present', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ count: 0, frames: [] })),
    );

    const handler = tools.getHandler('safari_list_frames')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.count).toBe(0);
    expect(data.frames).toHaveLength(0);
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Script execution failed'));

    const handler = tools.getHandler('safari_list_frames')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Script execution failed');
  });

  it('returns metadata with engine = applescript', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ count: 0, frames: [] })),
    );

    const handler = tools.getHandler('safari_list_frames')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
  });
});

// ── safari_switch_frame ───────────────────────────────────────────────────────

describe('safari_switch_frame', () => {
  it('requires tabUrl and frameSelector', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_switch_frame')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('frameSelector');
  });

  it('returns switched status and frame info', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(
        JSON.stringify({
          switched: true,
          frame: { selector: '#chat-frame', src: 'https://chat.example.com', name: 'chat', id: 'chat-frame' },
        }),
      ),
    );

    const handler = tools.getHandler('safari_switch_frame')!;
    const result = await handler({ tabUrl: 'https://example.com', frameSelector: '#chat-frame' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.switched).toBe(true);
    expect(data.frame.selector).toBe('#chat-frame');
    expect(data.frame.src).toBe('https://chat.example.com');
  });

  it('passes frameSelector to executeJsInTab JS', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ switched: true, frame: { selector: 'iframe[name=chat]' } })),
    );

    const handler = tools.getHandler('safari_switch_frame')!;
    await handler({ tabUrl: 'https://example.com', frameSelector: 'iframe[name=chat]' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('iframe[name=chat]'),
    );
  });

  it('throws when frame not found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Frame not found: #missing'));

    const handler = tools.getHandler('safari_switch_frame')!;
    await expect(
      handler({ tabUrl: 'https://example.com', frameSelector: '#missing' }),
    ).rejects.toThrow('Frame not found: #missing');
  });
});

// ── safari_eval_in_frame ──────────────────────────────────────────────────────

describe('safari_eval_in_frame', () => {
  it('requires tabUrl, frameSelector, and script', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_eval_in_frame')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('frameSelector');
    expect(required).toContain('script');
  });

  it('returns script evaluation result', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ ok: true, result: { title: 'Frame Title' } })),
    );

    const handler = tools.getHandler('safari_eval_in_frame')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      frameSelector: '#embed',
      script: 'document.title',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.ok).toBe(true);
    expect(data.result.title).toBe('Frame Title');
  });

  it('returns ok:false when frame eval throws', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ ok: false, error: 'ReferenceError: undeclaredVar is not defined' })),
    );

    const handler = tools.getHandler('safari_eval_in_frame')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      frameSelector: '#embed',
      script: 'undeclaredVar',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.ok).toBe(false);
    expect(data.error).toContain('ReferenceError');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Frame not found: #embed'));

    const handler = tools.getHandler('safari_eval_in_frame')!;
    await expect(
      handler({ tabUrl: 'https://example.com', frameSelector: '#embed', script: 'document.title' }),
    ).rejects.toThrow('Frame not found: #embed');
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
