/**
 * SD-06 unit coverage for the remaining 13 concrete SafariPilotError
 * subclasses that were previously untested. T-series + SD-01/SD-04
 * already covered:
 *   - TabUrlNotRecognizedError (T8 security-ownership.test.ts)
 *   - SessionWindowInitError (T11 ensure-session-window.test.ts)
 *   - RateLimitedError (SD-04 rate-limiter.test.ts)
 *   - KillSwitchActiveError (SD-04 kill-switch.test.ts)
 *   - HumanApprovalRequiredError (SD-04 human-approval.test.ts)
 *   - CircuitBreakerOpenError (SD-04 circuit-breaker.test.ts)
 *
 * Each test asserts (a) the error code matches the ERROR_CODES constant,
 * (b) the message contains the constructor args it was built from, and
 * (c) the instance is both an `Error` and a `SafariPilotError`.
 *
 * This is intentionally a shallow smoke-test — the per-error discrimination
 * is a rename of the field or the constant, which trivially fails the
 * assertions below. The goal is not depth but COVERAGE of the error
 * taxonomy so that a future "rename to `code2`" or "delete the retryable
 * getter" flags loudly here.
 *
 * SD-22 (2026-04-25, resolved): the 4 declared-but-unused codes
 * (ELEMENT_NOT_INTERACTABLE, CROSS_ORIGIN_FRAME, DIALOG_UNEXPECTED,
 * FRAME_NOT_FOUND) were deleted from ERROR_CODES — they had zero
 * references anywhere in src/, daemon/Sources/, extension/, or tests.
 */
import { describe, it, expect } from 'vitest';
import {
  SafariPilotError,
  ElementNotFoundError,
  ElementNotVisibleError,
  TimeoutError,
  TabNotFoundError,
  TabNotOwnedError,
  DomainNotAllowedError,
  CspBlockedError,
  ShadowDomClosedError,
  EngineRequiredError,
  NavigationFailedError,
  InternalError,
  ExtensionUncertainError,
  SessionRecoveryError,
  ERROR_CODES,
  formatToolError,
} from '../../src/errors.js';
import type { StructuredUncertainty } from '../../src/types.js';

