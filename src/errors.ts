import type { Engine, ToolError } from './types.js';

// ─── Error Codes ─────────────────────────────────────────────────────────────

export const ERROR_CODES = {
  ELEMENT_NOT_FOUND: 'ELEMENT_NOT_FOUND',
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  ELEMENT_NOT_INTERACTABLE: 'ELEMENT_NOT_INTERACTABLE',
  TIMEOUT: 'TIMEOUT',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  CSP_BLOCKED: 'CSP_BLOCKED',
  SHADOW_DOM_CLOSED: 'SHADOW_DOM_CLOSED',
  CROSS_ORIGIN_FRAME: 'CROSS_ORIGIN_FRAME',
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
  DIALOG_UNEXPECTED: 'DIALOG_UNEXPECTED',
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  CIRCUIT_BREAKER_OPEN: 'CIRCUIT_BREAKER_OPEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

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
  };
}
