import type { Engine, EngineResult } from '../types.js';
import type { IEngine } from './engine.js';

/**
 * A proxy engine that delegates to whichever engine is currently selected.
 * Tool modules receive this at construction time. Before each tool call,
 * the server sets the active engine via setDelegate(). This way engine
 * selection actually affects which engine executes the JS, not just metadata.
 *
 * Also captures the `meta` field from the most recent executeJsInTab() result,
 * allowing the server to read tab identity after tool execution without
 * requiring changes to the tool handler return type.
 */
export class EngineProxy implements IEngine {
  readonly name: Engine = 'applescript';
  private delegate: IEngine;
  private _lastMeta: { tabId?: number; tabUrl?: string } | undefined;

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

  /**
   * Reset meta before each tool call to prevent stale reads from a previous call.
   * Must be called at the start of executeToolWithSecurity().
   */
  resetMeta(): void {
    this._lastMeta = undefined;
  }

  /**
   * Returns the meta from the most recent executeJsInTab() call, or undefined
   * if the last call was execute() or no call has been made since resetMeta().
   */
  getLastMeta(): { tabId?: number; tabUrl?: string } | undefined {
    return this._lastMeta;
  }

  isAvailable(): Promise<boolean> {
    return this.delegate.isAvailable();
  }

  execute(script: string, timeout?: number): Promise<EngineResult> {
    return this.delegate.execute(script, timeout);
  }

  async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    const result = await this.delegate.executeJsInTab(tabUrl, jsCode, timeout);
    this._lastMeta = result.meta;
    return result;
  }

  async shutdown(): Promise<void> {
    // Don't shut down the delegate — it's shared
  }
}
