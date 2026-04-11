import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  SafariPilotError,
  ElementNotFoundError,
  ElementNotVisibleError,
  TimeoutError,
  TabNotFoundError,
  TabNotOwnedError,
  DomainNotAllowedError,
  RateLimitedError,
  CspBlockedError,
  ShadowDomClosedError,
  KillSwitchActiveError,
  HumanApprovalRequiredError,
  EngineRequiredError,
  CircuitBreakerOpenError,
  NavigationFailedError,
  InternalError,
  formatToolError,
} from '../../src/errors.js';

describe('ERROR_CODES', () => {
  it('exports all 22 standard error codes', () => {
    const expected = [
      'ELEMENT_NOT_FOUND',
      'ELEMENT_NOT_VISIBLE',
      'ELEMENT_NOT_INTERACTABLE',
      'TIMEOUT',
      'NAVIGATION_FAILED',
      'CSP_BLOCKED',
      'SHADOW_DOM_CLOSED',
      'CROSS_ORIGIN_FRAME',
      'SAFARI_NOT_RUNNING',
      'SAFARI_CRASHED',
      'PERMISSION_DENIED',
      'TAB_NOT_FOUND',
      'TAB_NOT_OWNED',
      'DOMAIN_NOT_ALLOWED',
      'RATE_LIMITED',
      'EXTENSION_REQUIRED',
      'KILL_SWITCH_ACTIVE',
      'HUMAN_APPROVAL_REQUIRED',
      'DIALOG_UNEXPECTED',
      'FRAME_NOT_FOUND',
      'CIRCUIT_BREAKER_OPEN',
      'INTERNAL_ERROR',
    ];

    expect(Object.keys(ERROR_CODES)).toHaveLength(22);
    for (const code of expected) {
      expect(ERROR_CODES).toHaveProperty(code, code);
    }
  });
});

describe('ElementNotFoundError', () => {
  it('is retryable with correct code and hints', () => {
    const err = new ElementNotFoundError('#submit-btn', 'https://example.com');

    expect(err).toBeInstanceOf(SafariPilotError);
    expect(err).toBeInstanceOf(ElementNotFoundError);
    expect(err.code).toBe(ERROR_CODES.ELEMENT_NOT_FOUND);
    expect(err.retryable).toBe(true);
    expect(err.hints).toBeInstanceOf(Array);
    expect(err.hints.length).toBeGreaterThan(0);
    expect(err.selector).toBe('#submit-btn');
    expect(err.url).toBe('https://example.com');
    expect(err.message).toContain('#submit-btn');
  });
});

describe('TabNotOwnedError', () => {
  it('is not retryable', () => {
    const err = new TabNotOwnedError(42);

    expect(err.code).toBe(ERROR_CODES.TAB_NOT_OWNED);
    expect(err.retryable).toBe(false);
    expect(err.hints).toBeInstanceOf(Array);
    expect(err.hints.length).toBeGreaterThan(0);
    expect(err.message).toContain('42');
  });
});

describe('RateLimitedError', () => {
  it('is retryable', () => {
    const err = new RateLimitedError('example.com', 30);

    expect(err.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(err.retryable).toBe(true);
    expect(err.hints).toBeInstanceOf(Array);
    expect(err.hints.length).toBeGreaterThan(0);
    expect(err.message).toContain('example.com');
    expect(err.message).toContain('30');
  });
});

describe('KillSwitchActiveError', () => {
  it('is not retryable', () => {
    const err = new KillSwitchActiveError('Emergency stop triggered by admin');

    expect(err.code).toBe(ERROR_CODES.KILL_SWITCH_ACTIVE);
    expect(err.retryable).toBe(false);
    expect(err.hints).toBeInstanceOf(Array);
    expect(err.hints.length).toBeGreaterThan(0);
    expect(err.message).toContain('Emergency stop');
  });
});

describe('formatToolError', () => {
  it('produces spec-compliant ToolError structure', () => {
    const err = new ElementNotFoundError('.login-button', 'https://app.example.com/login');
    const result = formatToolError(err, 'daemon', 250);

    expect(result.code).toBe(ERROR_CODES.ELEMENT_NOT_FOUND);
    expect(result.message).toBe(err.message);
    expect(result.retryable).toBe(true);
    expect(result.hints).toEqual(err.hints);
    expect(result.context.engine).toBe('daemon');
    expect(result.context.url).toBe('https://app.example.com/login');
    expect(result.context.selector).toBe('.login-button');
    expect(result.context.elapsed_ms).toBe(250);
  });
});

describe('CircuitBreakerOpenError', () => {
  it('includes cooldown info in hints', () => {
    const err = new CircuitBreakerOpenError('flaky-site.com', 90);

    expect(err.code).toBe(ERROR_CODES.CIRCUIT_BREAKER_OPEN);
    expect(err.retryable).toBe(true);
    expect(err.hints.some((h) => h.includes('90'))).toBe(true);
    expect(err.hints.some((h) => /cooldown/i.test(h))).toBe(true);
    expect(err.message).toContain('flaky-site.com');
    expect(err.message).toContain('90');
  });
});
