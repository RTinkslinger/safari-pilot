/**
 * Task 6: handleTakeScreenshot routes to extension via the
 * `__SP_TAKE_SCREENSHOT__` sentinel passed to engine.executeJsInTab.
 *
 * Plan: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md (Task 6, Step 1)
 */
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

function makeFakeEngine(result: EngineResult): IEngine {
  return {
    name: 'extension' as const,
    isAvailable: async () => true,
    execute: vi.fn(async () => result),
    executeJsInTab: vi.fn(async () => result),
    executeJsInFrame: vi.fn(async () => result),
    shutdown: vi.fn(async () => {}),
  } as unknown as IEngine;
}

describe('safari_take_screenshot handler (Task 6)', () => {
  it('rejects format!=png with INVALID_PARAMS and does NOT call engine', async () => {
    const engine = makeFakeEngine({ ok: true, value: 'AAAA', elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    await expect(handler({ tabUrl: 'https://example.com', format: 'jpeg' }))
      .rejects.toMatchObject({ message: expect.stringContaining('jpeg') });
    expect(engine.executeJsInTab).not.toHaveBeenCalled();
  });

  it('decodes base64 and returns image content', async () => {
    // 4-byte PNG-ish data: a real test would use a tiny valid PNG; this is fine for shape
    const fakeB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const engine = makeFakeEngine({ ok: true, value: fakeB64, elapsed_ms: 5 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    const res = await handler({ tabUrl: 'https://example.com' });
    expect(res.content[0]?.type).toBe('image');
    expect(res.content[0]?.mimeType).toBe('image/png');
    expect((res.content[0] as { data: string }).data).toBe(fakeB64);
    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', '__SP_TAKE_SCREENSHOT__', 30_000);
  });

  it('propagates result.error.code on engine failure', async () => {
    const engine = makeFakeEngine({ ok: false, error: { code: 'TAB_NOT_FOUND', message: 'no such tab', retryable: false }, elapsed_ms: 2 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    let thrown: unknown;
    try { await handler({ tabUrl: 'https://gone.example.com' }); } catch (e) { thrown = e; }
    expect((thrown as Error & { code?: string }).code).toBe('TAB_NOT_FOUND');
  });

  it('throws CAPTURE_FAILED when result.value is empty', async () => {
    const engine = makeFakeEngine({ ok: true, value: '', elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    await expect(handler({ tabUrl: 'https://example.com' }))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });
});
