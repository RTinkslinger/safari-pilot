import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BaseEngine } from './engine.js';
import type { Engine, EngineError, EngineResult } from '../types.js';

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 30_000;

// AppleScript error codes from OSA and Safari
const AS_ERROR_CODES: Record<number, { code: string; retryable: boolean }> = {
  [-600]: { code: 'SAFARI_NOT_RUNNING', retryable: true },
  [-609]: { code: 'SAFARI_CRASHED', retryable: true },
  [-1743]: { code: 'PERMISSION_DENIED', retryable: false },
  [-1728]: { code: 'ELEMENT_NOT_FOUND', retryable: true },
};

export class AppleScriptEngine extends BaseEngine {
  readonly name: Engine = 'applescript';

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('osascript', ['-e', 'tell application "Safari" to return name'], {
        timeout: 5000,
        maxBuffer: MAX_BUFFER,
      });
      return true;
    } catch {
      return false;
    }
  }

  async execute(script: string, timeout: number = DEFAULT_TIMEOUT_MS): Promise<EngineResult> {
    const start = Date.now();
    try {
      const { stdout } = await execFileAsync('osascript', ['-e', script], {
        timeout,
        maxBuffer: MAX_BUFFER,
      });
      const raw = stdout.trim();
      const result = this.parseJsResult(raw);
      return { ...result, elapsed_ms: Date.now() - start };
    } catch (err: unknown) {
      const elapsed = Date.now() - start;
      const engineError = this.classifyError(err);
      return { ok: false, error: engineError, elapsed_ms: elapsed };
    }
  }

  /** Execute a raw AppleScript string directly (for testing/internal use). */
  async executeRaw(script: string, timeout: number = DEFAULT_TIMEOUT_MS): Promise<string> {
    const { stdout } = await execFileAsync('osascript', ['-e', script], {
      timeout,
      maxBuffer: MAX_BUFFER,
    });
    return stdout.trim();
  }

  // ── Script builders ─────────────────────────────────────────────────────────

  /**
   * Build an AppleScript that targets a tab by URL and executes JS inside it.
   */
  public buildTabScript(url: string, jsCode: string): string {
    const wrapped = this.wrapJavaScript(jsCode);
    const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedJs = wrapped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `tell application "Safari"
  set _result to ""
  repeat with _window in every window
    repeat with _tab in every tab of _window
      if URL of _tab is "${escapedUrl}" then
        set _result to do JavaScript "${escapedJs}" in _tab
        return _result
      end if
    end repeat
  end repeat
  return _result
end tell`;
  }

  /**
   * Build an AppleScript that navigates to a URL (opens new document if needed).
   */
  public buildNavigateScript(url: string): string {
    const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `tell application "Safari"
  if (count of windows) is 0 then
    make new document with properties {URL:"${escapedUrl}"}
  else
    set URL of current tab of front window to "${escapedUrl}"
  end if
end tell`;
  }

  /**
   * Build an AppleScript that opens a new tab (optionally in a private window).
   */
  public buildNewTabScript(url: string, privateWindow: boolean = false): string {
    const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (privateWindow) {
      // Private windows require System Events menu click
      return `tell application "Safari" to activate
tell application "System Events"
  tell process "Safari"
    click menu item "New Private Window" of menu "File" of menu bar 1
  end tell
end tell
tell application "Safari"
  set URL of current tab of front window to "${escapedUrl}"
end tell`;
    }
    return `tell application "Safari"
  tell front window
    set _tab to make new tab with properties {URL:"${escapedUrl}"}
    set current tab to _tab
  end tell
end tell`;
  }

  /**
   * Build an AppleScript that closes the tab matching a given URL.
   */
  public buildCloseTabScript(url: string): string {
    const escapedUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `tell application "Safari"
  repeat with _window in every window
    repeat with _tab in every tab of _window
      if URL of _tab is "${escapedUrl}" then
        close _tab
        return true
      end if
    end repeat
  end repeat
  return false
end tell`;
  }

  /**
   * Build an AppleScript that lists all open tabs across all windows.
   */
  public buildListTabsScript(): string {
    return `tell application "Safari"
  set _output to ""
  repeat with _window in every window
    repeat with _tab in every tab of _window
      set _output to _output & (URL of _tab) & "\\t" & (name of _tab) & "\\n"
    end repeat
  end repeat
  return _output
end tell`;
  }

  // ── JS wrapping & result parsing ────────────────────────────────────────────

  /**
   * Wrap a JS snippet in a try/catch serialization harness.
   * Returns a single-line string safe for embedding in AppleScript do JavaScript.
   */
  public wrapJavaScript(jsCode: string): string {
    return `(function(){try{var __r=(function(){${jsCode}})();return JSON.stringify({ok:true,value:__r});}catch(e){return JSON.stringify({ok:false,error:{message:e.message,name:e.name}});}})()`;
  }

  /**
   * Parse the raw string returned by do JavaScript / osascript stdout.
   * Handles JSON envelope, CSP/ShadowDOM signals, and bare string results.
   */
  public parseJsResult(raw: string): EngineResult {
    const start = Date.now();

    // Detect CSP-blocked execution (Safari returns empty or specific error text)
    if (
      raw === '' ||
      raw.toLowerCase().includes('content security policy') ||
      raw.toLowerCase().includes('blocked by csp')
    ) {
      if (raw === '' || raw.toLowerCase().includes('content security policy') || raw.toLowerCase().includes('blocked by csp')) {
        // Only classify empty as CSP_BLOCKED if it looks like a blocked signal,
        // but for the harness we rely on the structured envelope. Bare empty = CSP.
        if (raw.toLowerCase().includes('content security policy') || raw.toLowerCase().includes('blocked by csp')) {
          return {
            ok: false,
            error: { code: 'CSP_BLOCKED', message: 'JavaScript execution blocked by Content Security Policy', retryable: false },
            elapsed_ms: Date.now() - start,
          };
        }
      }
    }

    // Detect shadow DOM closed signal
    if (raw.toLowerCase().includes('shadow') && raw.toLowerCase().includes('closed')) {
      return {
        ok: false,
        error: { code: 'SHADOW_DOM_CLOSED', message: 'Cannot access closed shadow root', retryable: false },
        elapsed_ms: Date.now() - start,
      };
    }

    // Try to parse JSON envelope
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
        if (parsed.ok) {
          const val = parsed.value;
          return {
            ok: true,
            value: val === undefined || val === null
              ? undefined
              : typeof val === 'string'
                ? val
                : JSON.stringify(val),
            elapsed_ms: Date.now() - start,
          };
        } else {
          const errName: string = parsed.error?.name ?? 'Error';
          const errMsg: string = parsed.error?.message ?? 'Unknown error';
          // Map known JS error names to engine codes
          const code = this.mapJsErrorName(errName);
          return {
            ok: false,
            error: { code, message: errMsg, retryable: false },
            elapsed_ms: Date.now() - start,
          };
        }
      }
    } catch {
      // Not JSON — treat raw string as successful result
    }

    // Raw non-JSON string → treat as success value
    return { ok: true, value: raw, elapsed_ms: Date.now() - start };
  }

  /**
   * Parse an AppleScript error from stderr or error message text.
   * Extracts OSA error codes via regex.
   */
  public parseAppleScriptError(stderr: string): EngineError {
    // AppleScript errors embed the code in parens: "... (-600)"
    const match = stderr.match(/\((-?\d+)\)/);
    if (match) {
      const code = parseInt(match[1], 10);
      const known = AS_ERROR_CODES[code];
      if (known) {
        return {
          code: known.code,
          message: stderr.trim(),
          retryable: known.retryable,
        };
      }
    }
    return {
      code: 'APPLESCRIPT_ERROR',
      message: stderr.trim() || 'Unknown AppleScript error',
      retryable: false,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private classifyError(err: unknown): EngineError {
    if (err && typeof err === 'object') {
      const e = err as { killed?: boolean; signal?: string; stderr?: string; message?: string; code?: string | number };

      // Timeout / killed process
      if (e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL') {
        return { code: 'TIMEOUT', message: 'osascript process timed out', retryable: true };
      }

      // stderr contains AppleScript error code
      if (e.stderr && typeof e.stderr === 'string' && e.stderr.length > 0) {
        return this.parseAppleScriptError(e.stderr);
      }

      // message may contain the error text
      if (e.message && typeof e.message === 'string') {
        const asMatch = e.message.match(/\((-?\d+)\)/);
        if (asMatch) {
          return this.parseAppleScriptError(e.message);
        }
      }
    }

    return {
      code: 'UNKNOWN_ERROR',
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }

  private mapJsErrorName(name: string): string {
    switch (name) {
      case 'SecurityError': return 'PERMISSION_DENIED';
      case 'TypeError': return 'TYPE_ERROR';
      case 'ReferenceError': return 'REFERENCE_ERROR';
      default: return 'JS_ERROR';
    }
  }
}
