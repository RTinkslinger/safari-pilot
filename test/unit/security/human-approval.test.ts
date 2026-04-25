/**
 * SD-04 unit coverage for the HumanApproval security layer (layer 4b).
 *
 * The e2e test in `test/e2e/security-layers.test.ts` covers the OAuth path
 * end-to-end through MCP. This unit suite covers the other 5 categories
 * (financial, financial-fields, downloads, account-settings, sensitive
 * form fields) without making real network calls.
 *
 * Discrimination: comment out any of the per-category branches in
 * `requiresApproval` → the corresponding test fails.
 */
import { describe, it, expect } from 'vitest';
import { HumanApproval } from '../../../src/security/human-approval.js';
import { HumanApprovalRequiredError } from '../../../src/errors.js';

describe('HumanApproval (SD-04)', () => {
  const ha = new HumanApproval();

  it('OAuth URL pattern → category=oauth, required=true', () => {
    const result = ha.requiresApproval('safari_navigate', 'https://accounts.google.com/o/oauth/test');
    expect(result.required).toBe(true);
    expect(result.category).toBe('oauth');
    expect(result.reason).toMatch(/oauth|sso/i);
  });

  it('Stripe checkout URL → category=financial', () => {
    const result = ha.requiresApproval('safari_navigate', 'https://checkout.stripe.com/pay/cs_test_xyz');
    expect(result.required).toBe(true);
    expect(result.category).toBe('financial');
  });

  it('Sensitive financial field name in params → category=financial', () => {
    const result = ha.requiresApproval('safari_fill', 'https://shop.test/cart', {
      card_number: '4111111111111111',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('financial');
    expect(result.reason).toContain('card_number');
  });

  it('Downloadable file extension in URL → category=download', () => {
    const result = ha.requiresApproval('safari_navigate', 'https://example.com/installer.dmg');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  it('Explicit download action → category=download regardless of URL', () => {
    const result = ha.requiresApproval('safari_wait_for_download', 'https://example.com/anything');
    expect(result.required).toBe(true);
    expect(result.category).toBe('download');
  });

  it('Account settings / password change path → category=account_settings', () => {
    const result = ha.requiresApproval('safari_navigate', 'https://example.com/settings/security');
    expect(result.required).toBe(true);
    expect(result.category).toBe('account_settings');
  });

  it('Sensitive form-field name on form-submitting action → category=form_submission', () => {
    const result = ha.requiresApproval('safari_fill', 'https://example.com/login', {
      password: 'hunter2',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('form_submission');
    expect(result.reason).toContain('password');
  });

  it('Benign URL + benign params → required=false', () => {
    const result = ha.requiresApproval('safari_navigate', 'https://example.com/about', { foo: 'bar' });
    expect(result.required).toBe(false);
    expect(result.category).toBeUndefined();
  });

  it('assertApproved() throws HumanApprovalRequiredError carrying the action and domain', () => {
    expect(() =>
      ha.assertApproved('safari_navigate', 'https://accounts.google.com/o/oauth/test'),
    ).toThrow(HumanApprovalRequiredError);
    try {
      ha.assertApproved('safari_navigate', 'https://accounts.google.com/o/oauth/test');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HumanApprovalRequiredError);
      expect((err as HumanApprovalRequiredError).code).toBe('HUMAN_APPROVAL_REQUIRED');
      expect((err as HumanApprovalRequiredError).message).toContain('accounts.google.com');
      expect((err as HumanApprovalRequiredError).message).toContain('safari_navigate');
    }
  });

  it('assertApproved() returns silently for benign action+url', () => {
    expect(() => ha.assertApproved('safari_navigate', 'https://example.com/about')).not.toThrow();
  });
});
