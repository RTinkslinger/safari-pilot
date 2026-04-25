// Shared JS-execution helpers used by both AppleScriptEngine and DaemonEngine.
//
// Both engines run JavaScript inside Safari via AppleScript `do JavaScript`
// (the daemon just forwards `osascript` server-side). Pre-T32 each engine
// inlined its own `wrap → escape → tab-script template → result-parse`
// pipeline; the two diverged — DaemonEngine missed CSP detection,
// ShadowDOM-closed signals, and structured JS-error code mapping. This
// module is the single source of truth so the two engines cannot drift
// again.

import type { EngineResult } from '../types.js';

/**
 * Wrap a JS snippet in a try/catch serialization harness so `return` works
 * inside `do JavaScript` and results round-trip as JSON. Returns a
 * single-line string safe for embedding into AppleScript.
 */
export function wrapJavaScript(jsCode: string): string {
  return `(function(){try{var __r=(function(){${jsCode}})();return JSON.stringify({ok:true,value:__r});}catch(e){return JSON.stringify({ok:false,error:{message:e.message,name:e.name}});}})()`;
}

/**
 * Build an AppleScript that targets a tab by current URL and executes
 * the provided JS inside it. URL match accepts trailing-slash variants
 * because Safari normalizes URLs.
 */
export function buildTabScript(url: string, jsCode: string): string {
  const safeUrl = url ?? '';
  const escapedUrl = safeUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedJs = jsCode.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Safari"
  set _result to ""
  repeat with _window in every window
    repeat with _tab in every tab of _window
      set _tabUrl to URL of _tab
      -- Match exact URL, or with/without trailing slash (Safari normalizes URLs)
      if _tabUrl is "${escapedUrl}" or _tabUrl is ("${escapedUrl}" & "/") or ("${escapedUrl}" is (_tabUrl & "/")) then
        set _result to do JavaScript "${escapedJs}" in _tab
        return _result
      end if
    end repeat
  end repeat
  return _result
end tell`;
}

function mapJsErrorName(name: string): string {
  switch (name) {
    case 'SecurityError': return 'PERMISSION_DENIED';
    case 'TypeError': return 'TYPE_ERROR';
    case 'ReferenceError': return 'REFERENCE_ERROR';
    default: return 'JS_ERROR';
  }
}

/**
 * Parse the raw string returned by `do JavaScript` (stdout from osascript,
 * relayed verbatim by the daemon's `execute` command). Handles JSON
 * envelope from `wrapJavaScript`, CSP block signal (empty raw = script
 * never executed), shadow-DOM-closed signal, and bare-string fallback.
 */
export function parseJsResult(raw: string): EngineResult {
  const start = Date.now();

  // Detect CSP-blocked execution. Production AppleScript path always wraps
  // results in a JSON envelope, so a BARE empty raw means the script never
  // executed — CSP block is the dominant cause. (audit-tasks T13)
  if (
    raw === '' ||
    raw.toLowerCase().includes('content security policy') ||
    raw.toLowerCase().includes('blocked by csp')
  ) {
    return {
      ok: false,
      error: { code: 'CSP_BLOCKED', message: 'JavaScript execution blocked by Content Security Policy', retryable: false },
      elapsed_ms: Date.now() - start,
    };
  }

  // Detect shadow DOM closed signal.
  if (raw.toLowerCase().includes('shadow') && raw.toLowerCase().includes('closed')) {
    return {
      ok: false,
      error: { code: 'SHADOW_DOM_CLOSED', message: 'Cannot access closed shadow root', retryable: false },
      elapsed_ms: Date.now() - start,
    };
  }

  // Try to parse JSON envelope.
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
        const code = mapJsErrorName(errName);
        return {
          ok: false,
          error: { code, message: errMsg, retryable: false },
          elapsed_ms: Date.now() - start,
        };
      }
    }
  } catch {
    // Not JSON — treat raw string as successful result.
  }

  // Raw non-JSON string → treat as success value.
  return { ok: true, value: raw, elapsed_ms: Date.now() - start };
}
