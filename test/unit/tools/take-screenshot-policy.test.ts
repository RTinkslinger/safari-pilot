/**
 * T59 — ScreenshotPolicy must run BEFORE the engine call.
 *
 * Old (pre-2026-05-08): policy gated screencaptureRunner DI; that DI was
 * removed in Task 6 of the take-screenshot-webview plan (commit a6412808).
 * New: policy gates engine.executeJsInTab. If a domain is blocked, the engine
 * is never invoked.
 *
 * Plan: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md (Task 7)
 *
 * Boundary policy: imports IEngine type, constructs a plain-object engine via
 * `as unknown as IEngine` cast (no vi.mock of internal modules). ExtractionTools
 * is the unit under test — imported directly from src per unit-scope policy.
 */
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

function makeFakeEngine(): IEngine {
  const ok: EngineResult = { ok: true, value: 'AAAA', elapsed_ms: 1 };
  return {
    name: 'extension' as const,
    isAvailable: async () => true,
    execute: vi.fn(async () => ok),
    executeJsInTab: vi.fn(async () => ok),
    executeJsInFrame: vi.fn(async () => ok),
    shutdown: vi.fn(async () => {}),
  } as unknown as IEngine;
}

describe('safari_take_screenshot — ScreenshotPolicy gates engine call', () => {
  it('blocked tabUrl: throws ScreenshotBlockedError, engine NOT called', async () => {
    const policy = new ScreenshotPolicy({ blockedPatterns: ['^blocked\\.example\\.com$'] });
    const engine = makeFakeEngine();
    const tools = new ExtractionTools(engine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await expect(handler({ tabUrl: 'https://blocked.example.com/page' })).rejects.toThrow(
      /screenshot|blocked/i,
    );
    expect(engine.executeJsInTab).not.toHaveBeenCalled();
  });

  it('unblocked tabUrl: engine IS called', async () => {
    const policy = new ScreenshotPolicy({ blockedPatterns: ['^other\\.example\\.com$'] });
    const engine = makeFakeEngine();
    const tools = new ExtractionTools(engine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await handler({ tabUrl: 'https://allowed.example.com/page' });
    // 15s extension cap (was 30s pre-130f9ba). The extension layer applies
    // Math.max(timeout, 90_000), so the effective cap is 90s on the extension
    // side; the handler's local 15s race short-circuits stuck pages to the
    // screencapture fallback. See src/tools/extraction.ts handleTakeScreenshot.
    expect(engine.executeJsInTab).toHaveBeenCalledWith(
      'https://allowed.example.com/page',
      '__SP_TAKE_SCREENSHOT__',
      15_000,
    );
  });

  it('no policy configured: engine still called', async () => {
    const engine = makeFakeEngine();
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await handler({ tabUrl: 'https://example.com' });
    expect(engine.executeJsInTab).toHaveBeenCalledOnce();
  });
});
