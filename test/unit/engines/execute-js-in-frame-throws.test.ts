import { describe, it, expect } from 'vitest';
import { AppleScriptEngine } from '../../../src/engines/applescript.js';
import { DaemonEngine } from '../../../src/engines/daemon.js';
import { ERROR_CODES } from '../../../src/errors.js';

describe('executeJsInFrame default returns FRAME_NOT_SUPPORTED on non-extension engines (T55a)', () => {
  it('AppleScriptEngine.executeJsInFrame returns FRAME_NOT_SUPPORTED', async () => {
    const engine = new AppleScriptEngine();
    const result = await engine.executeJsInFrame('https://example.com', 5, 'return 1');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
  });

  it('DaemonEngine.executeJsInFrame returns FRAME_NOT_SUPPORTED', async () => {
    const engine = new DaemonEngine();
    const result = await engine.executeJsInFrame('https://example.com', 5, 'return 1');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
  });
});
