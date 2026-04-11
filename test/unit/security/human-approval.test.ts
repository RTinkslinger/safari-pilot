import { describe, it, expect } from 'vitest';
import { HumanApproval } from '../../../src/security/human-approval.js';
import { HumanApprovalRequiredError } from '../../../src/errors.js';

describe('HumanApproval', () => {
  const approval = new HumanApproval();

  // ── Normal (benign) cases ───────────────────────────────────────────────────

  it('does not require approval for a normal URL', () => {
    const result = approval.requiresApproval('click', 'https://example.com/products');
    expect(result.required).toBe(false);
  });

  it('does not require approval for a plain navigate action', () => {
    const result = approval.requiresApproval('navigate', 'https://docs.github.com/en/rest');
    expect(result.required).toBe(false);
  });

  // ── OAuth / SSO ─────────────────────────────────────────────────────────────

  it('requires approval for Google OAuth URL', () => {
    const result = approval.requiresApproval(
      'click',
      'https://accounts.google.com/o/oauth2/auth?client_id=123',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('oauth');
  });

  it('requires approval for Microsoft login URL', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('oauth');
  });

  it('requires approval for GitHub OAuth URL', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://github.com/login/oauth/authorize?client_id=abc',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('oauth');
  });

  it('requires approval for Auth0 URL', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://myapp.auth0.com/authorize',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('oauth');
  });

  // ── Financial ───────────────────────────────────────────────────────────────

  it('requires approval for PayPal checkout URL', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://www.paypal.com/checkout?token=EC-1234',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('financial');
  });

  it('requires approval for Stripe payment URL', () => {
    const result = approval.requiresApproval('submit', 'https://checkout.stripe.com/pay/cs_test');
    expect(result.required).toBe(true);
    expect(result.category).toBe('financial');
  });

  it('requires approval when params contain card_number field', () => {
    const result = approval.requiresApproval('submit', 'https://shop.example.com/order', {
      card_number: '4111111111111111',
      expiry: '12/26',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('financial');
  });

  it('requires approval when params contain cvv field', () => {
    const result = approval.requiresApproval('submit', 'https://shop.example.com/order', {
      cvv: '123',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('financial');
  });

  // ── Downloads ───────────────────────────────────────────────────────────────

  it('requires approval for download action regardless of URL', () => {
    const result = approval.requiresApproval('download', 'https://example.com/report');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  it('requires approval for .exe file extension in URL', () => {
    const result = approval.requiresApproval('click', 'https://cdn.example.com/setup.exe');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  it('requires approval for .dmg file extension in URL', () => {
    const result = approval.requiresApproval('click', 'https://releases.example.com/app.dmg');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  it('requires approval for .pkg file extension in URL', () => {
    const result = approval.requiresApproval('navigate', 'https://cdn.example.com/installer.pkg');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  it('requires approval for .zip file extension in URL', () => {
    const result = approval.requiresApproval('navigate', 'https://cdn.example.com/archive.zip');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  // ── Account settings ────────────────────────────────────────────────────────

  it('requires approval for /settings/security URL path', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://myapp.com/settings/security',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('account_settings');
  });

  it('requires approval for /account/delete URL path', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://myapp.com/account/delete',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('account_settings');
  });

  it('requires approval for /password/change URL path', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://myapp.com/password/change',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('account_settings');
  });

  // ── Form submissions ─────────────────────────────────────────────────────────

  it('requires approval for form submission with password field', () => {
    const result = approval.requiresApproval('submit', 'https://myapp.com/login', {
      username: 'alice',
      password: 'secret',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('form_submission');
  });

  it('requires approval for form submission with ssn field', () => {
    const result = approval.requiresApproval('submit', 'https://myapp.com/verify', {
      ssn: '123-45-6789',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('form_submission');
  });

  it('does not require approval for safe form submission', () => {
    const result = approval.requiresApproval('submit', 'https://myapp.com/search', {
      query: 'best practices',
      page: 1,
    });
    expect(result.required).toBe(false);
  });

  // ── Metadata quality ────────────────────────────────────────────────────────

  it('returns a reason string when approval is required', () => {
    const result = approval.requiresApproval(
      'navigate',
      'https://accounts.google.com/o/oauth2/auth',
    );
    expect(result.required).toBe(true);
    expect(typeof result.reason).toBe('string');
    expect((result.reason ?? '').length).toBeGreaterThan(0);
  });

  it('returns the correct category string for each signal type', () => {
    const cases: Array<[string, string, Record<string, unknown>?, string]> = [
      ['navigate', 'https://accounts.google.com/o/oauth2/auth', undefined, 'oauth'],
      ['navigate', 'https://www.paypal.com/checkout', undefined, 'financial'],
      ['download', 'https://example.com/file', undefined, 'download'],
      ['navigate', 'https://myapp.com/settings/security', undefined, 'account_settings'],
    ];

    for (const [action, url, params, expectedCategory] of cases) {
      const result = approval.requiresApproval(action, url, params);
      expect(result.category).toBe(expectedCategory);
    }
  });

  // ── Multiple signals ────────────────────────────────────────────────────────

  it('catches the first matching signal when multiple are present', () => {
    // OAuth URL that also contains a .zip extension — OAuth fires first
    const result = approval.requiresApproval(
      'navigate',
      'https://accounts.google.com/o/oauth2/auth?file=payload.zip',
    );
    expect(result.required).toBe(true);
    expect(result.category).toBe('oauth');
  });

  // ── assertApproved throws ────────────────────────────────────────────────────

  it('assertApproved throws HumanApprovalRequiredError for sensitive action', () => {
    expect(() =>
      approval.assertApproved('navigate', 'https://accounts.google.com/o/oauth2/auth'),
    ).toThrow(HumanApprovalRequiredError);
  });

  it('assertApproved does not throw for benign action', () => {
    expect(() =>
      approval.assertApproved('click', 'https://example.com/about'),
    ).not.toThrow();
  });
});
