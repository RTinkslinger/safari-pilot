import type { Engine, StructuredUncertainty, ToolError } from './types.js';

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  TIMEOUT: 'TIMEOUT',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  CSP_BLOCKED: 'CSP_BLOCKED',
  SHADOW_DOM_CLOSED: 'SHADOW_DOM_CLOSED',
  SAFARI_NOT_RUNNING: 'SAFARI_NOT_RUNNING',
  SAFARI_CRASHED: 'SAFARI_CRASHED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  TAB_NOT_OWNED: 'TAB_NOT_OWNED',
  DOMAIN_NOT_ALLOWED: 'DOMAIN_NOT_ALLOWED',
  RATE_LIMITED: 'RATE_LIMITED',
  EXTENSION_REQUIRED: 'EXTENSION_REQUIRED',
  KILL_SWITCH_ACTIVE: 'KILL_SWITCH_ACTIVE',
  HUMAN_APPROVAL_REQUIRED: 'HUMAN_APPROVAL_REQUIRED',
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  EXTENSION_UNCERTAIN: 'EXTENSION_UNCERTAIN',
  SESSION_RECOVERY_FAILED: 'SESSION_RECOVERY_FAILED',
  SESSION_WINDOW_INIT_FAILED: 'SESSION_WINDOW_INIT_FAILED',
  SCREENSHOT_BLOCKED: 'SCREENSHOT_BLOCKED',
  SESSION_TAB_PROTECTED: 'SESSION_TAB_PROTECTED',
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  FRAME_NAVIGATED: 'FRAME_NAVIGATED',
  FRAME_UNREACHABLE: 'FRAME_UNREACHABLE',
  FRAME_NOT_SUPPORTED: 'FRAME_NOT_SUPPORTED',
  DOWNLOAD_SOURCE_MISSING: 'DOWNLOAD_SOURCE_MISSING',
  FILE_UPLOAD_PATH_NOT_FOUND: 'FILE_UPLOAD_PATH_NOT_FOUND',
  FILE_UPLOAD_PATH_NOT_READABLE: 'FILE_UPLOAD_PATH_NOT_READABLE',
  FILE_UPLOAD_PATH_NOT_ABSOLUTE: 'FILE_UPLOAD_PATH_NOT_ABSOLUTE',
  FILE_UPLOAD_FILE_TOO_LARGE: 'FILE_UPLOAD_FILE_TOO_LARGE',
  FILE_UPLOAD_TOO_MANY_FILES: 'FILE_UPLOAD_TOO_MANY_FILES',
  FILE_UPLOAD_EMPTY_PATHS: 'FILE_UPLOAD_EMPTY_PATHS',
  FILE_UPLOAD_INVALID_ELEMENT: 'FILE_UPLOAD_INVALID_ELEMENT',
  FILE_UPLOAD_ELEMENT_DETACHED: 'FILE_UPLOAD_ELEMENT_DETACHED',
  FILE_UPLOAD_MULTIPLE_NOT_ALLOWED: 'FILE_UPLOAD_MULTIPLE_NOT_ALLOWED',
  FILE_UPLOAD_INVALID_PARAMS: 'FILE_UPLOAD_INVALID_PARAMS',
  STRICTNESS_VIOLATION: 'STRICTNESS_VIOLATION',
  // 2026-05-08 — codes for safari_take_screenshot WebView capture (Task 5).
  // No concrete error classes for these: they are returned as structured
  // data from the extension sentinel and lifted into ToolError by the
  // engine layer, not thrown as SafariPilotError instances. Their
  // retryable/hints metadata lives in ERROR_METADATA below.
  WINDOW_CLOSED: 'WINDOW_CLOSED',
  CAPTURE_RACE: 'CAPTURE_RACE',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  TARGET_HIDDEN: 'TARGET_HIDDEN',
} as const;
// SD-22 (2026-04-25): removed 4 dead codes (ELEMENT_NOT_INTERACTABLE,
// CROSS_ORIGIN_FRAME, DIALOG_UNEXPECTED, FRAME_NOT_FOUND) — declared but
// never referenced anywhere in src/, daemon/Sources/, extension/, or tests.
// They implicitly promised error-class semantics the codebase did not offer.
// If a future feature needs any of them, add the code AND a concrete
// SafariPilotError subclass AND wire the throw sites in the same change.

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// Metadata for codes returned as structured data (not thrown as concrete
// SafariPilotError subclasses). Concrete classes carry retryable/hints on
// the instance; this map carries the same fields for data-only codes,
// looked up at error-formatting time when the code did not originate from
// a thrown class.
export const ERROR_METADATA: Partial<Record<ErrorCode, { retryable: boolean; hints: readonly string[] }>> = {
  WINDOW_CLOSED:  { retryable: false, hints: ['The Safari window containing this tab was closed before capture could complete.'] },
  CAPTURE_RACE:   { retryable: true,  hints: ['Another tab became active during the capture window. Retry; if persistent, reduce concurrent activity in this Safari window.'] },
  CAPTURE_FAILED: { retryable: true,  hints: ['Screenshot capture API failed. Verify Safari extension is enabled and the page is fully loaded.'] },
  INVALID_PARAMS: { retryable: false, hints: ['Tool was called with parameters that violate its input schema.'] },
  TARGET_NOT_FOUND: {
    retryable: false,
    hints: [
      'No element matched the provided locator. If target is in a cross-origin iframe, the locator cannot reach it.',
      'Try a broader text substring, a different selector, or call safari_get_text to inspect page structure first.',
    ],
  },
  TARGET_HIDDEN: {
    retryable: false,
    hints: [
      'Element exists but is display:none, visibility:hidden, or inside a closed <details>.',
      'Tool does NOT auto-expand parents (idempotency). Agent may need to expand a parent element first.',
    ],
  },
};

