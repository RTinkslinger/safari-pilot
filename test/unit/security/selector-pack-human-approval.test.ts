/**
 * T79 C-5: HumanApproval gate fires on safari_register_selector.
 *
 * The register tool is a JS-injection surface — body is wrapped in a real
 * `new Function('root', 'arg', body)` constructor in page context. Even with
 * the C-1 validators rejecting `eval`/`Function` substrings and the feature
 * flag default-off, the registration itself is a sensitive action. Treat
 * it like OAuth or financial flows: humans must approve.
 *
 * This test asserts the gate logic — that calling `requiresApproval` /
 * `assertApproved` for `safari_register_selector` returns/throws regardless
 * of URL or params, because the tool action itself is sensitive.
 */
import { describe, expect, test } from 'vitest';
import { HumanApproval } from '../../../src/security/human-approval.js';
import { HumanApprovalRequiredError } from '../../../src/errors.js';

describe('T79 C-5 — HumanApproval gates safari_register_selector', () => {
  const ha = new HumanApproval();

  test('safari_register_selector requires approval on benign URL', () => {
    const result = ha.requiresApproval('safari_register_selector', 'https://example.com', {
      tabUrl: 'https://example.com',
      name: 'myEngine',
      body: 'return root.body;',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('tool_action');
    expect(result.reason).toMatch(/selector|injection|register/i);
  });

  test('assertApproved throws HumanApprovalRequiredError for register tool', () => {
    expect(() => {
      ha.assertApproved('safari_register_selector', 'https://example.com', {
        name: 'myEngine',
        body: 'return root.body;',
      });
    }).toThrow(HumanApprovalRequiredError);
  });

  test('safari_unregister_selector does NOT require approval (cleanup is benign)', () => {
    const result = ha.requiresApproval('safari_unregister_selector', 'https://example.com', {
      tabUrl: 'https://example.com',
      name: 'myEngine',
    });
    expect(result.required).toBe(false);
  });

  test('register tool fires approval even if other gates would not (no oauth, no financial)', () => {
    // Confirm the new sensitive-tool-action check fires BEFORE other URL/params heuristics.
    const result = ha.requiresApproval('safari_register_selector', 'http://localhost:8080/page', {
      name: 'myEngine',
      body: 'return root.body;',
    });
    expect(result.required).toBe(true);
    expect(result.category).toBe('tool_action');
  });

  test('benign tools (e.g. safari_get_text) still pass on benign URL', () => {
    const result = ha.requiresApproval('safari_get_text', 'https://example.com', {
      tabUrl: 'https://example.com',
      role: 'button',
    });
    expect(result.required).toBe(false);
  });
});
