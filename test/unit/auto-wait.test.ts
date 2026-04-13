import { describe, it, expect } from 'vitest';
import {
  generateAutoWaitJs,
  ACTION_CHECKS,
  type ActionabilityCheck,
  type AutoWaitOptions,
} from '../../src/auto-wait.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Verify that the generated JS is a syntactically valid expression. */
function assertValidJs(js: string): void {
  // Should not throw on parse — wrap in async function since it returns a Promise
  expect(() => new Function(`return ${js}`)).not.toThrow();
}

/** Check that generated JS is a self-contained IIFE starting with `(function()` */
function assertIIFE(js: string): void {
  expect(js.trimStart()).toMatch(/^\(function\(\)\s*\{/);
  expect(js.trimEnd()).toMatch(/\}\)\(\)$/);
}

/** Verify the JS uses only `var`, never `let` or `const` declarations. */
function assertVarOnly(js: string): void {
  // Match `let ` or `const ` at the start of a line or after semicolons/braces,
  // but not inside string literals. Good enough heuristic for generated code.
  const lines = js.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip string-only lines
    if (trimmed.startsWith("'") || trimmed.startsWith('"')) continue;
    // Check for let/const declarations (not inside strings)
    expect(trimmed).not.toMatch(/^\s*(let|const)\s+/);
    expect(trimmed).not.toMatch(/[;{}]\s*(let|const)\s+/);
  }
}

// ─── ACTION_CHECKS profiles ─────────────────────────────────────────────────

describe('ACTION_CHECKS', () => {
  it('defines check profiles for all standard actions', () => {
    const expectedActions = [
      'click',
      'dblclick',
      'check',
      'hover',
      'drag',
      'fill',
      'selectOption',
      'type',
      'pressKey',
      'scroll',
    ];
    for (const action of expectedActions) {
      expect(ACTION_CHECKS).toHaveProperty(action);
      expect(Array.isArray(ACTION_CHECKS[action])).toBe(true);
    }
  });

  it('click requires visible, stable, enabled, receivesEvents', () => {
    expect(ACTION_CHECKS.click).toEqual(['visible', 'stable', 'enabled', 'receivesEvents']);
  });

  it('dblclick has same checks as click', () => {
    expect(ACTION_CHECKS.dblclick).toEqual(ACTION_CHECKS.click);
  });

  it('check has same checks as click', () => {
    expect(ACTION_CHECKS.check).toEqual(ACTION_CHECKS.click);
  });

  it('hover requires visible, stable, receivesEvents (no enabled)', () => {
    expect(ACTION_CHECKS.hover).toEqual(['visible', 'stable', 'receivesEvents']);
    expect(ACTION_CHECKS.hover).not.toContain('enabled');
  });

  it('drag requires visible, stable, receivesEvents', () => {
    expect(ACTION_CHECKS.drag).toEqual(['visible', 'stable', 'receivesEvents']);
  });

  it('fill requires visible, enabled, editable', () => {
    expect(ACTION_CHECKS.fill).toEqual(['visible', 'enabled', 'editable']);
  });

  it('selectOption requires visible and enabled only', () => {
    expect(ACTION_CHECKS.selectOption).toEqual(['visible', 'enabled']);
  });

  it('type has empty checks (operates on focused element)', () => {
    expect(ACTION_CHECKS.type).toEqual([]);
  });

  it('pressKey has empty checks', () => {
    expect(ACTION_CHECKS.pressKey).toEqual([]);
  });

  it('scroll has empty checks', () => {
    expect(ACTION_CHECKS.scroll).toEqual([]);
  });
});

// ─── generateAutoWaitJs — structure ──────────────────────────────────────────

