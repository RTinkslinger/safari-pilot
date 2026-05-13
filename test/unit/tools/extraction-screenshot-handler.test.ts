/**
 * Task 6 + Fix B: handleTakeScreenshot routes to the extension via the
 * `__SP_TAKE_SCREENSHOT__` sentinel on engine.executeJsInTab. As of
 * `130f9ba` (Fix B, 2026-05-12), if the extension capture fails (any
 * reason — local 15s timeout, engine ok:false, empty payload) the handler
 * falls back to macOS `screencapture` invoked via `execFile`. If THAT
 * also fails, the handler throws CAPTURE_FAILED with a chained message
 * carrying both error sources.
 *
 * Plan:
 *   - Original: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md (Task 6, Step 1)
 *   - Fix B: TRACES.md iter 78 (commit 130f9ba)
 *
 * Boundary policy: Node boundaries (`child_process`, `fs/promises`) are
 * mocked at module-level so the fallback's `osascript` + `screencapture`
 * calls can be controlled. ExtractionTools (the unit under test) is
 * imported directly from src per unit-scope policy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module-level mocks. The handler dynamically imports nothing — it imports
// these at the top of extraction.ts via promisify(execFile), readFile, etc.
// We mock the upstream modules and supply a controllable execFile that
// errors by default (so the fallback fails, matching the unit-test
// environment where there's no live Safari tab to activate).
const execFileMock = vi.fn(
  (_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null) => void) => {
    if (typeof cb === 'function') cb(new Error('mock execFile: no Safari in unit test env'));
    return { kill: () => {} } as unknown as { kill: () => void };
  },
);

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb?: (e: Error | null) => void) =>
    execFileMock(cmd, args, opts, cb),
}));

const readFileMock = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])); // not reached in fail-path tests
const writeFileMock = vi.fn(async () => {});
const unlinkMock = vi.fn(async () => {});
vi.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]) => readFileMock(...(args as Parameters<typeof readFileMock>)),
  writeFile: (...args: unknown[]) => writeFileMock(...(args as Parameters<typeof writeFileMock>)),
  unlink: (...args: unknown[]) => unlinkMock(...(args as Parameters<typeof unlinkMock>)),
}));

// Import AFTER mocks are declared so extraction.ts captures the mocked symbols.
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

beforeEach(() => {
  execFileMock.mockClear();
  readFileMock.mockClear();
  writeFileMock.mockClear();
  unlinkMock.mockClear();
});

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

describe('safari_take_screenshot handler (Task 6 + Fix B)', () => {
  it('rejects format!=png with INVALID_PARAMS and does NOT call engine', async () => {
    const engine = makeFakeEngine({ ok: true, value: 'AAAA', elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    await expect(handler({ tabUrl: 'https://example.com', format: 'jpeg' }))
      .rejects.toMatchObject({ message: expect.stringContaining('jpeg') });
    expect(engine.executeJsInTab).not.toHaveBeenCalled();
  });

  it('happy path: extension returns base64, fallback NOT invoked', async () => {
    const fakeB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const engine = makeFakeEngine({ ok: true, value: fakeB64, elapsed_ms: 5 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    const res = await handler({ tabUrl: 'https://example.com' });
    expect(res.content[0]?.type).toBe('image');
    expect(res.content[0]?.mimeType).toBe('image/png');
    expect((res.content[0] as { data: string }).data).toBe(fakeB64);
    expect(engine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      '__SP_TAKE_SCREENSHOT__',
      15_000,
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(res.metadata).toMatchObject({ engine: 'extension', degraded: false });
  });

  it('extension engine ok:false → falls back to screencapture; fallback fails → CAPTURE_FAILED with chained message', async () => {
    const engine = makeFakeEngine({
      ok: false,
      error: { code: 'TAB_NOT_FOUND', message: 'no such tab', retryable: false },
      elapsed_ms: 2,
    });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    let thrown: unknown;
    try {
      await handler({ tabUrl: 'https://gone.example.com' });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error & { code?: string }).code).toBe('CAPTURE_FAILED');
    // Both error sources surfaced in the message:
    expect((thrown as Error).message).toMatch(/Screenshot failed/);
    expect((thrown as Error).message).toMatch(/no such tab/);
    // Fallback was attempted (osascript first, then screencapture not reached because osascript errored):
    expect(execFileMock).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object), expect.any(Function));
  });

  it('extension returns empty value → falls back to screencapture; fallback fails → CAPTURE_FAILED', async () => {
    const engine = makeFakeEngine({ ok: true, value: '', elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    let thrown: unknown;
    try {
      await handler({ tabUrl: 'https://example.com' });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error & { code?: string }).code).toBe('CAPTURE_FAILED');
    expect(execFileMock).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object), expect.any(Function));
  });

  it('extension fails, fallback succeeds (osascript + screencapture both return ok) → degraded:true, engine:"applescript"', async () => {
    // Override execFile mock to succeed for both osascript and screencapture
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null) => void) => {
        if (typeof cb === 'function') cb(null);
        return { kill: () => {} } as unknown as { kill: () => void };
      },
    );
    const fakePngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    readFileMock.mockResolvedValueOnce(fakePngBuf);

    const engine = makeFakeEngine({ ok: false, error: { code: 'EXT_DOWN', message: 'no extension', retryable: false }, elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    const res = await handler({ tabUrl: 'https://example.com' });
    expect((res.content[0] as { data: string }).data).toBe(fakePngBuf.toString('base64'));
    expect(res.metadata).toMatchObject({ engine: 'applescript', degraded: true });
    expect(execFileMock).toHaveBeenCalledWith('osascript', expect.any(Array), expect.any(Object), expect.any(Function));
    expect(execFileMock).toHaveBeenCalledWith('screencapture', expect.any(Array), expect.any(Object), expect.any(Function));
  });
});
