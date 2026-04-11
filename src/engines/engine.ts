import type { Engine, EngineResult } from '../types.js';

export interface IEngine {
  readonly name: Engine;
  isAvailable(): Promise<boolean>;
  execute(script: string, timeout?: number): Promise<EngineResult>;
  shutdown(): Promise<void>;
}

export abstract class BaseEngine implements IEngine {
  abstract readonly name: Engine;
  abstract isAvailable(): Promise<boolean>;
  abstract execute(script: string, timeout?: number): Promise<EngineResult>;

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
