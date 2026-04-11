import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompoundTools } from '../../../src/tools/compound.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeEngine(): {
  name: 'applescript';
  execute: ReturnType<typeof vi.fn>;
  executeJsInTab: ReturnType<typeof vi.fn>;
  buildNavigateScript: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'applescript' as const,
    execute: vi.fn(),
    executeJsInTab: vi.fn(),
    buildNavigateScript: vi.fn().mockReturnValue('navigate-script'),
  };
}

function ok(value: string = ''): EngineResult {
  return { ok: true, value, elapsed_ms: 5 };
}

function err(message: string): EngineResult {
  return { ok: false, error: { code: 'JS_ERROR', message, retryable: false }, elapsed_ms: 5 };
}

// ── Shared instances ──────────────────────────────────────────────────────────

let mockEngine: ReturnType<typeof makeEngine>;
let tools: CompoundTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new CompoundTools(mockEngine as unknown as AppleScriptEngine);
  vi.clearAllMocks();
  // Default: executeJsInTab returns ok('') unless overridden per test
  mockEngine.executeJsInTab.mockResolvedValue(ok(''));
  mockEngine.execute.mockResolvedValue(ok(''));
});

// ── Tool registration ────────────────────────────────────────────────────────

describe('CompoundTools - registration', () => {
  it('registers exactly 4 tools', () => {
    expect(tools.getDefinitions()).toHaveLength(4);
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('registers safari_test_flow', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_test_flow');
  });

  it('registers safari_monitor_page', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_monitor_page');
  });

  it('registers safari_paginate_scrape', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_paginate_scrape');
  });

  it('registers safari_media_control', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_media_control');
  });

  it('getHandler throws for unknown tool', () => {
    expect(() => tools.getHandler('safari_unknown')).toThrow('unknown tool');
  });
});

// ── safari_test_flow ──────────────────────────────────────────────────────────

describe('safari_test_flow', () => {
  const TAB = 'https://example.com';

  it('executes a click step and reports passed', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok('clicked'));

    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [{ action: 'click', selector: '#btn' }],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(true);
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0].passed).toBe(true);
  });

  it('executes a navigate step and reports passed', async () => {
    mockEngine.execute.mockResolvedValue(ok(''));
    mockEngine.executeJsInTab.mockResolvedValue(ok(''));

    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [{ action: 'navigate', value: 'https://example.com/page2' }],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(true);
    expect(mockEngine.buildNavigateScript).toHaveBeenCalledWith('https://example.com/page2');
  });

  it('executes a wait step without engine calls', async () => {
    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [{ action: 'wait', value: '10' }],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(true);
    expect(data.steps[0].result).toContain('waited');
  });

  it('marks flow as failed when click step errors', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(err('Element not found'));

    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [{ action: 'click', selector: '#missing' }],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(false);
    expect(data.failedAt).toBe(1);
    expect(data.steps[0].passed).toBe(false);
  });

  it('stops at the first failing assertion step', async () => {
    // First call returns text that does NOT contain expected string
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(ok('actual page text'))
      .mockResolvedValue(ok('should not reach'));

    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [
        {
          action: 'assert',
          assert: { type: 'text', expected: 'NOT PRESENT' },
        },
        { action: 'click', selector: '#btn' },
      ],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(false);
    expect(data.failedAt).toBe(1);
    // Step 2 was never executed
    expect(data.steps).toHaveLength(1);
  });

  it('passes url assertion when current URL contains expected string', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok('https://example.com/success'));

    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [{ action: 'assert', assert: { type: 'url', expected: 'success' } }],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(true);
  });

  it('passes element assertion when element is found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok('found'));

    const handler = tools.getHandler('safari_test_flow');
    const result = await handler({
      tabUrl: TAB,
      steps: [{ action: 'assert', assert: { type: 'element', expected: '#submit' } }],
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.passed).toBe(true);
  });
});

// ── safari_monitor_page ───────────────────────────────────────────────────────