// ─── Abstract Base ────────────────────────────────────────────────────────────

export abstract class SafariPilotError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;
  abstract readonly hints: string[];
  readonly url?: string;
  readonly selector?: string;

  constructor(message: string, options?: { url?: string; selector?: string }) {
    super(message);
    this.name = this.constructor.name;
    this.url = options?.url;
    this.selector = options?.selector;
  }
}

// ─── Concrete Error Classes ───────────────────────────────────────────────────

export class ElementNotFoundError extends SafariPilotError {
  readonly code = ERROR_CODES.ELEMENT_NOT_FOUND;
  readonly retryable = true;
  readonly hints: string[];

  constructor(selector: string, url: string) {
    super(`Element not found: ${selector}`, { url, selector });
    this.hints = [
      `Selector "${selector}" matched no elements on the page`,
      'Check if the element is inside a shadow DOM or cross-origin iframe',
      'Wait for page to fully load before querying',
    ];
  }
}

export class ElementNotVisibleError extends SafariPilotError {
  readonly code = ERROR_CODES.ELEMENT_NOT_VISIBLE;
  readonly retryable = true;
  readonly hints: string[];

  constructor(selector: string, url: string) {
    super(`Element not visible: ${selector}`, { url, selector });
    this.hints = [
      `Element "${selector}" exists but is not visible`,
      'Element may be hidden, off-screen, or have zero dimensions',
      'Scroll element into view or wait for visibility',
    ];
  }
}

export class TimeoutError extends SafariPilotError {
  readonly code = ERROR_CODES.TIMEOUT;
  readonly retryable = true;
  readonly hints: string[];

