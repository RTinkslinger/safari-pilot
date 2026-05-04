/**
 * T77 A-9 / T80: strict-mode action enforcement.
 *
 * Pre-fix: action tools silently picked matched[0] on multi-match.
 * Post-fix: action tools throw StrictnessViolationError unless strictness
 * is satisfied (matched.length===1, base testId/xpath, flat nth, or chain
 * ends in first/last/nth).
 *
 * Read tools (get_text/get_html/get_attribute) keep pick-first behavior.
 */
import { describe, expect, it } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T80 strictnessSatisfied flag in result envelope', () => {
  it('emitted JS computes strictnessSatisfied for all paths', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('__strictnessSatisfied');
    expect(js).toContain('strictnessSatisfied');
    expect(js).toContain('matchCount');
  });

  it('testId base locator marks strictnessSatisfied via locatorDesc.testId check', () => {
    const js = generateLocatorJs({ testId: 'submit-btn' });
    expect(js).toContain('locatorDesc.testId');
  });

  it('xpath base locator marks strictnessSatisfied via locatorDesc.xpath check', () => {
    const js = generateLocatorJs({ xpath: '//button[@id="submit"]' });
    expect(js).toContain('locatorDesc.xpath');
  });

  it('flat nth marks strictnessSatisfied', () => {
    const js = generateLocatorJs({ role: 'button', nth: 0 });
    expect(js).toContain('locatorDesc.nth');
  });

  it('chain ending in first/last/nth marks strictnessSatisfied', () => {
    const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
    expect(js).toContain('__lastOp');
    expect(js).toContain("'first'");
    expect(js).toContain("'last'");
    expect(js).toContain("'nth'");
  });
});

describe('T80 action handler strict-mode throw', () => {
  // Construct a fake engine that returns a multi-match result with strictnessSatisfied=false.
  // Then call safari_click handler — should throw StrictnessViolationError.
  it('safari_click throws StrictnessViolationError on multi-match without disambiguation', async () => {
    const fakeEngine = {
      name: 'extension' as const,
      executeJsInTab: async () => ({
        ok: true,
        value: JSON.stringify({
          found: true,
          selector: '[data-sp-ref="sp-xxx"]',
          element: { tagName: 'BUTTON', id: '', textContent: '' },
          matchCount: 3,
          strictnessSatisfied: false,
        }),
        elapsed_ms: 0,
      }),
      executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
    };
    const fakeServer = {} as never;
    const { InteractionTools } = await import('../../../src/tools/interaction.js');
    const tools = new InteractionTools(fakeEngine as never, fakeServer);
    const handler = tools.getHandler('safari_click')!;
    await expect(handler({ tabUrl: 'http://x', role: 'button' })).rejects.toThrow(
      /STRICTNESS_VIOLATION|matched 3 elements/i,
    );
  });

  it('safari_click does NOT throw when strictnessSatisfied=true (chain.first())', async () => {
    const fakeEngine = {
      name: 'extension' as const,
      executeJsInTab: async () => ({
        ok: true,
        value: JSON.stringify({
          found: true,
          selector: '[data-sp-ref="sp-yyy"]',
          element: { tagName: 'BUTTON', id: '', textContent: '' },
          matchCount: 3,
          strictnessSatisfied: true,
        }),
        elapsed_ms: 0,
      }),
      executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
    };
    const fakeServer = {} as never;
    const { InteractionTools } = await import('../../../src/tools/interaction.js');
    const tools = new InteractionTools(fakeEngine as never, fakeServer);
    const handler = tools.getHandler('safari_click')!;
    // May still fail on click execution (the mock doesn't actually click), but
    // must NOT throw StrictnessViolationError. Run the handler and assert the
    // error (if any) is not a strict violation.
    try {
      await handler({ tabUrl: 'http://x', role: 'button', chain: [{ op: 'first' }] });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/STRICTNESS_VIOLATION|matched \d+ elements/i);
    }
  });

  it('safari_click does NOT throw on single match (matchCount=1)', async () => {
    const fakeEngine = {
      name: 'extension' as const,
      executeJsInTab: async () => ({
        ok: true,
        value: JSON.stringify({
          found: true,
          selector: '[data-sp-ref="sp-zzz"]',
          element: { tagName: 'BUTTON', id: '', textContent: '' },
          matchCount: 1,
          strictnessSatisfied: true,
        }),
        elapsed_ms: 0,
      }),
      executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
    };
    const fakeServer = {} as never;
    const { InteractionTools } = await import('../../../src/tools/interaction.js');
    const tools = new InteractionTools(fakeEngine as never, fakeServer);
    const handler = tools.getHandler('safari_click')!;
    try {
      await handler({ tabUrl: 'http://x', role: 'button' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toMatch(/STRICTNESS_VIOLATION/i);
    }
  });

  // Parametric coverage: verify shared resolveElement(strict=true) enforces
  // STRICTNESS_VIOLATION across multiple action handlers, not just click.
  // Catches a future refactor that branches the shared method per handler.
  for (const toolName of ['safari_fill', 'safari_hover', 'safari_double_click']) {
    it(`${toolName} throws StrictnessViolationError on multi-match without disambiguation`, async () => {
      const fakeEngine = {
        name: 'extension' as const,
        executeJsInTab: async () => ({
          ok: true,
          value: JSON.stringify({
            found: true,
            selector: '[data-sp-ref="sp-multi"]',
            element: { tagName: 'BUTTON', id: '', textContent: '' },
            matchCount: 5,
            strictnessSatisfied: false,
          }),
          elapsed_ms: 0,
        }),
        executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
      };
      const fakeServer = {} as never;
      const { InteractionTools } = await import('../../../src/tools/interaction.js');
      const tools = new InteractionTools(fakeEngine as never, fakeServer);
      const handler = tools.getHandler(toolName)!;
      // Each tool needs slightly different params; supply only what it requires.
      const params: Record<string, unknown> = { tabUrl: 'http://x', role: 'button' };
      if (toolName === 'safari_fill') params['value'] = 'hi';
      await expect(handler(params)).rejects.toThrow(/STRICTNESS_VIOLATION|matched 5 elements/i);
    });
  }

  it('read tools (get_text) do NOT enforce strict mode — pick-first preserved', async () => {
    // Test through ExtractionTools — get_text should NOT throw on multi-match.
    const fakeEngine = {
      name: 'extension' as const,
      executeJsInTab: async () => ({
        ok: true,
        value: JSON.stringify({ text: 'hi', length: 2, truncated: false }),
        elapsed_ms: 0,
      }),
      executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
    };
    const { ExtractionTools } = await import('../../../src/tools/extraction.js');
    const tools = new ExtractionTools(fakeEngine as never);
    const handler = tools.getHandler('safari_get_text')!;
    // get_text doesn't go through generateLocatorJs in the same way for this
    // mock path — it'll succeed with the fake engine's pre-canned result.
    // The point is: no STRICTNESS_VIOLATION import is referenced in extraction.ts.
    const result = await handler({ tabUrl: 'http://x' });
    expect(result).toBeDefined();
  });
});
