import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WaitTools } from '../../../src/tools/wait.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ─────────────────────────────────────────────────────────────

function makeEngine(overrides: Partial<{
  executeJsInTab: (tabUrl: string, jsCode: string, timeout?: number) => Promise<EngineResult>;
}>): IEngine {
  return {
    name: 'applescript',
    execute: vi.fn().mockResolvedValue({ ok: true, value: 'false', elapsed_ms: 1 }),
    executeJsInTab: vi.fn().mockResolvedValue({ ok: true, value: 'false', elapsed_ms: 1 }),
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

/** Simulate N failing polls then a success on the (N+1)th call. */
function afterNPolls(n: number): ReturnType<typeof vi.fn> {
  let callCount = 0;
  return vi.fn().mockImplementation((_tabUrl: string, _jsCode: string) => {
    callCount++;
    return Promise.resolve(okResult(callCount > n ? 'true' : 'false'));
  });
}

// ── Tool registration ────────────────────────────────────────────────────────

describe('WaitTools - registration', () => {
  let tools: WaitTools;

  beforeEach(() => {
    tools = new WaitTools(makeEngine({}));
  });

  it('registers exactly 1 tool', () => {
    expect(tools.getDefinitions()).toHaveLength(1);
  });

  it('tool name has the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('registers safari_wait_for', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_wait_for');
  });

  it('safari_wait_for requires tabUrl and condition', () => {
    const def = tools.getDefinitions()[0]!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('condition');
  });

  it('getHandler throws for unknown tool name', () => {
    expect(() => tools.getHandler('safari_unknown')).toThrow(/unknown tool/);
  });
});

// ── selector condition ────────────────────────────────────────────────────────

describe("safari_wait_for condition: 'selector'", () => {
  it('resolves met: true when element is found on first poll', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'selector',
      value: '#submit-btn',
      timeout: 5000,
      pollInterval: 100,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
    expect(data.timedOut).toBe(false);
    expect(response.metadata.degraded).toBe(false);
  });

  it('passes CSS selector into the JS snippet', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    await handler({
      tabUrl: 'https://example.com',
      condition: 'selector',
      value: '.my-button',
      timeout: 5000,
    });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('.my-button');
    expect(jsArg).toContain('querySelector');
  });

  it('resolves met: true after a few failing polls', async () => {
    const engine = makeEngine({ executeJsInTab: afterNPolls(2) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'selector',
      value: '#btn',
      timeout: 5000,
      pollInterval: 10,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
    expect(data.timedOut).toBe(false);
    // Should have been called 3 times (2 false + 1 true)
    expect((engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });
});

// ── selectorHidden condition ──────────────────────────────────────────────────

describe("safari_wait_for condition: 'selectorHidden'", () => {
  it('resolves met: true when element disappears', async () => {
    // First poll: element still present (false), second poll: gone (true)
    const engine = makeEngine({ executeJsInTab: afterNPolls(1) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'selectorHidden',
      value: '.spinner',
      timeout: 5000,
      pollInterval: 10,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
    expect(data.timedOut).toBe(false);
  });

  it('JS snippet checks for null (element absent)', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    await handler({
      tabUrl: 'https://example.com',
      condition: 'selectorHidden',
      value: '.spinner',
      timeout: 5000,
    });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('=== null');
  });
});

// ── text condition ────────────────────────────────────────────────────────────

describe("safari_wait_for condition: 'text'", () => {
  it('resolves met: true when text appears in page', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'text',
      value: 'Welcome back!',
      timeout: 5000,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
  });

  it('JS snippet uses textContent.includes', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    await handler({
      tabUrl: 'https://example.com',
      condition: 'text',
      value: 'Success',
      timeout: 5000,
    });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('textContent');
    expect(jsArg).toContain('includes');
    expect(jsArg).toContain('Success');
  });
});

// ── function condition ────────────────────────────────────────────────────────

describe("safari_wait_for condition: 'function'", () => {
  it('resolves met: true when custom function returns truthy', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'function',
      value: 'return window.myFlag === true',
      timeout: 5000,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
  });

  it('embeds the function body in the JS snippet', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const funcBody = 'return document.readyState === "complete"';
    await handler({
      tabUrl: 'https://example.com',
      condition: 'function',
      value: funcBody,
      timeout: 5000,
    });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain(funcBody);
  });

  it('resolves met: true after N failing polls', async () => {
    const engine = makeEngine({ executeJsInTab: afterNPolls(3) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'function',
      value: 'return window.ready === true',
      timeout: 5000,
      pollInterval: 10,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
    expect((engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });
});

// ── timeout behaviour ─────────────────────────────────────────────────────────

describe('safari_wait_for — timeout', () => {
  it('returns timedOut: true and met: false when condition never met', async () => {
    // Engine always returns false
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('false')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'selector',
      value: '#never-appears',
      timeout: 100,         // very short timeout
      pollInterval: 200,    // interval longer than timeout → times out immediately
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(false);
    expect(data.timedOut).toBe(true);
  });
});

// ── elapsed time ──────────────────────────────────────────────────────────────

describe('safari_wait_for — elapsed time', () => {
  it('returns elapsed time in the response', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'selector',
      value: '#btn',
      timeout: 5000,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(typeof data.elapsed).toBe('number');
    expect(data.elapsed).toBeGreaterThanOrEqual(0);
    expect(response.metadata.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ── urlMatch condition ────────────────────────────────────────────────────────

describe("safari_wait_for condition: 'urlMatch'", () => {
  it('resolves met: true when URL contains the pattern', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    const response = await handler({
      tabUrl: 'https://example.com',
      condition: 'urlMatch',
      value: '/dashboard',
      timeout: 5000,
    });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.met).toBe(true);
  });

  it('JS snippet checks location.href.includes', async () => {
    const engine = makeEngine({ executeJsInTab: vi.fn().mockResolvedValue(okResult('true')) });
    const tools = new WaitTools(engine);
    const handler = tools.getHandler('safari_wait_for');

    await handler({
      tabUrl: 'https://example.com',
      condition: 'urlMatch',
      value: '/success',
      timeout: 5000,
    });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('location.href');
    expect(jsArg).toContain('/success');
  });
});
