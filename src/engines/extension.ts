import { BaseEngine } from './engine.js';
import type { DaemonEngine } from './daemon.js';
import type { Engine, EngineResult } from '../types.js';

// Internal sentinel prefix used to distinguish extension bridge commands from
// normal AppleScript execution commands routed through the same DaemonEngine.
const INTERNAL_PREFIX = '__SAFARI_PILOT_INTERNAL__';

/**
 * ExtensionEngine routes JavaScript execution through the Safari extension via the daemon.
 *
 * Execution path: MCP server → DaemonEngine → daemon ExtensionBridge → Safari extension
 * background.js → content script (MAIN world) → result flows back the same way.
 *
 * The engine is only available when:
 *   1. The daemon is running (DaemonEngine.isAvailable() returns true).
 *   2. The Safari extension is installed and has established a native messaging connection.
 *
 * When the extension is not connected, isAvailable() returns false and the engine
 * selector will fall back to the daemon (AppleScript) or applescript engine.
 */
export class ExtensionEngine extends BaseEngine {
  readonly name: Engine = 'extension';
  private daemon: DaemonEngine;

  constructor(daemon: DaemonEngine) {
    super();
    this.daemon = daemon;
  }

  /**
   * Returns true only when the daemon is running AND the extension is connected.
   * The status check is routed through the daemon's extension_status command.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_status`,
      );
      return result.ok && result.value === 'connected';
    } catch {
      return false;
    }
  }

  /**
   * Execute a JavaScript string in the Safari extension's MAIN world content script.
   *
   * The script is forwarded through the daemon's ExtensionBridge to background.js,
   * which injects it into the active tab's MAIN world via chrome.scripting.executeScript.
   * The result is returned as a string (JSON-serialised if the script returns an object).
   */
  async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    const start = Date.now();
    try {
      const payload = JSON.stringify({ script: jsCode, tabUrl });
      const result = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_execute ${payload}`,
        timeout,
      );
      return { ...result, elapsed_ms: Date.now() - start };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: { code: 'EXTENSION_ERROR', message, retryable: true },
        elapsed_ms: Date.now() - start,
      };
    }
  }

  async execute(script: string, timeout?: number): Promise<EngineResult> {
    const start = Date.now();
    try {
      const payload = JSON.stringify({ script });
      const result = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_execute ${payload}`,
        timeout,
      );
      return { ...result, elapsed_ms: Date.now() - start };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: 'EXTENSION_ERROR',
          message,
          retryable: true,
        },
        elapsed_ms: Date.now() - start,
      };
    }
  }
}