describe('generateAutoWaitJs - output structure', () => {
  it('returns a string', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(typeof js).toBe('string');
  });

  it('produces a self-contained IIFE', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    assertIIFE(js);
  });

  it('produces valid JavaScript', () => {
    const js = generateAutoWaitJs('#btn', ['visible', 'stable', 'enabled', 'receivesEvents']);
    assertValidJs(js);
  });

  it('uses var, never let/const', () => {
    // Test with all checks to maximize coverage of generated code
    const js = generateAutoWaitJs('#btn', [
      'visible',
      'stable',
      'enabled',
      'editable',
      'receivesEvents',
    ]);
    assertVarOnly(js);
  });

  it('embeds the selector safely via JSON.stringify', () => {
    const tricky = 'div[data-value="hello\'world"]';
    const js = generateAutoWaitJs(tricky, ['visible']);
    // The selector should appear as a JSON-escaped string
    expect(js).toContain(JSON.stringify(tricky));
    assertValidJs(js);
  });

  it('handles selectors with special characters', () => {
    const selectors = [
      '#my-id',
      '.class-name',
      'div > p:nth-child(2)',
      '[data-testid="login-btn"]',
      'input[name="user\\"name"]',
      '#id\\:with\\:colons',
    ];
    for (const sel of selectors) {
      const js = generateAutoWaitJs(sel, ['visible']);
      assertValidJs(js);
      assertIIFE(js);
    }
  });
});

// ─── generateAutoWaitJs — timeout ────────────────────────────────────────────

describe('generateAutoWaitJs - timeout', () => {
  it('defaults timeout to 5000ms', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('5000');
  });

  it('respects custom timeout', () => {
    const js = generateAutoWaitJs('#btn', ['visible'], { timeout: 10000 });
    expect(js).toContain('10000');
    // Should NOT contain the default
    expect(js).not.toMatch(/var __timeout = 5000/);
  });

  it('allows very short timeout', () => {
    const js = generateAutoWaitJs('#btn', ['visible'], { timeout: 100 });
    expect(js).toContain('100');
    assertValidJs(js);
  });
});

// ─── generateAutoWaitJs — force option ───────────────────────────────────────

describe('generateAutoWaitJs - force option', () => {
  it('generates simpler JS when force=true', () => {
    const forceJs = generateAutoWaitJs('#btn', ['visible', 'stable', 'enabled'], { force: true });
    const normalJs = generateAutoWaitJs('#btn', ['visible', 'stable', 'enabled']);

    // Force JS should be significantly shorter (no check functions)
    expect(forceJs.length).toBeLessThan(normalJs.length);
    assertIIFE(forceJs);
    assertValidJs(forceJs);
  });

  it('skips all check functions when force=true', () => {
    const js = generateAutoWaitJs('#btn', ['visible', 'stable', 'enabled'], { force: true });
    expect(js).not.toContain('__isVisible');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__isEnabled');
    expect(js).not.toContain('__isEditable');
    expect(js).not.toContain('__receivesEvents');
  });

  it('still finds the element when force=true', () => {
    const js = generateAutoWaitJs('#submit', ['visible'], { force: true });
    expect(js).toContain('querySelector');
    expect(js).toContain(JSON.stringify('#submit'));
  });

  it('returns ready:true structure when force=true', () => {
    const js = generateAutoWaitJs('#btn', ['visible'], { force: true });
    expect(js).toContain('ready: true');
    expect(js).toContain('checks: {}');
  });

  it('handles not_found even in force mode', () => {
    const js = generateAutoWaitJs('#btn', ['visible'], { force: true });
    expect(js).toContain('not_found');
    expect(js).toContain('__timeout');
  });
});

// ─── generateAutoWaitJs — empty checks ───────────────────────────────────────

describe('generateAutoWaitJs - empty checks', () => {
  it('generates force-style JS when checks array is empty', () => {
    const js = generateAutoWaitJs('#btn', []);
    assertIIFE(js);
    assertValidJs(js);
    // Should behave like force mode — no check functions
    expect(js).not.toContain('__isVisible');
    expect(js).not.toContain('__checkStable');
  });

  it('type action uses empty checks (via ACTION_CHECKS)', () => {
    const js = generateAutoWaitJs('#input', ACTION_CHECKS.type);
    // Empty checks should produce force-style code
    expect(js).not.toContain('__isVisible');
  });
});

// ─── generateAutoWaitJs — individual checks ──────────────────────────────────

