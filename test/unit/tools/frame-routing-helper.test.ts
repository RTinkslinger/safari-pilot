// Unit tests for the shared frame-routing helper (T55a Task 6).
// Verifies the dispatch contract used by 10 frame-aware tool handlers:
//   frameId omitted/0       → executeJsInTab (top frame, any engine)
//   frameId > 0 + extension → executeJsInFrame
//   frameId > 0 + non-ext   → throws FrameNotSupportedError (FRAME_NOT_SUPPORTED)

import { describe, it, expect } from 'vitest';
import { routeFrameAware } from '../../../src/tools/_frame-routing-helper.js';
import { ERROR_CODES } from '../../../src/errors.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

const okResult: EngineResult = { ok: true, value: '{"x":1}', elapsed_ms: 1 };

interface RecordedCall {
  method: 'executeJsInTab' | 'executeJsInFrame';
  args: unknown[];
}

function recordingEngine(name: Engine, result: EngineResult = okResult) {
  const calls: RecordedCall[] = [];
  const engine = {
    name,
    isAvailable: async () => true,
    execute: async () => result,
    executeJsInTab: async (...args: unknown[]) => {
      calls.push({ method: 'executeJsInTab', args });
      return result;
    },
    executeJsInFrame: async (...args: unknown[]) => {
      calls.push({ method: 'executeJsInFrame', args });
      return result;
    },
    shutdown: async () => {},
  } as unknown as IEngine & { calls: RecordedCall[] };
  (engine as unknown as { calls: RecordedCall[] }).calls = calls;
  return engine;
}

describe('routeFrameAware (T55a)', () => {
  it('frameId omitted → calls executeJsInTab', async () => {
    const engine = recordingEngine('extension');
    await routeFrameAware(engine, { tabUrl: 'https://x' }, 'js-code');
    expect((engine as unknown as { calls: RecordedCall[] }).calls).toEqual([
      { method: 'executeJsInTab', args: ['https://x', 'js-code', undefined] },
    ]);
  });

  it('frameId set + extension engine → calls executeJsInFrame', async () => {
    const engine = recordingEngine('extension');
    await routeFrameAware(engine, { tabUrl: 'https://x', frameId: 5 }, 'js-code');
    expect((engine as unknown as { calls: RecordedCall[] }).calls).toEqual([
      { method: 'executeJsInFrame', args: ['https://x', 5, 'js-code', undefined] },
    ]);
  });

  it('frameId set + non-extension engine → throws FRAME_NOT_SUPPORTED', async () => {
    const engine = recordingEngine('applescript');
    await expect(
      routeFrameAware(engine, { tabUrl: 'https://x', frameId: 5 }, 'js-code'),
    ).rejects.toMatchObject({ code: ERROR_CODES.FRAME_NOT_SUPPORTED });
    expect((engine as unknown as { calls: RecordedCall[] }).calls).toEqual([]);
  });

  it('frameId === 0 explicitly is treated as omitted (top frame, any engine)', async () => {
    const engine = recordingEngine('applescript');
    await routeFrameAware(engine, { tabUrl: 'https://x', frameId: 0 }, 'js-code');
    expect((engine as unknown as { calls: RecordedCall[] }).calls).toEqual([
      { method: 'executeJsInTab', args: ['https://x', 'js-code', undefined] },
    ]);
  });

  it('passes timeout through when provided', async () => {
    const engine = recordingEngine('extension');
    await routeFrameAware(engine, { tabUrl: 'https://x', frameId: 5 }, 'js-code', 12345);
    expect((engine as unknown as { calls: RecordedCall[] }).calls).toEqual([
      { method: 'executeJsInFrame', args: ['https://x', 5, 'js-code', 12345] },
    ]);
  });
});
