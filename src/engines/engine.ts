import type { Engine, EngineResult } from '../types.js';

export interface IEngine {
  readonly name: Engine;
  isAvailable(): Promise<boolean>;
  execute(script: string, timeout?: number): Promise<EngineResult>;
  executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult>;
  executeJsInFrame(tabUrl: string, frameId: number, jsCode: string, timeout?: number): Promise<EngineResult>;
  shutdown(): Promise<void>;
}

export abstract class BaseEngine implements IEngine {
  abstract readonly name: Engine;
  abstract isAvailable(): Promise<boolean>;
  abstract execute(script: string, timeout?: number): Promise<EngineResult>;
  abstract executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult>;

  /**
   * Default implementation for cross-origin frame execution. AppleScript and
   * Daemon engines inherit this and fail closed with FRAME_NOT_SUPPORTED — only
   * the Extension engine can dispatch into a specific subframe via the
   * extension's frameId-aware messaging.
   *
   * The literal 'FRAME_NOT_SUPPORTED' must match ERROR_CODES.FRAME_NOT_SUPPORTED
   * in src/errors.ts. We use the literal here (rather than importing) to avoid
   * any risk of circular imports between engine.ts and errors.ts.
   */
  async executeJsInFrame(
    _tabUrl: string,
    _frameId: number,
    _jsCode: string,
    _timeout?: number,
  ): Promise<EngineResult> {
    return {
      ok: false,
      error: {
        code: 'FRAME_NOT_SUPPORTED',
        message: 'Cross-origin frame access requires the Safari Pilot extension engine.',
        retryable: false,
      },
      elapsed_ms: 0,
    };
  }

  async shutdown(): Promise<void> {}

  protected wrapScript(jsCode: string): string {
    return `(() => {
  try {
    const __result = (() => { ${jsCode} })();
    return JSON.stringify({ ok: true, value: __result });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: { message: e.message, name: e.name, stack: e.stack }
    });
  }
})()`;
  }

  protected parseResult(raw: string): EngineResult {
    const start = Date.now();
    try {
      const parsed = JSON.parse(raw);
      return {
        ok: parsed.ok,
        value: parsed.ok
          ? typeof parsed.value === 'string'
            ? parsed.value
            : JSON.stringify(parsed.value)
          : undefined,
        error: parsed.ok
          ? undefined
          : {
              code: parsed.error?.name || 'INTERNAL_ERROR',
              message: parsed.error?.message || 'Unknown error',
              retryable: false,
            },
        elapsed_ms: Date.now() - start,
      };
    } catch {
      return { ok: true, value: raw, elapsed_ms: Date.now() - start };
    }
  }
}