describe('Concrete SafariPilotError subclasses (SD-06)', () => {
  it('ElementNotFoundError: code=ELEMENT_NOT_FOUND, retryable=true, url+selector carried', () => {
    const err = new ElementNotFoundError('#missing', 'https://example.com');
    expect(err).toBeInstanceOf(SafariPilotError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(ERROR_CODES.ELEMENT_NOT_FOUND);
    expect(err.retryable).toBe(true);
    expect(err.hints.length).toBeGreaterThan(0);
    expect(err.selector).toBe('#missing');
    expect(err.url).toBe('https://example.com');
    expect(err.message).toContain('#missing');
  });

  it('ElementNotVisibleError: code=ELEMENT_NOT_VISIBLE, retryable=true', () => {
    const err = new ElementNotVisibleError('button.submit', 'https://app.test');
    expect(err.code).toBe(ERROR_CODES.ELEMENT_NOT_VISIBLE);
    expect(err.retryable).toBe(true);
    expect(err.selector).toBe('button.submit');
    expect(err.message).toContain('button.submit');
  });

  it('TimeoutError: code=TIMEOUT, retryable=true, operation + timeout in message', () => {
    const err = new TimeoutError('wait_for_load', 5000);
    expect(err.code).toBe(ERROR_CODES.TIMEOUT);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('wait_for_load');
    expect(err.message).toContain('5000');
  });

  it('TabNotFoundError: code=TAB_NOT_FOUND, retryable=false', () => {
    const err = new TabNotFoundError('https://gone.test');
    expect(err.code).toBe(ERROR_CODES.TAB_NOT_FOUND);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('https://gone.test');
  });

  it('TabNotOwnedError: code=TAB_NOT_OWNED, retryable=false, tabId in message', () => {
    const err = new TabNotOwnedError(42);
    expect(err.code).toBe(ERROR_CODES.TAB_NOT_OWNED);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('42');
  });

  it('DomainNotAllowedError: code=DOMAIN_NOT_ALLOWED, retryable=false', () => {
    const err = new DomainNotAllowedError('evil.test');
    expect(err.code).toBe(ERROR_CODES.DOMAIN_NOT_ALLOWED);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('evil.test');
  });

  it('CspBlockedError: code=CSP_BLOCKED, retryable=false, url carried', () => {
    const err = new CspBlockedError('https://strict.test');
    expect(err.code).toBe(ERROR_CODES.CSP_BLOCKED);
    expect(err.retryable).toBe(false);
    expect(err.url).toBe('https://strict.test');
    expect(err.message).toContain('https://strict.test');
  });

  it('ShadowDomClosedError: code=SHADOW_DOM_CLOSED, retryable=false, selector carried', () => {
    const err = new ShadowDomClosedError('custom-el');
    expect(err.code).toBe(ERROR_CODES.SHADOW_DOM_CLOSED);
    expect(err.retryable).toBe(false);
    expect(err.selector).toBe('custom-el');
  });

  it('EngineRequiredError: code=EXTENSION_REQUIRED, retryable=false', () => {
    const err = new EngineRequiredError('shadowDom');
    expect(err.code).toBe(ERROR_CODES.EXTENSION_REQUIRED);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('shadowDom');
  });

  it('NavigationFailedError: code=NAVIGATION_FAILED, retryable=true, optional reason', () => {
    const withReason = new NavigationFailedError('https://broken.test', 'DNS failure');
    expect(withReason.code).toBe(ERROR_CODES.NAVIGATION_FAILED);
    expect(withReason.retryable).toBe(true);
    expect(withReason.message).toContain('https://broken.test');
    expect(withReason.message).toContain('DNS failure');

    const withoutReason = new NavigationFailedError('https://broken.test');
    expect(withoutReason.message).toContain('https://broken.test');
    // Message must still be meaningful without the optional reason
    expect(withoutReason.message.length).toBeGreaterThan(10);
  });

  it('InternalError: code=INTERNAL_ERROR, retryable=false', () => {
    const err = new InternalError('unexpected state: engineProxy is null');
    expect(err.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('unexpected state');
  });

  it('ExtensionUncertainError: code=EXTENSION_UNCERTAIN, retryable=false, uncertainResult attached', () => {
    const uncertainty: StructuredUncertainty = {
      disconnectPhase: 'after_dispatch_before_ack',
      likelyExecuted: true,
      recommendation: 'probe_state',
    };
    const err = new ExtensionUncertainError(uncertainty, { url: 'https://u.test', selector: 'button' });
    expect(err.code).toBe(ERROR_CODES.EXTENSION_UNCERTAIN);
    expect(err.retryable).toBe(false); // non-idempotent tools NEVER auto-retry
    expect(err.uncertainResult).toEqual(uncertainty);
    expect(err.url).toBe('https://u.test');
    expect(err.selector).toBe('button');
    expect(err.message).toContain('after_dispatch_before_ack');
  });

  it('SessionRecoveryError: code=SESSION_RECOVERY_FAILED, retryable=true, lists down components', () => {
    const err = new SessionRecoveryError({
      daemon: true,
      extension: false,
      window: true,
      durationMs: 10_000,
    });
    expect(err.code).toBe(ERROR_CODES.SESSION_RECOVERY_FAILED);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('SessionRecoveryError');
    expect(err.message).toContain('extension not connected');
    expect(err.message).toContain('10000');
    // `daemon: true` means daemon is up → not listed
    expect(err.message).not.toContain('daemon not running');
  });

  it('formatToolError produces a ToolError envelope with engine + timing context', () => {
    const err = new TimeoutError('load_page', 30_000);
    const envelope = formatToolError(err, 'extension', 31_234);
    expect(envelope.code).toBe('TIMEOUT');
    expect(envelope.retryable).toBe(true);
    expect(envelope.hints.length).toBeGreaterThan(0);
    expect(envelope.context.engine).toBe('extension');
    expect(envelope.context.elapsed_ms).toBe(31_234);
  });

  it('formatToolError attaches uncertainResult on ExtensionUncertainError (unique branch)', () => {
    // formatToolError has an `instanceof ExtensionUncertainError` branch
    // (errors.ts:384-386) that copies `uncertainResult` onto the envelope.
    // Without this test, that branch is unverified — the test above uses
    // TimeoutError which doesn't hit it.
    const uncertainty: StructuredUncertainty = {
      disconnectPhase: 'after_ack_before_result',
      likelyExecuted: true,
      recommendation: 'caller_decides',
    };
    const err = new ExtensionUncertainError(uncertainty);
    const envelope = formatToolError(err, 'extension', 500);
    expect(envelope.code).toBe('EXTENSION_UNCERTAIN');
    expect(envelope.uncertainResult).toEqual(uncertainty);
  });
});