describe('safari_monitor_page', () => {
  const TAB = 'https://example.com';

  it('returns no changes when snapshots are identical', async () => {
    // All calls return the same snapshot
    mockEngine.executeJsInTab.mockResolvedValue(ok('<div>static</div>'));

    const handler = tools.getHandler('safari_monitor_page');
    const result = await handler({
      tabUrl: TAB,
      watch: 'dom',
      maxChecks: 2,
      interval: 0,
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.changes).toHaveLength(0);
    expect(data.checksPerformed).toBe(2);
  });

  it('detects a text change between polls', async () => {
    // Initial snapshot, then changed on first poll
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(ok('before'))    // initial
      .mockResolvedValueOnce(ok('after'))     // check 1
      .mockResolvedValue(ok('after'));         // subsequent checks

    const handler = tools.getHandler('safari_monitor_page');
    const result = await handler({
      tabUrl: TAB,
      watch: 'text',
      maxChecks: 2,
      interval: 0,
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.changes).toHaveLength(1);
    expect(data.changes[0].check).toBe(1);
    expect(data.changes[0].diff).toContain('content changed');
  });

  it('records multiple changes across checks', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(ok('snap0'))  // initial
      .mockResolvedValueOnce(ok('snap1'))  // check 1 — change
      .mockResolvedValueOnce(ok('snap2')); // check 2 — change

    const handler = tools.getHandler('safari_monitor_page');
    const result = await handler({
      tabUrl: TAB,
      watch: 'dom',
      maxChecks: 2,
      interval: 0,
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.changes).toHaveLength(2);
  });
});

// ── safari_paginate_scrape ────────────────────────────────────────────────────

describe('safari_paginate_scrape', () => {
  const TAB = 'https://example.com/list?page=1';

  it('scrapes a single page when no next button exists', async () => {
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(ok(JSON.stringify(['item1', 'item2'])))  // extract
      .mockResolvedValueOnce(ok('not found'));                         // hasNext check

    const handler = tools.getHandler('safari_paginate_scrape');
    const result = await handler({
      tabUrl: TAB,
      extractScript: 'return JSON.stringify([...document.querySelectorAll("li")].map(l=>l.textContent))',
      nextSelector: '.next-page',
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.totalPages).toBe(1);
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0].pageNum).toBe(1);
  });

  it('follows pagination across 3 pages', async () => {
    const page2Url = 'https://example.com/list?page=2';
    const page3Url = 'https://example.com/list?page=3';

    mockEngine.executeJsInTab
      // Page 1: extract, hasNext=found, click, get url
      .mockResolvedValueOnce(ok('"page1data"'))    // extract page 1
      .mockResolvedValueOnce(ok('found'))          // hasNext page 1
      .mockResolvedValueOnce(ok('clicked'))        // click next
      .mockResolvedValueOnce(ok(page2Url))         // get new url
      // Page 2: extract, hasNext=found, click, get url
      .mockResolvedValueOnce(ok('"page2data"'))    // extract page 2
      .mockResolvedValueOnce(ok('found'))          // hasNext page 2
      .mockResolvedValueOnce(ok('clicked'))        // click next
      .mockResolvedValueOnce(ok(page3Url))         // get new url
      // Page 3: extract, hasNext=not found
      .mockResolvedValueOnce(ok('"page3data"'))    // extract page 3
      .mockResolvedValueOnce(ok('not found'));      // hasNext page 3 — stop

    const handler = tools.getHandler('safari_paginate_scrape');
    const result = await handler({
      tabUrl: TAB,
      extractScript: 'return someData()',
      nextSelector: 'a.next',
      maxPages: 5,
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.totalPages).toBe(3);
    expect(data.pages).toHaveLength(3);
    expect(data.pages[0].pageNum).toBe(1);
    expect(data.pages[1].pageNum).toBe(2);
    expect(data.pages[2].pageNum).toBe(3);
  });

  it('respects maxPages limit', async () => {
    // Always says "found" for next, but we cap at 2 pages
    mockEngine.executeJsInTab
      .mockResolvedValueOnce(ok('"p1"'))           // extract page 1
      .mockResolvedValueOnce(ok('found'))           // hasNext
      .mockResolvedValueOnce(ok('clicked'))         // click
      .mockResolvedValueOnce(ok('https://p2'))      // url
      .mockResolvedValueOnce(ok('"p2"'))            // extract page 2
      .mockResolvedValueOnce(ok('found'));           // hasNext — but maxPages reached

    const handler = tools.getHandler('safari_paginate_scrape');
    const result = await handler({
      tabUrl: TAB,
      extractScript: 'return data()',
      nextSelector: '.next',
      maxPages: 2,
    });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.totalPages).toBe(2);
  });
});

// ── safari_media_control ──────────────────────────────────────────────────────

describe('safari_media_control', () => {
  const TAB = 'https://example.com/video';

  const mediaState = (overrides: Partial<{
    action: string; currentTime: number; duration: number;
    paused: boolean; muted: boolean; volume: number; playbackRate: number;
  }> = {}) => JSON.stringify({
    action: 'play', currentTime: 0, duration: 120,
    paused: false, muted: false, volume: 1, playbackRate: 1,
    ...overrides,
  });

  it('play action returns media state with paused: false', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok(mediaState({ action: 'play', paused: false })));

    const handler = tools.getHandler('safari_media_control');
    const result = await handler({ tabUrl: TAB, action: 'play' });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.paused).toBe(false);
    expect(data.action).toBe('play');
  });

  it('pause action returns media state with paused: true', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok(mediaState({ action: 'pause', paused: true })));

    const handler = tools.getHandler('safari_media_control');
    const result = await handler({ tabUrl: TAB, action: 'pause' });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.paused).toBe(true);
  });

  it('mute action returns muted: true', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok(mediaState({ action: 'mute', muted: true })));

    const handler = tools.getHandler('safari_media_control');
    const result = await handler({ tabUrl: TAB, action: 'mute' });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.muted).toBe(true);
  });

  it('seek action returns updated currentTime', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok(mediaState({ action: 'seek', currentTime: 45 })));

    const handler = tools.getHandler('safari_media_control');
    const result = await handler({ tabUrl: TAB, action: 'seek', value: 45 });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.currentTime).toBe(45);
  });

  it('speed action returns updated playbackRate', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok(mediaState({ action: 'speed', playbackRate: 1.5 })));

    const handler = tools.getHandler('safari_media_control');
    const result = await handler({ tabUrl: TAB, action: 'speed', value: 1.5 });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.playbackRate).toBe(1.5);
  });

  it('returns error response when engine fails', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(err('No media element found'));

    const handler = tools.getHandler('safari_media_control');
    const result = await handler({ tabUrl: TAB, action: 'play' });

    const data = JSON.parse(result.content[0]!.text!);
    expect(data.error).toContain('No media element found');
    expect(result.metadata.degraded).toBe(true);
  });

  it('uses custom selector when provided', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(ok(mediaState()));

    const handler = tools.getHandler('safari_media_control');
    await handler({ tabUrl: TAB, action: 'play', selector: '#main-video' });

    const jsArg = mockEngine.executeJsInTab.mock.calls[0][1] as string;
    expect(jsArg).toContain('#main-video');
  });
});
