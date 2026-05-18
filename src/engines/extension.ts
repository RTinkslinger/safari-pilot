import { BaseEngine } from './engine.js';
import type { DaemonEngine } from './daemon.js';
import type { Engine, EngineResult } from '../types.js';
import { ERROR_CODES, ERROR_METADATA } from '../errors.js';

// Internal sentinel prefix used to distinguish extension bridge commands from
// normal AppleScript execution commands routed through the same DaemonEngine.
const INTERNAL_PREFIX = '__SAFARI_PILOT_INTERNAL__';

/**
 * v0.1.36 Track A Fix 2 (completed) — caller's `timeout` is passed through
 * to the daemon verbatim, and the default itself dropped from 90s to 15s.
 *
 * The pre-v0.1.36 default of 90s + `Math.max(timeout ?? 90s, 90s)` floor
 * meant every per-tool-call wait was clamped to 90s even when the handler
 * asked for less. Removing the floor (commit c7d9d51) only helped the ~4
 * handlers that pass an explicit timeout (safari_evaluate, screenshot,
 * the auto-wait in interaction.ts). The other ~50 handlers — including
 * safari_query_all, safari_snapshot, safari_get_text, safari_get_html,
 * and every safari_wait_for poll iteration via wait.ts:evalCondition —
 * still hit 90s because they don't pass a timeout argument. Profiling
 * the median probe-C task (Allrecipes--0, 903s wall) showed 540s of
 * 716s tool time (75%) burning on these 90s defaults.
 *
 * The 90s default was previously justified by an earlier probe's finding
 * that "aggressive defaults turn into retry storms because the
 * DAEMON_TIMEOUT envelope reads as retryable=true." That justification
 * doesn't hold:
 *
 *   1. v0.1.36 ERROR_METADATA[DAEMON_TIMEOUT].retryable is `false` — the
 *      agent is explicitly told NOT to retry on timeout.
 *   2. v0.1.36 F3.1 actually surfaces the structured envelope to the
 *      MCP client (pre-F3.1 it was collapsed to message text and lost).
 *   3. The earlier probe was running on the broken stack (REPO_ROOT
 *      pointed at main's stale dist/, so Fix 2's floor removal never
 *      reached the running TS), which inflated every timeout to 90s
 *      regardless of caller intent and made retry costs synthetic.
 *
 * 15s is the right default for short ops. Tools that legitimately need
 * longer (page loads, downloads, multi-step waits) pass an explicit
 * `timeout` argument — `safari_evaluate` (10s default), the auto-wait
 * inside `safari_click`/`safari_fill` (caller's timeout + 1s), the
 * screenshot fast-path (15s explicit), and `safari_wait_for_download`
 * (caller-supplied). `safari_wait_for` polls via wait.ts:evalCondition
 * with its own short per-iteration timeout (see wait.ts).
 *
 * Override via SP_EXTENSION_DEFAULT_TIMEOUT_MS — useful for tests or
 * specialized deployments that need the legacy 90s behaviour.
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
  // v0.1.36 reviewer F1.2 — session-scoped tab cache.
  // 2026-05-18 evening rework: the daemon identifies each MCP session by
  // its dashboard URL (`http://127.0.0.1:19475/session?id=sess_<n>`), a
  // stable string identifier that crosses the AppleScript / WebExtension
  // boundary safely. Previously the daemon sent the AppleScript window
  // ID; the extension cache's `tab.windowId` is in the WebExtension API
  // namespace; strict-equality match in spFilterBySession rejected every
  // candidate. See extension/lib/session-filter.js header for the full
  // narrative. Undefined before ensureSessionWindow runs (extension_health
  // probes during startup) or when running without a session window.
  private sessionDashboardUrl?: string;

  constructor(daemon: DaemonEngine) {
    super();
    this.daemon = daemon;
  }

  setSessionDashboardUrl(url: string | undefined): void {
    this.sessionDashboardUrl = url;
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
      // F1.2: sessionDashboardUrl is forwarded verbatim by the daemon's
      // ExtensionBridge.handleExecute (params dict is copied wholesale to
      // commandDict, see daemon/Sources/SafariPilotdCore/ExtensionBridge.swift).
      // background.js resolves it to a WebExtension windowId via the
      // sessionDashboardUrlToWindowId Map populated by tabs.onUpdated, then
      // filters findTargetTab candidates by that resolved windowId.
      const payload = JSON.stringify({ script: jsCode, tabUrl, sessionDashboardUrl: this.sessionDashboardUrl });
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
      // F1.2: sessionDashboardUrl travels with frame-scoped calls too.
      const payload = JSON.stringify({ script: jsCode, tabUrl, frameId, sessionDashboardUrl: this.sessionDashboardUrl });
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
