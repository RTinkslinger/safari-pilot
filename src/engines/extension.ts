import { BaseEngine } from './engine.js';
import type { DaemonEngine } from './daemon.js';
import type { Engine, EngineResult } from '../types.js';
import { ERROR_CODES, ERROR_METADATA } from '../errors.js';

// Internal sentinel prefix used to distinguish extension bridge commands from
// normal AppleScript execution commands routed through the same DaemonEngine.
const INTERNAL_PREFIX = '__SAFARI_PILOT_INTERNAL__';

/**
 * v0.1.36 Track A Fix 2 — default per-call timeout for extension execution.
 * Replaced the previous EXTENSION_TIMEOUT_MS=90_000 floor that clamped every
 * caller's timeout upward (Math.max), which produced ~963 errors of "Daemon
 * command 'execute' timed out after 90000ms" in the v0.1.35 single-run bench
 * (~30% of all tool errors). Tools that need longer waits — safari_wait_for,
 * safari_navigate, safari_dismiss_overlays — pass an explicit `timeout`
 * parameter; the default applies to short ops (get_text, click, evaluate,
 * snapshot, query_all, etc.). Override via SP_EXTENSION_DEFAULT_TIMEOUT_MS
 * env var if a deployment proves 15s is too tight.
 */
const DEFAULT_EXTENSION_TIMEOUT_MS = Number.parseInt(
  process.env['SP_EXTENSION_DEFAULT_TIMEOUT_MS'] ?? '15000',
  10,
) || 15_000;

/** Detects daemon's textual "execute timed out" error from the underlying
 *  ExtensionBridge so the engine can translate it to a structured envelope. */
const DAEMON_EXECUTE_TIMEOUT_RE = /Daemon command\s+"execute"\s+timed out\s+after\s+\d+\s*ms/i;

function translateDaemonError(result: EngineResult): EngineResult {
  if (result.ok || !result.error) return result;
  if (DAEMON_EXECUTE_TIMEOUT_RE.test(result.error.message)) {
    const meta = ERROR_METADATA[ERROR_CODES.DAEMON_TIMEOUT];
    return {
      ...result,
      error: {
        code: ERROR_CODES.DAEMON_TIMEOUT,
        message: result.error.message,
        retryable: meta?.retryable ?? true,
        hints: meta?.hints,
      },
    };
  }
  return result;
}

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
   * Returns true when the daemon is running AND the extension has connected at
   * least once via HTTP polling (ipcMechanism is "http").
   *
   * Prior to commit 2 (HTTP IPC), we checked only daemon reachability because
   * the extension connection was ephemeral. With HTTP polling, the extension
   * sets ipcMechanism="http" on first POST /connect — this persists even when
   * the event page is killed between alarm cycles. A daemon where no extension
   * has EVER connected (e.g., a test daemon that can't bind port 19475) will
   * have ipcMechanism="none" and should NOT report as available — commands
   * queued to its bridge will never be picked up.
   */
  async isAvailable(): Promise<boolean> {
    // T55a Task 24: dev/test override — forces the extension to report
    // unavailable so e2e can verify FRAME_NOT_SUPPORTED gating without
    // actually unloading the extension in Safari.
    if (process.env['SAFARI_PILOT_FORCE_NO_EXTENSION'] === '1') return false;
    try {
      const result = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_health`,
      );
      if (!result.ok) return false;
      // Check that the extension has connected at least once to this daemon.
      // ipcMechanism="http" means the extension called POST /connect at least once.
      // ipcMechanism="none" means no extension has ever connected — commands would rot.
      // result.value is a JSON string from daemon.execute() — parse it.
      let parsed: Record<string, unknown> | undefined;
      if (typeof result.value === 'string') {
        try { parsed = JSON.parse(result.value) as Record<string, unknown>; } catch { /* not JSON */ }
      } else if (typeof result.value === 'object') {
        parsed = result.value as Record<string, unknown>;
      }
      const mechanism = parsed?.ipcMechanism;
      return mechanism === 'http' || mechanism === 'tcp';
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
      const daemonResult = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_execute ${payload}`,
        timeout ?? DEFAULT_EXTENSION_TIMEOUT_MS,
      );
      const elapsed_ms = Date.now() - start;

      if (!daemonResult.ok) {
        return translateDaemonError({ ...daemonResult, elapsed_ms });
      }

      // Check if the daemon result contains a _meta wrapper from ExtensionBridge.
      // When present, the value is JSON: {"value": <innerValue>, "_meta": {tabId, tabUrl}}
      // Extract _meta into EngineResult.meta and return the inner value unwrapped.
      try {
        const parsed = JSON.parse(daemonResult.value ?? '');
        if (typeof parsed === 'object' && parsed !== null && '_meta' in parsed) {
          const innerValue = parsed.value;
          const meta = parsed._meta as { tabId?: number; tabUrl?: string };
          return {
            ok: true,
            value: typeof innerValue === 'string'
              ? innerValue
              : innerValue === null || innerValue === undefined
                ? undefined
                : JSON.stringify(innerValue),
            elapsed_ms,
            meta,
          };
        }
      } catch { /* not JSON or not a _meta wrapper — fall through */ }

      return { ...daemonResult, elapsed_ms };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: { code: 'EXTENSION_ERROR', message, retryable: true },
        elapsed_ms: Date.now() - start,
      };
    }
  }

  /**
   * Execute JavaScript inside a specific cross-origin iframe (T55a).
   *
   * Mirrors executeJsInTab but adds frameId to the storage-bus payload.
   * background.js validates frameId via webNavigation.getAllFrames at dispatch,
   * resolves frameUrl from that authoritative source, and writes both into
   * sp_cmd_<commandId>. content-isolated.js's filter rule (route-command.js)
   * reads frameId; the frameUrl mismatch guard catches document-mutation races.
   *
   * frameUrl is intentionally NOT sent from here — the resolution happens in
   * background.js after validation, so we don't pre-fill a value that may be
   * stale by the time the cmd is written.
   */
  async executeJsInFrame(tabUrl: string, frameId: number, jsCode: string, timeout?: number): Promise<EngineResult> {
    const start = Date.now();
    try {
      const payload = JSON.stringify({ script: jsCode, tabUrl, frameId });
      const daemonResult = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_execute ${payload}`,
        timeout ?? DEFAULT_EXTENSION_TIMEOUT_MS,
      );
      const elapsed_ms = Date.now() - start;

      if (!daemonResult.ok) {
        return translateDaemonError({ ...daemonResult, elapsed_ms });
      }

      // Same _meta unwrapping pattern as executeJsInTab — ExtensionBridge wraps
      // success values with {value, _meta} for tab identity metadata.
      try {
        const parsed = JSON.parse(daemonResult.value ?? '');
        if (typeof parsed === 'object' && parsed !== null && '_meta' in parsed) {
          const innerValue = parsed.value;
          const meta = parsed._meta as { tabId?: number; tabUrl?: string };
          return {
            ok: true,
            value: typeof innerValue === 'string'
              ? innerValue
              : innerValue === null || innerValue === undefined
                ? undefined
                : JSON.stringify(innerValue),
            elapsed_ms,
            meta,
          };
        }
      } catch { /* not JSON or not a _meta wrapper — fall through */ }

      return { ...daemonResult, elapsed_ms };
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
        timeout ?? DEFAULT_EXTENSION_TIMEOUT_MS,
      );
      return translateDaemonError({ ...result, elapsed_ms: Date.now() - start });
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
