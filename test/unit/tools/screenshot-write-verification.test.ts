import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SafariPilotError } from '../../../src/errors.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

// This file needs the REAL node:fs/promises (verifyScreenshotWrittenOrThrow
// stat()s real temp files). Under `isolate: false`, a sibling test
// (extraction-screenshot-handler) mocks node:fs/promises, and the shared
// extraction.ts module instance can carry that mock here. Reset the module
// registry + re-import fresh in beforeEach so extraction.ts binds the real
// fs/promises for this file. Order-independent.
let verifyScreenshotWrittenOrThrow: typeof import('../../../src/tools/extraction.js').verifyScreenshotWrittenOrThrow;
let ExtractionTools: typeof import('../../../src/tools/extraction.js').ExtractionTools;

beforeEach(async () => {
  vi.resetModules();
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('node:child_process');
  ({ verifyScreenshotWrittenOrThrow, ExtractionTools } = await import('../../../src/tools/extraction.js'));
});

// v0.1.37 fix #2 — `safari_take_screenshot` returned is_error:None with
// an [IMAGE] body in the v0.1.36 c=4 probe for ~10 of 22 SP-lost tasks,
// but the file at `params.path` did NOT exist when the bench harness
// extracted the score. The chain inside handleTakeScreenshot is:
//   (a) extension or screencapture produces a base64 string
//   (b) Buffer.from(base64, 'base64') (possibly small or truncated)
//   (c) await writeFile(savePath, buf)
//   (d) return success
// Empirically, (d) sometimes happens with a missing or zero-byte file.
// This helper + handler-integration verifies the file landed AND has a
// non-trivial size BEFORE the handler is allowed to return success —
// converts silent failure into a structured CAPTURE_FAILED the agent
// (and judge) can observe.

describe('verifyScreenshotWrittenOrThrow (v0.1.37 fix #2)', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'sp-shotverify-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns normally when the file exists with a non-trivial PNG payload', async () => {
    const p = join(dir, 'good.png');
    writeFileSync(p, Buffer.alloc(100, 1));
    await expect(verifyScreenshotWrittenOrThrow(p)).resolves.toBeUndefined();
  });

  it('throws CAPTURE_FAILED when the file is missing', async () => {
    const p = join(dir, 'never-existed.png');
    let thrown: unknown;
    try { await verifyScreenshotWrittenOrThrow(p); } catch (e) { thrown = e; }
    expect(thrown, 'helper must throw on missing file').toBeDefined();
    expect((thrown as SafariPilotError).code).toBe('CAPTURE_FAILED');
    expect((thrown as Error).message.toLowerCase()).toMatch(/(missing|empty|small|size|bytes|written|exist)/);
  });

  it('throws CAPTURE_FAILED when the file exists but is zero bytes', async () => {
    const p = join(dir, 'zero.png');
    writeFileSync(p, Buffer.alloc(0));
    let thrown: unknown;
    try { await verifyScreenshotWrittenOrThrow(p); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect((thrown as SafariPilotError).code).toBe('CAPTURE_FAILED');
    expect((thrown as Error).message.toLowerCase()).toMatch(/(missing|empty|small|size|bytes)/);
  });

  it('throws CAPTURE_FAILED on 99-byte file (boundary just under 100B threshold)', async () => {
    const p = join(dir, 'b99.png');
    writeFileSync(p, Buffer.alloc(99, 0));
    let thrown: unknown;
    try { await verifyScreenshotWrittenOrThrow(p); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect((thrown as SafariPilotError).code).toBe('CAPTURE_FAILED');
  });

  it('returns normally on 101-byte file (boundary just over 100B threshold)', async () => {
    const p = join(dir, 'b101.png');
    writeFileSync(p, Buffer.alloc(101, 0));
    await expect(verifyScreenshotWrittenOrThrow(p)).resolves.toBeUndefined();
  });
});

describe('handleTakeScreenshot wires verification — silent capture failures must surface as CAPTURE_FAILED', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'sp-shothandler-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Minimal IEngine stub. Returns a controllable base64 payload for the
   * `__SP_TAKE_SCREENSHOT__` script; any other call rejects so we don't
   * mask the real failure mode. */
  function makeStubEngine(base64ToReturn: string): IEngine {
    return {
      name: 'extension',
      async isAvailable() { return true; },
      async start() { /* noop */ },
      async shutdown() { /* noop */ },
      async execute() { throw new Error('stub: execute unused in this test'); },
      async executeJsInTab(_tabUrl: string, jsCode: string, _timeout?: number): Promise<EngineResult> {
        if (jsCode === '__SP_TAKE_SCREENSHOT__') {
          return { ok: true, value: base64ToReturn, elapsed_ms: 5 };
        }
        return { ok: false, error: { code: 'UNEXPECTED_CALL', message: 'stub: not stubbed', retryable: false }, elapsed_ms: 0 };
      },
      async executeJsInFrame() { throw new Error('stub: frame unused'); },
      capabilities: {
        domQuery: true, jsExecution: true, networkIntercept: false,
        framesCrossOrigin: false, cspBypass: false, shadowDom: true,
      },
    } as unknown as IEngine;
  }

  it('returns CAPTURE_FAILED error envelope when capture base64 decodes to a sub-100B file', async () => {
    // A 40-char base64 string decodes to 30 bytes — passes the existing
    // base64.length>0 check inside handleTakeScreenshot but is well below
    // the 100B threshold the verifier guards. Pre-fix this would return
    // [IMAGE] with is_error:None and the bench harness would see a tiny
    // file (or none). Post-fix the helper throws CAPTURE_FAILED.
    const shortBase64 = 'A'.repeat(40); // decodes to 30 bytes
    const tools = new ExtractionTools(makeStubEngine(shortBase64));
    const handler = tools.getHandler('safari_take_screenshot')!;
    const path = join(dir, 'short-capture.png');

    let thrown: unknown;
    let response: unknown;
    try {
      response = await handler({ tabUrl: 'https://example.test/', path });
    } catch (e) {
      thrown = e;
    }
    // Either the handler throws (preferred — propagates to the security
    // wrapper which converts to MCP error envelope) OR it returns a
    // ToolResponse with isError:true. Both are valid contracts; the
    // banned shape is returning [IMAGE] content with no error.
    if (thrown !== undefined) {
      expect((thrown as SafariPilotError).code).toBe('CAPTURE_FAILED');
    } else {
      expect(response, 'must not return success envelope for tiny file').toBeDefined();
      const r = response as { content?: Array<{ type: string }>; isError?: boolean };
      const onlyImage = r.content?.every((c) => c.type === 'image') ?? false;
      expect(
        !(onlyImage && !r.isError),
        'handler returned [IMAGE] success envelope despite tiny written file — silent failure not fixed',
      ).toBe(true);
    }
  });

  it('returns success envelope when capture base64 decodes to a non-trivial file (>100B)', async () => {
    // 200 'A' chars → 150 bytes after base64 decode. Above the 100B
    // threshold so verifier accepts. Ensures the fix doesn't over-reject.
    const longBase64 = 'A'.repeat(200);
    const tools = new ExtractionTools(makeStubEngine(longBase64));
    const handler = tools.getHandler('safari_take_screenshot')!;
    const path = join(dir, 'good-capture.png');
    const response = await handler({ tabUrl: 'https://example.test/', path });
    expect(response.content?.[0]?.type).toBe('image');
    // And the file actually landed.
    expect(readFileSync(path).length).toBeGreaterThan(100);
  });
});
