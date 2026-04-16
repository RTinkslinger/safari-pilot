import type { Engine, EngineResult } from '../types.js';
import type { IEngine } from './engine.js';

/**
 * A proxy engine that delegates to whichever engine is currently selected.
 * Tool modules receive this at construction time. Before each tool call,
 * the server sets the active engine via setDelegate(). This way engine
 * selection actually affects which engine executes the JS, not just metadata.
 */
export class EngineProxy implements IEngine {
  readonly name: Engine = 'applescript';
  private delegate: IEngine;

  constructor(defaultEngine: IEngine) {
    this.delegate = defaultEngine;
  }

  setDelegate(engine: IEngine): void {
    this.delegate = engine;
    (this as { name: Engine }).name = engine.name;
  }

  getDelegate(): IEngine {
    return this.delegate;
  }

  isAvailable(): Promise<boolean> {
    return this.delegate.isAvailable();
  }

  execute(script: string, timeout?: number): Promise<EngineResult> {
    return this.delegate.execute(script, timeout);
  }

  executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    return this.delegate.executeJsInTab(tabUrl, jsCode, timeout);
  }

  async shutdown(): Promise<void> {
    // Don't shut down the delegate — it's shared
  }
}