  constructor(operation: string, timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms waiting for: ${operation}`);
    this.hints = [
      `Operation "${operation}" exceeded ${timeoutMs}ms limit`,
      'Consider increasing the timeout for slow pages',
      'Check network conditions and page load state',
    ];
  }
}

export class TabNotFoundError extends SafariPilotError {
  readonly code = ERROR_CODES.TAB_NOT_FOUND;
  readonly retryable = false;
  readonly hints: string[];

  constructor(tabUrl: string) {
    super(`Tab not found: ${tabUrl}`, { url: tabUrl });
    this.hints = [
      `No tab found matching URL: ${tabUrl}`,
      'The tab may have been closed or navigated away',
      'Use list_tabs to find current open tabs',
    ];
  }
}

export class TabNotOwnedError extends SafariPilotError {
  readonly code = ERROR_CODES.TAB_NOT_OWNED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(tabId: number) {
    super(`Tab not owned by agent: ${tabId}`);
    this.hints = [
      `Tab ${tabId} was not opened by this agent session`,
      'Only tabs opened via open_tab can be controlled',
      'Use open_tab to create a new controllable tab',
    ];
  }
}

export class TabUrlNotRecognizedError extends SafariPilotError {
  readonly code = ERROR_CODES.TAB_NOT_OWNED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(url: string) {
    super(`Tab URL not recognized as agent-owned: ${url}`);
    this.hints = [
      'This URL does not match any tab opened by this agent session',
      'If the tab was navigated, the URL may have changed — use the URL from the last navigation response',
      'Only tabs opened via safari_new_tab can be controlled',
    ];
  }
}

/**
 * T48 — operation refused on the session dashboard tab. The session tab
 * is opened at startup as the daemon ↔ extension rendezvous and is never
 * registered in tabOwnership. Pre-T48, the session URL was implicitly
 * protected — by `TabUrlNotRecognizedError` on the AppleScript path, and
 * by deferred-fail-closed on the extension path. The latter only fires
 * AFTER the side effect (navigation, click) has already run in Safari.
 * This dedicated error fires pre-execution so the side effect never
 * happens, regardless of which engine the tool is routed to.
 */
export class SessionTabProtectedError extends SafariPilotError {
  readonly code = ERROR_CODES.SESSION_TAB_PROTECTED;
  readonly retryable = false;
  readonly hints: string[];

  constructor() {
    super('Operation refused on session dashboard tab — this tab cannot be controlled by agents.');
    this.hints = [
      'The session dashboard tab is internal infrastructure (daemon ↔ extension handshake)',
      'Open a separate tab via safari_new_tab and target that one instead',
    ];
  }
}

export class DomainNotAllowedError extends SafariPilotError {
  readonly code = ERROR_CODES.DOMAIN_NOT_ALLOWED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(domain: string) {
    super(`Domain not in allowlist: ${domain}`);
    this.hints = [
      `Domain "${domain}" is not permitted by policy`,
      'Contact your administrator to add this domain to the allowlist',
      'Use list_allowed_domains to see permitted domains',
    ];
  }
}

export class RateLimitedError extends SafariPilotError {
  readonly code = ERROR_CODES.RATE_LIMITED;
  readonly retryable = true;
  readonly hints: string[];

  constructor(domain: string, maxPerMinute: number) {
    super(`Rate limit exceeded for domain: ${domain} (max ${maxPerMinute}/min)`);
    this.hints = [
      `Domain "${domain}" has exceeded ${maxPerMinute} actions per minute`,
      'Slow down request frequency to stay within rate limits',
      'Wait at least 60 seconds before retrying',
    ];
  }
}

export class CspBlockedError extends SafariPilotError {
  readonly code = ERROR_CODES.CSP_BLOCKED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(url: string) {
    super(`Content Security Policy blocked script execution on: ${url}`, { url });
    this.hints = [
      `Page at "${url}" has a strict CSP that blocks injection`,
      'Use the extension engine which has CSP bypass capability',
      'Switch to a non-injected approach if extension is unavailable',
    ];
  }
}

export class ShadowDomClosedError extends SafariPilotError {
  readonly code = ERROR_CODES.SHADOW_DOM_CLOSED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(selector: string) {
    super(`Closed shadow DOM at selector: ${selector}`, { selector });
    this.hints = [
      `Element "${selector}" is inside a closed shadow root`,
      'Closed shadow roots cannot be penetrated by standard scripts',
      'The extension engine may be able to access closed shadow DOM',
    ];
  }
}

export class KillSwitchActiveError extends SafariPilotError {
  readonly code = ERROR_CODES.KILL_SWITCH_ACTIVE;
  readonly retryable = false;
  readonly hints: string[];

  constructor(reason: string) {
    super(`Kill switch active: ${reason}`);
    this.hints = [
      `All automation is halted: ${reason}`,
      'Human intervention is required to deactivate the kill switch',
      'Contact your administrator for resolution',
    ];
  }
}

export class HumanApprovalRequiredError extends SafariPilotError {
  readonly code = ERROR_CODES.HUMAN_APPROVAL_REQUIRED;
  readonly retryable = true;
  readonly hints: string[];

  constructor(action: string, domain: string) {
    super(`Human approval required for "${action}" on ${domain}`);
    this.hints = [
      `Action "${action}" on domain "${domain}" requires human sign-off`,
      'Wait for user to approve this action before retrying',
      'Use request_approval to initiate the approval flow',
    ];
  }
}

export class EngineRequiredError extends SafariPilotError {
  readonly code = ERROR_CODES.EXTENSION_REQUIRED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(capability: string) {
    super(`Extension engine required for capability: ${capability}`);
    this.hints = [
      `Capability "${capability}" is only available via the extension engine`,
      'Install and activate the Safari Pilot browser extension',
      'See docs for extension installation instructions',
    ];
  }
}

export class CircuitBreakerOpenError extends SafariPilotError {
  readonly code = ERROR_CODES.CIRCUIT_BREAKER_OPEN;
  readonly retryable = true;
  readonly hints: string[];

  constructor(domain: string, cooldownSeconds: number) {
    super(`Circuit breaker open for domain: ${domain} (cooldown: ${cooldownSeconds}s)`);
    this.hints = [
      `Domain "${domain}" circuit breaker is open due to repeated failures`,
      `Retry after ${cooldownSeconds} seconds cooldown`,
      'Investigate the root cause before the circuit auto-closes',
    ];
  }
}

export class NavigationFailedError extends SafariPilotError {
  readonly code = ERROR_CODES.NAVIGATION_FAILED;
  readonly retryable = true;
  readonly hints: string[];

  constructor(url: string, reason?: string) {
    const detail = reason ? `: ${reason}` : '';
    super(`Navigation failed to ${url}${detail}`, { url });
    this.hints = [
      `Failed to navigate to "${url}"${detail}`,
      'Check that the URL is reachable and valid',
      'Verify network connectivity and DNS resolution',
    ];
  }
}

export class InternalError extends SafariPilotError {
  readonly code = ERROR_CODES.INTERNAL_ERROR;
  readonly retryable = false;
  readonly hints: string[];

  constructor(message: string) {
    super(`Internal error: ${message}`);
    this.hints = [
      'An unexpected internal error occurred',
      'This is likely a bug — please report it',
      'Include the full error message and stack trace in the report',
    ];
  }
}

export class ExtensionUncertainError extends SafariPilotError {
  readonly code = ERROR_CODES.EXTENSION_UNCERTAIN;
  readonly retryable = false; // non-idempotent tools are NEVER auto-retried
  readonly hints: string[];
  readonly uncertainResult: StructuredUncertainty;

  constructor(uncertainResult: StructuredUncertainty, options?: { url?: string; selector?: string }) {
    super(
      `Extension disconnected during ${uncertainResult.disconnectPhase} (likelyExecuted=${uncertainResult.likelyExecuted})`,
      options,
    );
    this.uncertainResult = uncertainResult;
    this.hints = [
      uncertainResult.recommendation === 'probe_state'
        ? 'Probe page state before retrying — the action may have partially completed'
        : "Retry is the caller's decision — side effects may or may not have occurred",
      'Non-idempotent tools are never auto-retried on EXTENSION_UNCERTAIN',
      `Disconnect phase: ${uncertainResult.disconnectPhase}`,
    ];
  }
}

export class SessionRecoveryError extends SafariPilotError {
  readonly code = ERROR_CODES.SESSION_RECOVERY_FAILED as ErrorCode;
  readonly retryable = true;
  readonly hints: string[];

  constructor(details: { daemon: boolean; extension: boolean; window: boolean; durationMs: number }) {
    const down: string[] = [];
    if (!details.daemon) down.push('daemon not running');
    if (!details.extension) down.push('extension not connected');
    if (!details.window) down.push('session window closed');
    super(`Session recovery failed after ${details.durationMs}ms: ${down.join(', ')}`);
    this.name = 'SessionRecoveryError';
    this.hints = [
      'Check Safari is running',
      'Check extension is enabled in Safari > Settings > Extensions',
      'Try restarting the daemon: launchctl kickstart -k gui/$(id -u)/com.anthropic.safari-pilot',
    ];
  }
}

/**
 * Thrown by `SafariPilotServer.ensureSessionWindow()` when the AppleScript
 * that creates the dedicated session window fails or returns an unparseable
 * window id. Propagates through `start()` so `main()` in `src/index.ts`
 * exits with a non-zero code and a clear message — instead of silently
 * continuing with no `_sessionWindowId`, which would wedge the extension
 * bootstrap and surface as a misleading "extension not connected" error
 * 15 seconds later.
 */
export class SessionWindowInitError extends SafariPilotError {
  readonly code = ERROR_CODES.SESSION_WINDOW_INIT_FAILED as ErrorCode;
  readonly retryable = false;
  readonly hints: string[];

  constructor(details: { reason: 'execFailed' | 'unparseableWindowId'; cause?: string }) {
    const reasonMsg = details.reason === 'execFailed'
      ? 'AppleScript "make new document" failed or timed out'
      : 'AppleScript returned an unparseable window id';
    super(`Session window could not be created: ${reasonMsg}${details.cause ? ` (${details.cause})` : ''}`);
    this.name = 'SessionWindowInitError';
    this.hints = [
      'Check that Safari is running and has at least one window open',
      'Enable Safari > Develop > Allow JavaScript from Apple Events',
      'Grant Automation permission to the controlling app in System Settings > Privacy & Security > Automation',
    ];
  }
}

export class ScreenshotBlockedError extends SafariPilotError {
  readonly code = ERROR_CODES.SCREENSHOT_BLOCKED;
  readonly retryable = false;
  readonly hints: string[];
  readonly domain: string;

  constructor(domain: string) {
    super(`Screenshot blocked for domain: ${domain}`);
    this.domain = domain;
    this.hints = [
      `Domain "${domain}" is in the screenshot block list`,
      'Screenshots are disabled on sensitive financial domains by policy',
      'Use blockedPatterns in config to customise the block list',
    ];
  }
}

// ─── Frame error classes (T55a) ──────────────────────────────────────────────

export class FrameNotFoundError extends SafariPilotError {
  readonly code = ERROR_CODES.FRAME_NOT_FOUND;
  readonly retryable = false;
  readonly hints: string[];

  constructor(frameId: number) {
    super(`Frame ${frameId} not found in tab. It may have navigated or unloaded.`);
    this.hints = [
      'Run safari_list_frames again — frame may have navigated or unloaded.',
      'Frame topology can change after SPA navigation; re-listing frames returns the current set.',
    ];
  }
}

export class FrameNavigatedError extends SafariPilotError {
  readonly code = ERROR_CODES.FRAME_NAVIGATED;
  readonly retryable = true;
  readonly hints: string[];

  constructor(frameId: number, expectedUrl: string, actualUrl: string) {
    super(`Frame ${frameId} navigated mid-command. Expected ${expectedUrl}, found ${actualUrl}.`);
    this.hints = [
      'Frame navigated mid-command. List frames again with safari_list_frames.',
      'Best-effort detection — if pagehide misses, FRAME_NOT_FOUND on the next call is the safety net.',
    ];
  }
}

export class FrameUnreachableError extends SafariPilotError {
  readonly code = ERROR_CODES.FRAME_UNREACHABLE;
  readonly retryable = false;
  readonly hints: string[];

  constructor(frameId: number) {
    super(`Frame ${frameId} unreachable — content script did not respond within timeout.`);
    this.hints = [
      'Frame may be sandboxed (no allow-scripts), CSP-blocked, or content-script injection failed.',
      'Sandboxed iframes without allow-scripts cannot run extension code.',
      'Page CSP that blocks extension scripts will surface here as well.',
    ];
  }
}

export class FrameNotSupportedError extends SafariPilotError {
  readonly code = ERROR_CODES.FRAME_NOT_SUPPORTED;
  readonly retryable = false;
  readonly hints: string[];

  constructor() {
    super('Cross-origin frame access requires the Safari Pilot extension engine.');
    this.hints = [
      'Cross-origin frame access requires the Safari Pilot extension to be installed and connected.',
      'AppleScript and Daemon engines cannot inject content scripts into iframes — the extension is the only path.',
    ];
  }
}

export class DownloadSourceMissingError extends SafariPilotError {
  readonly code = ERROR_CODES.DOWNLOAD_SOURCE_MISSING;
  readonly retryable = false;
  readonly hints: string[];

  constructor(sourcePath: string) {
    super(`Download source file does not exist: ${sourcePath}`);
    this.hints = [
      'The download metadata referenced a path that no longer exists.',
      'Safari may have moved or deleted the file before saveAs ran.',
      'Verify the source path returned by safari_wait_for_download still exists, or retry the download.',
    ];
  }
}

// ─── File Upload Error Classes (5A.1) ────────────────────────────────────────

export class FileUploadPathNotFoundError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_PATH_NOT_FOUND;
  readonly retryable = false;
  readonly hints: string[];
  readonly path: string;
  readonly suggestion?: string;

  constructor(path: string, suggestion?: string) {
    super(`File not found: ${path}${suggestion ? `. Did you mean: ${suggestion}?` : ''}`);
    this.path = path;
    if (suggestion !== undefined) this.suggestion = suggestion;
    this.hints = ['Pass an absolute path or ~-prefixed path to a file that exists.'];
  }
}

export class FileUploadPathNotReadableError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_PATH_NOT_READABLE;
  readonly retryable = false;
  readonly hints: string[];
  readonly path: string;

  constructor(path: string) {
    super(`Cannot read file: ${path} (permission denied, is a directory, or contains NUL bytes).`);
    this.path = path;
    this.hints = [];
  }
}

export class FileUploadPathNotAbsoluteError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_PATH_NOT_ABSOLUTE;
  readonly retryable = false;
  readonly hints: string[];
  readonly path: string;

  constructor(path: string) {
    super(`Path must be absolute or ~-prefixed: ${path}`);
    this.path = path;
    this.hints = ['Use an absolute path (/Users/...) or ~/relative/path.'];
  }
}

export class FileUploadFileTooLargeError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_FILE_TOO_LARGE;
  readonly retryable = false;
  readonly hints: string[];
  readonly path: string;
  readonly size: number;
  readonly cap: number = 26_214_400;

  constructor(path: string, size: number) {
    super(`File exceeds 25 MB cap: ${path} (${size} bytes).`);
    this.path = path;
    this.size = size;
    this.hints = [
      'v1 cap is 25 MB. For larger files, upload via a custom site mechanism (e.g., a direct API call from the agent).',
    ];
  }
}

export class FileUploadTooManyFilesError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_TOO_MANY_FILES;
  readonly retryable = false;
  readonly hints: string[];
  readonly count: number;

  constructor(count: number) {
    super(`Too many files: ${count}. v1 limit is 4.`);
    this.count = count;
    this.hints = [
      'To upload more, call multiple times — note that subsequent calls REPLACE the FileList, not append.',
    ];
  }
}

export class FileUploadEmptyPathsError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_EMPTY_PATHS;
  readonly retryable = false;
  readonly hints: string[];

  constructor() {
    super('paths is empty and clear is not true.');
    this.hints = ['Pass clear: true to clear the input.'];
  }
}

export class FileUploadInvalidElementError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_INVALID_ELEMENT;
  readonly retryable = false;
  readonly hints: string[];
  readonly tagName: string;
  readonly type: string;

  constructor(tagName: string, type: string) {
    super(
      `Locator resolved to <${tagName.toLowerCase()}${type ? ` type="${type}"` : ''}>, not <input type=file>.`,
    );
    this.tagName = tagName;
    this.type = type;
    this.hints = [
      'safari_file_upload only operates on <input type=file>. If the page uses a custom picker, look for the hidden <input> sibling — usually inside the same <label>. Try locating by the label text.',
    ];
  }
}

export class FileUploadElementDetachedError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_ELEMENT_DETACHED;
  readonly retryable = true; // retryable: page may re-render
  readonly hints: string[];
  readonly ref?: string;

  constructor(ref?: string) {
    super(`Element was removed between probe and inject${ref ? ` (ref: ${ref})` : ''}.`);
    if (ref !== undefined) this.ref = ref;
    this.hints = ['Page re-rendered between probe and inject. Retry the call.'];
  }
}

export class FileUploadMultipleNotAllowedError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_MULTIPLE_NOT_ALLOWED;
  readonly retryable = false;
  readonly hints: string[];

  constructor() {
    super('Input does not have the multiple attribute; cannot accept >1 path.');
    this.hints = ['Pass exactly 1 path, or locate an input that has multiple="true".'];
  }
}

export class FileUploadInvalidParamsError extends SafariPilotError {
  readonly code = ERROR_CODES.FILE_UPLOAD_INVALID_PARAMS;
  readonly retryable = false;
  readonly hints: string[];

  constructor(issue: string) {
    super(`Invalid parameters: ${issue}`);
    this.hints = [];
  }
}

// ─── Strict-Mode Error (T77 / T80) ───────────────────────────────────────────

/**
 * T77 / T80: thrown by action tools (click/fill/hover/select_option/type/
 * press_key/double_click/drag) when locator resolution yields >1 candidate
 * elements without disambiguation (no first/last/nth/testId/xpath, no flat
 * `nth`). Read tools (get_text/get_html/get_attribute) keep pick-first
 * behavior to preserve v1 read semantics.
 *
 * Matches Playwright's strict-mode contract: actions must target exactly
 * one element. Multi-match is a caller-side spec issue, not retryable.
 */
export class StrictnessViolationError extends SafariPilotError {
  readonly code = ERROR_CODES.STRICTNESS_VIOLATION;
  readonly retryable = false;
  readonly hints: string[];
  readonly matchCount: number;

  constructor(matchCount: number, locatorDescription: string) {
    super(
      `Locator matched ${matchCount} elements, expected exactly 1: ${locatorDescription}`,
    );
    this.matchCount = matchCount;
    this.hints = [
      'Add .first(), .last(), or .nth(N) to the chain to disambiguate',
      'Or refine the locator with filter:{hasText} / .filter() / role+name',
      'Or use safari_query_all to act on all matches deliberately',
    ];
  }
}

// ─── formatToolError ──────────────────────────────────────────────────────────

export function formatToolError(
  error: SafariPilotError,
  engine: Engine,
  elapsed_ms: number,
): ToolError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    hints: error.hints,
    context: {
      engine,
      url: error.url ?? '',
      ...(error.selector !== undefined ? { selector: error.selector } : {}),
      elapsed_ms,
    },
    ...(error.cause ? { cause_chain: [String(error.cause)] } : {}),
    ...(error instanceof ExtensionUncertainError
      ? { uncertainResult: error.uncertainResult }
      : {}),
  };
}
