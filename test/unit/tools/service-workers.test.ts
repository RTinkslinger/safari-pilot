import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceWorkerTools } from '../../../src/tools/service-workers.js';
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

describe('ServiceWorkerTools - registration', () => {
  let tools: ServiceWorkerTools;

  beforeEach(() => {
    tools = new ServiceWorkerTools(makeEngine({}));
  });

  it('registers exactly 2 tools', () => {
    expect(tools.getDefinitions()).toHaveLength(2);
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('registers safari_sw_list', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_sw_list');
  });

  it('registers safari_sw_unregister', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_sw_unregister');
  });

  it('safari_sw_list requires tabUrl', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_sw_list')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('safari_sw_unregister requires tabUrl and scope', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_sw_unregister')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('scope');
  });

  it('getHandler throws for unknown tool name', () => {
    expect(() => tools.getHandler('safari_unknown')).toThrow(/unknown tool/);
  });
});

// ── safari_sw_list ───────────────────────────────────────────────────────────

describe('safari_sw_list', () => {
  it('returns list of registrations when service workers exist', async () => {
    const registrations = [
      { scope: 'https://example.com/', scriptURL: 'https://example.com/sw.js', state: 'active', updateViaCache: 'imports' },
    ];
    const payload = JSON.stringify({ registrations, supported: true });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_list');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.registrations).toHaveLength(1);
    expect(data.registrations[0].scope).toBe('https://example.com/');
    expect(data.supported).toBe(true);
    expect(response.metadata.engine).toBe('applescript');
    expect(response.metadata.degraded).toBe(false);
  });

  it('returns empty registrations array when no service workers registered', async () => {
    const payload = JSON.stringify({ registrations: [], supported: true });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_list');
    const response = await handler({ tabUrl: 'https://example.com' });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.registrations).toEqual([]);
  });

  it('returns supported: false when service workers not available', async () => {
    const payload = JSON.stringify({ registrations: [], supported: false });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_list');
    const response = await handler({ tabUrl: 'https://example.com' });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.supported).toBe(false);
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('PERMISSION_DENIED', 'Permission denied')),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_list');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});

// ── safari_sw_unregister ─────────────────────────────────────────────────────

describe('safari_sw_unregister', () => {
  it('returns unregistered: true when service worker found and removed', async () => {
    const payload = JSON.stringify({ unregistered: true, scope: 'https://example.com/' });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_unregister');
    const response = await handler({ tabUrl: 'https://example.com', scope: 'https://example.com/' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('https://example.com/'),
    );
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.unregistered).toBe(true);
    expect(data.scope).toBe('https://example.com/');
    expect(response.metadata.degraded).toBe(false);
  });

  it('returns unregistered: false when no matching scope found', async () => {
    const payload = JSON.stringify({ unregistered: false, error: 'No service worker found for scope: https://example.com/' });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_unregister');
    const response = await handler({ tabUrl: 'https://example.com', scope: 'https://example.com/' });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.unregistered).toBe(false);
    expect(data.error).toContain('No service worker');
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('SAFARI_NOT_RUNNING', 'Safari not running')),
    });
    const tools = new ServiceWorkerTools(engine);
    const handler = tools.getHandler('safari_sw_unregister');
    const response = await handler({ tabUrl: 'https://example.com', scope: 'https://example.com/' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});