describe('generateAutoWaitJs - visible check', () => {
  it('includes isVisible function', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('__isVisible');
    expect(js).toContain('getComputedStyle');
    expect(js).toContain('getBoundingClientRect');
  });

  it('checks display:none', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain("display === 'none'");
  });

  it('handles display:contents with child walk', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain("display === 'contents'");
    expect(js).toContain('firstChild');
    expect(js).toContain('nextSibling');
  });

  it('checks visibility property', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain("visibility !== 'visible'");
  });

  it('checks bounding rect dimensions', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('rect.width > 0');
    expect(js).toContain('rect.height > 0');
  });

  it('checks isConnected', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('isConnected');
  });

  it('does NOT check opacity (matches Playwright behavior)', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    // opacity:0 elements still receive events per Playwright spec
    expect(js).not.toMatch(/opacity\s*===\s*['"]?0/);
    expect(js).not.toMatch(/parseFloat.*opacity/);
  });

  it('generates not_visible failure hint about display:none', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('not_visible');
    expect(js).toContain('display:none');
  });
});

describe('generateAutoWaitJs - stable check', () => {
  it('includes checkStable function', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('__checkStable');
  });

  it('uses requestAnimationFrame', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('requestAnimationFrame');
  });

  it('requires 2 stable frames', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('stableCount >= 2');
  });

  it('includes 15ms frame guard to avoid coalesced rAF', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('time - lastTime < 15');
  });

  it('compares rect properties exactly', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('rect.x === lastRect.x');
    expect(js).toContain('rect.y === lastRect.y');
    expect(js).toContain('rect.w === lastRect.w');
    expect(js).toContain('rect.h === lastRect.h');
  });

  it('returns a Promise (async check)', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('new Promise');
  });

  it('generates not_stable failure hint', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('not_stable');
    expect(js).toContain('animating');
  });
});

describe('generateAutoWaitJs - enabled check', () => {
  it('includes isEnabled function', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('__isEnabled');
  });

  it('checks disabled property', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain("'disabled' in el");
    expect(js).toContain('el.disabled');
  });

  it('checks fieldset:disabled', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain("closest('fieldset:disabled')");
  });

  it('excludes legend children from fieldset:disabled', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain("closest('legend')");
  });

  it('walks ancestors for aria-disabled', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('aria-disabled');
    expect(js).toContain('parentElement');
  });

  it('generates not_enabled failure hint', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('not_enabled');
  });
});

describe('generateAutoWaitJs - editable check', () => {
  it('includes both isEnabled and isEditable functions', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('__isEnabled');
    expect(js).toContain('__isEditable');
  });

  it('checks readOnly property', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('el.readOnly');
  });

  it('walks ancestors for aria-readonly', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('aria-readonly');
  });

  it('delegates to isEnabled first', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    // isEditable calls isEnabled internally
    expect(js).toContain('__isEnabled(el)');
  });

  it('generates not_editable failure hint', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('not_editable');
  });
});

describe('generateAutoWaitJs - receivesEvents check', () => {
  it('includes receivesEvents function', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('__receivesEvents');
  });

  it('uses elementFromPoint for hit testing', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('elementFromPoint');
  });

  it('scrolls element into view first', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('scrollIntoView');
  });

  it('calculates center point of element', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('rect.width / 2');
    expect(js).toContain('rect.height / 2');
  });

  it('handles shadow DOM boundaries', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('shadowRoot');
    expect(js).toContain('shadowRoot.elementFromPoint');
  });

  it('walks up from hit target to find the element', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('node === el');
    expect(js).toContain('parentElement');
  });

  it('falls back to contains check', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('el.contains(hit)');
  });

  it('generates not_receivesEvents failure hint about overlays', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('not_receivesEvents');
    expect(js).toContain('overlay');
  });
});

// ─── generateAutoWaitJs — combined checks ────────────────────────────────────

