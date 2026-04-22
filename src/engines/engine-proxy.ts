import type { Engine, EngineResult } from '../types.js';
import type { IEngine } from './engine.js';
import type { AppleScriptEngine } from './applescript.js';

/**
 * A proxy engine that delegates to whichever engine is currently selected.
 * Tool modules receive this at construction time. Before each tool call,
 * the server sets the active engine via setDelegate(). This way engine
 * selection actually affects which engine executes the JS, not just metadata.
 *
 * Also captures the `meta` field from the most recent executeJsInTab() result,
 * allowing the server to read tab identity after tool execution without
 * requiring changes to the tool handler return type.
 *
 * Positional targeting: when the server sets tabPosition before a tool call,
 * executeJsInTab uses `do JavaScript in tab N of window id M` (AppleScript)
 * instead of URL iteration. This prevents wrong-tab targeting when multiple
 * tabs share the same URL.
 */
export class EngineProxy implements IEngine {
  readonly name: Engine = 'applescript';
  private delegate: IEngine;
  private _lastMeta: { tabId?: number; tabUrl?: string } | undefined;
  private _tabPosition: { windowId: number; tabIndex: number } | undefined;

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
   * Set positional identity for the current tool call. When set,
   * executeJsInTab targets the exact tab by window/position instead of URL.
   * Cleared by resetMeta() at the start of each tool call.
   */
  setTabPosition(pos: { windowId: number; tabIndex: number } | undefined): void {
    this._tabPosition = pos;
  }

  /**
   * Reset meta and position before each tool call to prevent stale reads.
   * Must be called at the start of executeToolWithSecurity().
   */
  resetMeta(): void {
    this._lastMeta = undefined;
    this._tabPosition = undefined;
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
    // When positional identity is available and delegate is AppleScript-based,
    // use positional targeting instead of URL iteration.
    if (this._tabPosition && this.delegate.name !== 'extension') {
      const as = this.delegate as unknown as AppleScriptEngine;
      if (typeof as.executeJsInTabByPosition === 'function') {
        const result = await as.executeJsInTabByPosition(
          this._tabPosition.windowId,
          this._tabPosition.tabIndex,
          jsCode,
          timeout,
        );
        this._lastMeta = result.meta;
        return result;
      }
    }
    const result = await this.delegate.executeJsInTab(tabUrl, jsCode, timeout);
    this._lastMeta = result.meta;
    return result;
  }

  async shutdown(): Promise<void> {
    // Don't shut down the delegate — it's shared
  }
}
