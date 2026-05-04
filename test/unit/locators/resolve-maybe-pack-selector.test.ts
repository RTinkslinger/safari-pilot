import { describe, it, expect } from 'vitest';
import { resolveMaybePackSelector } from '../../../src/locator.js';
import type { IEngine } from '../../../src/engines/engine.js';

// ── Engine stub factory ──────────────────────────────────────────────────────
// Implements the IEngine boundary at the exact interface that
// resolveMaybePackSelector() calls: executeJsInTab and executeJsInFrame.
// We do NOT mock any internal module — the stub is a plain object.

function makeEngine(value: string): IEngine {
  return {
    name: 'extension' as const,
    executeJsInTab: async (_url: string, _js: string) => ({
      ok: true as const,
      value,
      elapsed_ms: 0,
    }),
    executeJsInFrame: async (_url: string, _frameId: number, _js: string) => ({
      ok: true as const,
      value,
      elapsed_ms: 0,
    }),
  };
}

function makeFailingEngine(errorMessage: string): IEngine {
  return {
    name: 'extension' as const,
    executeJsInTab: async () => ({
      ok: false as const,
      error: { message: errorMessage, code: 'JS_EVAL_ERROR' as const },
      elapsed_ms: 0,
    }),
    executeJsInFrame: async () => ({
      ok: false as const,
      error: { message: errorMessage, code: 'JS_EVAL_ERROR' as const },
      elapsed_ms: 0,
    }),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('T79 C-7 — resolveMaybePackSelector', () => {
  const routeParams = { tabUrl: 'https://example.com' };

  it('returns selector unchanged when undefined', async () => {
    const engine = makeEngine('{}');
    const result = await resolveMaybePackSelector(engine, routeParams, undefined);
    expect(result).toBeUndefined();
  });

  it('returns selector unchanged when non-pack (CSS class)', async () => {
    const engine = makeEngine('{}');
    const result = await resolveMaybePackSelector(engine, routeParams, '.some-css-class');
    expect(result).toBe('.some-css-class');
  });

  it('resolves pack: prefix to [data-sp-ref="..."] form', async () => {
    const successPayload = JSON.stringify({ found: true, selector: '[data-sp-ref="sp-abc123"]' });
    const engine = makeEngine(successPayload);
    const result = await resolveMaybePackSelector(engine, routeParams, 'pack:myPack=myArg');
    expect(result).toBe('[data-sp-ref="sp-abc123"]');
  });

  it('throws when pack returns {found: false}', async () => {
    const notFoundPayload = JSON.stringify({
      found: false,
      hint: 'selectorPack notExists not registered',
    });
    const engine = makeEngine(notFoundPayload);
    await expect(
      resolveMaybePackSelector(engine, routeParams, 'pack:notExists'),
    ).rejects.toThrow('selectorPack notExists not registered');
  });

  it('throws with engine error message when engine call fails', async () => {
    const engine = makeFailingEngine('pack resolution network error');
    await expect(
      resolveMaybePackSelector(engine, routeParams, 'pack:myPack'),
    ).rejects.toThrow('pack resolution network error');
  });

  it('resolves pack:name without arg (empty arg)', async () => {
    const successPayload = JSON.stringify({ found: true, selector: '[data-sp-ref="sp-xyz789"]' });
    const engine = makeEngine(successPayload);
    const result = await resolveMaybePackSelector(engine, routeParams, 'pack:myPack');
    expect(result).toBe('[data-sp-ref="sp-xyz789"]');
  });
});