describe('generateAutoWaitJs - combined checks (action profiles)', () => {
  it('click profile includes all 4 check functions', () => {
    const js = generateAutoWaitJs('#btn', ACTION_CHECKS.click);
    expect(js).toContain('__isVisible');
    expect(js).toContain('__checkStable');
    expect(js).toContain('__isEnabled');
    expect(js).toContain('__receivesEvents');
    assertValidJs(js);
  });

  it('fill profile includes visible, enabled, editable (no stable/receivesEvents)', () => {
    const js = generateAutoWaitJs('#input', ACTION_CHECKS.fill);
    expect(js).toContain('__isVisible');
    expect(js).toContain('__isEnabled');
    expect(js).toContain('__isEditable');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__receivesEvents');
    assertValidJs(js);
  });

  it('hover profile omits enabled check', () => {
    const js = generateAutoWaitJs('#link', ACTION_CHECKS.hover);
    expect(js).toContain('__isVisible');
    expect(js).toContain('__checkStable');
    expect(js).toContain('__receivesEvents');
    expect(js).not.toContain('__isEnabled');
    assertValidJs(js);
  });

  it('selectOption profile includes only visible and enabled', () => {
    const js = generateAutoWaitJs('select', ACTION_CHECKS.selectOption);
    expect(js).toContain('__isVisible');
    expect(js).toContain('__isEnabled');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__receivesEvents');
    assertValidJs(js);
  });

  it('all action profiles produce valid JS', () => {
    for (const [action, checks] of Object.entries(ACTION_CHECKS)) {
      const js = generateAutoWaitJs(`#${action}-target`, checks);
      assertValidJs(js);
      assertIIFE(js);
      assertVarOnly(js);
    }
  });
});

// ─── generateAutoWaitJs — backoff schedule ───────────────────────────────────

describe('generateAutoWaitJs - backoff schedule', () => {
  it('embeds the backoff array [0, 20, 100, 100, 500]', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('[0, 20, 100, 100, 500]');
  });

  it('uses backoff index with length clamping', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    // Should clamp to last element when idx exceeds array length
    expect(js).toContain('__backoff.length - 1');
  });

  it('force mode also includes backoff for polling', () => {
    const js = generateAutoWaitJs('#btn', ['visible'], { force: true });
    expect(js).toContain('[0, 20, 100, 100, 500]');
  });
});

// ─── generateAutoWaitJs — result shape ───────────────────────────────────────

describe('generateAutoWaitJs - result shape', () => {
  it('success result contains ready, selector, waitedMs, checks', () => {
    const js = generateAutoWaitJs('#btn', ['visible', 'enabled']);
    expect(js).toContain('ready: true');
    expect(js).toContain('selector: __sel');
    expect(js).toContain('waitedMs:');
    expect(js).toContain('checks:');
  });

  it('failure result contains ready, failedCheck, elementInfo, hints', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('ready: false');
    expect(js).toContain('failedCheck:');
    expect(js).toContain('elementInfo:');
    expect(js).toContain('hints:');
  });

  it('not_found failure includes helpful hint', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('not_found');
    expect(js).toContain('Verify the selector is correct');
  });

  it('elementInfo includes tagName, display, visibility, rect', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('tagName:');
    expect(js).toContain('display:');
    expect(js).toContain('visibility:');
    expect(js).toContain('rect:');
  });

  it('elementInfo includes disabled and readOnly for interaction checks', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('disabled:');
    expect(js).toContain('readOnly:');
  });

  it('elementInfo includes aria attributes', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('ariaDisabled:');
    expect(js).toContain('ariaReadonly:');
  });
});

// ─── generateAutoWaitJs — only includes needed helpers ───────────────────────

describe('generateAutoWaitJs - tree shaking helpers', () => {
  it('visible-only does not include stable/enabled/editable/receivesEvents', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('__isVisible');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__isEnabled');
    expect(js).not.toContain('__isEditable');
    expect(js).not.toContain('__receivesEvents');
  });

  it('enabled-only does not include visible/stable/receivesEvents', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('__isEnabled');
    expect(js).not.toContain('__isVisible');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__receivesEvents');
  });

  it('editable includes enabled (dependency) but not stable/receivesEvents', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('__isEditable');
    expect(js).toContain('__isEnabled');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__receivesEvents');
  });

  it('stable-only does not include visible/enabled/receivesEvents', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('__checkStable');
    expect(js).not.toContain('__isVisible');
    expect(js).not.toContain('__isEnabled');
    expect(js).not.toContain('__receivesEvents');
  });

  it('receivesEvents-only does not include visible/stable/enabled', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    expect(js).toContain('__receivesEvents');
    expect(js).not.toContain('__isVisible');
    expect(js).not.toContain('__checkStable');
    expect(js).not.toContain('__isEnabled');
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('generateAutoWaitJs - edge cases', () => {
  it('handles empty selector gracefully', () => {
    const js = generateAutoWaitJs('', ['visible']);
    assertValidJs(js);
    expect(js).toContain('""');
  });

  it('handles very long selector', () => {
    const longSelector = 'div > ' + Array.from({ length: 50 }, (_, i) => `span:nth-child(${i})`).join(' > ');
    const js = generateAutoWaitJs(longSelector, ['visible']);
    assertValidJs(js);
    assertIIFE(js);
  });

  it('handles selector with newlines and special chars', () => {
    const js = generateAutoWaitJs('div[data-x="a\nb"]', ['visible']);
    assertValidJs(js);
  });

  it('each check individually produces valid JS', () => {
    const allChecks: ActionabilityCheck[] = ['visible', 'stable', 'enabled', 'editable', 'receivesEvents'];
    for (const check of allChecks) {
      const js = generateAutoWaitJs('#el', [check]);
      assertValidJs(js);
      assertIIFE(js);
      assertVarOnly(js);
    }
  });

  it('all possible 2-check combinations produce valid JS', () => {
    const allChecks: ActionabilityCheck[] = ['visible', 'stable', 'enabled', 'editable', 'receivesEvents'];
    for (let i = 0; i < allChecks.length; i++) {
      for (let j = i + 1; j < allChecks.length; j++) {
        const js = generateAutoWaitJs('#el', [allChecks[i], allChecks[j]]);
        assertValidJs(js);
      }
    }
  });

  it('duplicate checks in array do not cause syntax errors', () => {
    const js = generateAutoWaitJs('#el', ['visible', 'visible', 'enabled']);
    assertValidJs(js);
  });
});

// ─── Hint content quality ────────────────────────────────────────────────────

describe('generateAutoWaitJs - hint content', () => {
  it('visible hint mentions display:none', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('display:none');
  });

  it('visible hint mentions visibility', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('visibility:');
  });

  it('visible hint mentions zero dimensions', () => {
    const js = generateAutoWaitJs('#btn', ['visible']);
    expect(js).toContain('zero dimensions');
  });

  it('stable hint mentions animating or layout shift', () => {
    const js = generateAutoWaitJs('#btn', ['stable']);
    expect(js).toContain('animating');
    expect(js).toContain('layout shift');
  });

  it('enabled hint mentions disabled attribute', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('disabled attribute');
  });

  it('enabled hint mentions disabled fieldset', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('disabled fieldset');
  });

  it('enabled hint mentions aria-disabled', () => {
    const js = generateAutoWaitJs('#btn', ['enabled']);
    expect(js).toContain('aria-disabled');
  });

  it('editable hint mentions readOnly', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('readOnly');
  });

  it('editable hint mentions not enabled as prerequisite', () => {
    const js = generateAutoWaitJs('#input', ['editable']);
    expect(js).toContain('not enabled');
  });

  it('receivesEvents hint mentions overlays', () => {
    const js = generateAutoWaitJs('#btn', ['receivesEvents']);
    // Should mention common causes of obscured elements
    expect(js).toMatch(/overlay|modal|sticky/i);
  });
});

// ─── TypeScript API contract ─────────────────────────────────────────────────

describe('TypeScript API contract', () => {
  it('generateAutoWaitJs accepts minimal arguments', () => {
    const js = generateAutoWaitJs('#btn', []);
    expect(typeof js).toBe('string');
  });

  it('generateAutoWaitJs accepts all optional fields', () => {
    const js = generateAutoWaitJs('#btn', ['visible'], { timeout: 3000, force: true });
    expect(typeof js).toBe('string');
  });

  it('ACTION_CHECKS values are arrays of ActionabilityCheck', () => {
    const validChecks = new Set(['visible', 'stable', 'enabled', 'editable', 'receivesEvents']);
    for (const [, checks] of Object.entries(ACTION_CHECKS)) {
      for (const check of checks) {
        expect(validChecks.has(check)).toBe(true);
      }
    }
  });
});
