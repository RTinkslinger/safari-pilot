import { describe, it, expect } from 'vitest';
import {
  generateLocatorJs,
  hasLocatorParams,
  extractLocatorFromParams,
  ROLE_SELECTORS,
  type LocatorDescriptor,
} from '../../src/locator.js';

// ─── hasLocatorParams ────────────────────────────────────────────────────────

describe('hasLocatorParams', () => {
  it('returns true when role is present', () => {
    expect(hasLocatorParams({ role: 'button' })).toBe(true);
  });

  it('returns true when text is present', () => {
    expect(hasLocatorParams({ text: 'Sign in' })).toBe(true);
  });

  it('returns true when label is present', () => {
    expect(hasLocatorParams({ label: 'Email' })).toBe(true);
  });

  it('returns true when testId is present', () => {
    expect(hasLocatorParams({ testId: 'submit-btn' })).toBe(true);
  });

  it('returns true when placeholder is present', () => {
    expect(hasLocatorParams({ placeholder: 'Enter email' })).toBe(true);
  });

  it('returns false when no locator keys are present', () => {
    expect(hasLocatorParams({ selector: '#foo', tabUrl: 'https://example.com' })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(hasLocatorParams({})).toBe(false);
  });

  it('returns false when locator keys are null', () => {
    expect(hasLocatorParams({ role: null, text: null })).toBe(false);
  });

  it('returns false when locator keys are undefined', () => {
    expect(hasLocatorParams({ role: undefined })).toBe(false);
  });

  it('ignores non-locator keys like selector and ref', () => {
    expect(hasLocatorParams({ selector: '#btn', ref: 'e42', tabUrl: 'http://x.com' })).toBe(false);
  });

  it('returns true when only name is NOT sufficient (name alone is not a locator key)', () => {
    // `name` by itself does not trigger — it modifies role
    expect(hasLocatorParams({ name: 'Submit' })).toBe(false);
  });
});

// ─── extractLocatorFromParams ────────────────────────────────────────────────

describe('extractLocatorFromParams', () => {
  it('returns null when no locator keys present', () => {
    expect(extractLocatorFromParams({ selector: '#foo' })).toBeNull();
  });

  it('extracts role', () => {
    const desc = extractLocatorFromParams({ role: 'button' });
    expect(desc).toEqual({ role: 'button' });
  });

  it('extracts role + name', () => {
    const desc = extractLocatorFromParams({ role: 'button', name: 'Submit' });
    expect(desc).toEqual({ role: 'button', name: 'Submit' });
  });

  it('extracts text', () => {
    const desc = extractLocatorFromParams({ text: 'Sign in' });
    expect(desc).toEqual({ text: 'Sign in' });
  });

  it('extracts label', () => {
    const desc = extractLocatorFromParams({ label: 'Email' });
    expect(desc).toEqual({ label: 'Email' });
  });

  it('extracts testId', () => {
    const desc = extractLocatorFromParams({ testId: 'submit-btn' });
    expect(desc).toEqual({ testId: 'submit-btn' });
  });

  it('extracts placeholder', () => {
    const desc = extractLocatorFromParams({ placeholder: 'Enter email' });
    expect(desc).toEqual({ placeholder: 'Enter email' });
  });

  it('extracts exact flag', () => {
    const desc = extractLocatorFromParams({ text: 'Sign in', exact: true });
    expect(desc).toEqual({ text: 'Sign in', exact: true });
  });

  it('ignores non-string values for string fields', () => {
    const desc = extractLocatorFromParams({ role: 123, text: 'ok' });
    expect(desc).toEqual({ text: 'ok' });
    expect(desc!.role).toBeUndefined();
  });

  it('ignores non-boolean exact', () => {
    const desc = extractLocatorFromParams({ text: 'ok', exact: 'yes' });
    expect(desc).toEqual({ text: 'ok' });
    expect(desc!.exact).toBeUndefined();
  });

  it('extracts multiple locator keys (all present)', () => {
    const desc = extractLocatorFromParams({
      role: 'button',
      name: 'Submit',
      text: 'Submit',
      label: 'Submit',
      testId: 'submit',
      placeholder: 'Type here',
      exact: false,
    });
    expect(desc).toEqual({
      role: 'button',
      name: 'Submit',
      text: 'Submit',
      label: 'Submit',
      testId: 'submit',
      placeholder: 'Type here',
      exact: false,
    });
  });

  it('strips non-locator params from result', () => {
    const desc = extractLocatorFromParams({
      role: 'button',
      tabUrl: 'https://example.com',
      selector: '#foo',
      timeout: 5000,
    });
    expect(desc).toEqual({ role: 'button' });
    expect(desc).not.toHaveProperty('tabUrl');
    expect(desc).not.toHaveProperty('selector');
    expect(desc).not.toHaveProperty('timeout');
  });
});

// ─── ROLE_SELECTORS map ──────────────────────────────────────────────────────

describe('ROLE_SELECTORS', () => {
  it('covers all common ARIA widget roles', () => {
    const widgetRoles = [
      'button',
      'checkbox',
      'combobox',
      'link',
      'listbox',
      'radio',
      'searchbox',
      'slider',
      'spinbutton',
      'switch',
      'tab',
      'textbox',
    ];
    for (const role of widgetRoles) {
      expect(ROLE_SELECTORS[role], `missing widget role: ${role}`).toBeDefined();
    }
  });

  it('covers all common ARIA landmark roles', () => {
    const landmarks = ['navigation', 'main', 'complementary', 'region', 'form'];
    for (const role of landmarks) {
      expect(ROLE_SELECTORS[role], `missing landmark role: ${role}`).toBeDefined();
    }
  });

  it('covers all common ARIA structure roles', () => {
    const structures = [
      'heading',
      'list',
      'listitem',
      'table',
      'row',
      'cell',
      'columnheader',
      'img',
      'article',
      'group',
      'separator',
    ];
    for (const role of structures) {
      expect(ROLE_SELECTORS[role], `missing structure role: ${role}`).toBeDefined();
    }
  });

  it('every role selector includes the explicit [role="..."] selector', () => {
    for (const [role, css] of Object.entries(ROLE_SELECTORS)) {
      expect(css, `role "${role}" missing explicit [role=]`).toContain(`[role="${role}"]`);
    }
  });

  it('button selector includes all submit/reset/image input types', () => {
    const sel = ROLE_SELECTORS.button;
    expect(sel).toContain('button');
    expect(sel).toContain('input[type="button"]');
    expect(sel).toContain('input[type="submit"]');
    expect(sel).toContain('input[type="reset"]');
    expect(sel).toContain('input[type="image"]');
  });

  it('heading selector includes h1-h6', () => {
    const sel = ROLE_SELECTORS.heading;
    for (let i = 1; i <= 6; i++) {
      expect(sel).toContain(`h${i}`);
    }
  });

  it('link selector includes a[href] and area[href]', () => {
    const sel = ROLE_SELECTORS.link;
    expect(sel).toContain('a[href]');
    expect(sel).toContain('area[href]');
  });

  it('textbox selector includes various text-like input types', () => {
    const sel = ROLE_SELECTORS.textbox;
    expect(sel).toContain('textarea');
    expect(sel).toContain('input[type="text"]');
    expect(sel).toContain('input[type="email"]');
    expect(sel).toContain('input[type="tel"]');
    expect(sel).toContain('input[type="url"]');
    expect(sel).toContain('input:not([type])');
  });

  it('dialog selector includes the <dialog> element', () => {
    expect(ROLE_SELECTORS.dialog).toContain('dialog');
  });
});

// ─── generateLocatorJs — structural checks ──────────────────────────────────

describe('generateLocatorJs - structure', () => {
  it('returns a string', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(typeof js).toBe('string');
  });

  it('is a self-contained IIFE (starts with "(function()" and ends with ")()")', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js.trimStart()).toMatch(/^\(function\(\)/);
    expect(js.trimEnd()).toMatch(/\)\(\)$/);
  });

  it('does not use let or const (var only for Safari compat)', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    // Split by lines and check — skip strings/comments, focus on declarations
    const lines = js.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty, comments, strings inside JSON.stringify
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      // Check for let/const declarations (word boundary to avoid "newsletter", "constant", etc.)
      expect(trimmed).not.toMatch(/(?:^|[^a-zA-Z_$])(?:let|const)\s+[a-zA-Z_$]/);
    }
  });

  it('returns JSON.stringify result (synchronous, not a Promise)', () => {
    const js = generateLocatorJs({ text: 'hello' });
    expect(js).toContain('JSON.stringify');
    expect(js).not.toContain('Promise');
    expect(js).not.toContain('async');
    expect(js).not.toContain('await');
  });

  it('includes normalizeWhitespace helper', () => {
    const js = generateLocatorJs({ text: 'hello' });
    expect(js).toContain('function normalizeWhitespace');
  });

  it('includes matchText helper', () => {
    const js = generateLocatorJs({ text: 'hello' });
    expect(js).toContain('function matchText');
  });
});

// ─── generateLocatorJs — Role resolution ─────────────────────────────────────

describe('generateLocatorJs - role resolution', () => {
  it('uses querySelectorAll with the pre-filter CSS for known roles', () => {
    const js = generateLocatorJs({ role: 'button' });
    // Should contain the button pre-filter selectors (quotes are escaped for JS embedding)
    expect(js).toContain('[role=\\"button\\"]');
    expect(js).toContain('querySelectorAll');
  });

  it('falls back to [role="custom"] for unknown roles', () => {
    const js = generateLocatorJs({ role: 'treegrid' });
    // Unknown roles use the fallback path which embeds literal quotes (not escaped)
    expect(js).toContain('[role="treegrid"]');
  });

  it('includes accessible name computation when name is provided', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    expect(js).toContain('getAccessibleName');
    expect(js).toContain('Submit');
  });

  it('does not filter by name when name is omitted', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).not.toContain('nameMatched');
  });

  it('generates helpful hint on name mismatch (includes found names)', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    // The JS should build a hint showing what names were found
    expect(js).toContain('Names found');
    expect(js).toContain('allNames');
  });

  it('includes getAccessibleName function with computedName, aria-label, and textContent fallbacks', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    expect(js).toContain('computedName');
    expect(js).toContain('aria-label');
    expect(js).toContain('aria-labelledby');
    expect(js).toContain('textContent');
  });
});

// ─── generateLocatorJs — Text resolution ─────────────────────────────────────

describe('generateLocatorJs - text resolution', () => {
  it('searches all elements (querySelectorAll("*"))', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    expect(js).toContain("querySelectorAll('*')");
  });

  it('skips script, style, noscript, and template tags', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    expect(js).toContain('SCRIPT');
    expect(js).toContain('STYLE');
    expect(js).toContain('NOSCRIPT');
    expect(js).toContain('TEMPLATE');
  });

  it('uses innerText with textContent fallback', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    expect(js).toContain('innerText');
    expect(js).toContain('textContent');
  });

  it('normalizes whitespace in element text', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    expect(js).toContain('normalizeWhitespace');
  });

  it('filters to most specific (deepest) matches when multiple match', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    // The deduplication logic uses el.contains() to remove ancestor matches
    expect(js).toContain('.contains(');
  });

  it('default matching is substring, case-insensitive', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    // matchText with exact=false does toLowerCase + indexOf
    expect(js).toContain('toLowerCase');
    expect(js).toContain('indexOf');
    expect(js).toContain('exact = false');
  });
});

// ─── generateLocatorJs — Label resolution ────────────────────────────────────

describe('generateLocatorJs - label resolution', () => {
  it('searches labelable elements (input, select, textarea, etc.)', () => {
    const js = generateLocatorJs({ label: 'Email' });
    expect(js).toContain('input,select,textarea,button,meter,output,progress');
  });

  it('checks aria-labelledby references', () => {
    const js = generateLocatorJs({ label: 'Email' });
    expect(js).toContain('aria-labelledby');
    expect(js).toContain('getElementById');
  });

  it('checks element.labels association', () => {
    const js = generateLocatorJs({ label: 'Email' });
    expect(js).toContain('el.labels');
  });

  it('checks aria-label attribute', () => {
    const js = generateLocatorJs({ label: 'Email' });
    expect(js).toContain("getAttribute('aria-label')");
  });

  it('embeds the label query string', () => {
    const js = generateLocatorJs({ label: 'Email address' });
    expect(js).toContain('Email address');
  });
});

// ─── generateLocatorJs — TestId resolution ───────────────────────────────────

describe('generateLocatorJs - testId resolution', () => {
  it('uses exact attribute selector on data-testid', () => {
    const js = generateLocatorJs({ testId: 'submit-btn' });
    expect(js).toContain('[data-testid="submit-btn"]');
  });

  it('uses querySelector (single match expected)', () => {
    const js = generateLocatorJs({ testId: 'submit-btn' });
    expect(js).toContain('querySelector');
  });

  it('is case-sensitive (embeds exact value)', () => {
    const js = generateLocatorJs({ testId: 'SubmitBtn' });
    expect(js).toContain('SubmitBtn');
    // testId uses exact attribute selector — the resolution block itself
    // does not call matchText (though the shared helper is still defined in the IIFE)
    expect(js).toContain('[data-testid=');
  });
});

// ─── generateLocatorJs — Placeholder resolution ─────────────────────────────

describe('generateLocatorJs - placeholder resolution', () => {
  it('matches elements with placeholder attribute', () => {
    const js = generateLocatorJs({ placeholder: 'Enter email' });
    expect(js).toContain('placeholder');
  });

  it('with exact=true uses attribute selector directly', () => {
    const js = generateLocatorJs({ placeholder: 'Enter email', exact: true });
    expect(js).toContain('[placeholder="Enter email"]');
  });

  it('with exact=false (default) iterates elements for substring match', () => {
    const js = generateLocatorJs({ placeholder: 'Enter email' });
    expect(js).toContain("querySelectorAll('[placeholder]')");
    expect(js).toContain('matchText');
  });
});

// ─── generateLocatorJs — text matching modes ─────────────────────────────────

describe('generateLocatorJs - matching modes', () => {
  it('exact=false (default) uses case-insensitive substring', () => {
    const js = generateLocatorJs({ text: 'Sign in' });
    // matchText function should do toLowerCase and indexOf
    expect(js).toContain('function matchText');
    expect(js).toContain('toLowerCase');
    expect(js).toContain('indexOf');
  });

  it('exact=true compares with strict equality', () => {
    const js = generateLocatorJs({ text: 'Sign in', exact: true });
    // matchText with exact=true returns haystack === needle
    expect(js).toContain('exact = true');
  });

  it('exact flag is correctly propagated for role+name', () => {
    const jsExact = generateLocatorJs({ role: 'button', name: 'Submit', exact: true });
    expect(jsExact).toContain('exact = true');

    const jsSubstr = generateLocatorJs({ role: 'button', name: 'Submit', exact: false });
    expect(jsSubstr).toContain('exact = false');
  });

  it('exact flag is correctly propagated for label', () => {
    const js = generateLocatorJs({ label: 'Email', exact: true });
    expect(js).toContain('exact = true');
  });
});

// ─── generateLocatorJs — result envelope ─────────────────────────────────────

describe('generateLocatorJs - result envelope', () => {
  it('stamps matched element with data-sp-ref attribute', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('data-sp-ref');
    expect(js).toContain('setAttribute');
  });

  it('generates a random ref ID prefixed with "sp-"', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain("'sp-'");
    expect(js).toContain('Math.random');
  });

  it('returns selector for the stamped ref in success result', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('[data-sp-ref="');
    expect(js).toContain('refId');
  });

  it('includes matchCount in success result', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('matchCount');
    expect(js).toContain('matched.length');
  });

  it('includes element info (tagName, id, textContent) in success result', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('tagName');
    expect(js).toContain('target.id');
    expect(js).toContain('textContent');
  });

  it('truncates textContent to 200 chars in result', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('substring(0, 200)');
  });

  it('returns found:false with hint on no matches', () => {
    const js = generateLocatorJs({ text: 'hello' });
    expect(js).toContain('found: false');
    expect(js).toContain('hint');
  });

  it('includes locator descriptor in failure result', () => {
    const js = generateLocatorJs({ text: 'hello' });
    expect(js).toContain('locatorDesc');
    expect(js).toContain('locator: locatorDesc');
  });

  it('includes candidateCount in failure result', () => {
    const js = generateLocatorJs({ text: 'hello' });
    expect(js).toContain('candidateCount');
  });
});

// ─── generateLocatorJs — scope selector ──────────────────────────────────────

describe('generateLocatorJs - scopeSelector', () => {
  it('defaults to document as root when no scopeSelector', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('var root = document;');
  });

  it('narrows search to scopeSelector when provided', () => {
    const js = generateLocatorJs({ role: 'button' }, { scopeSelector: '#form-container' });
    expect(js).toContain("#form-container");
    expect(js).toContain('querySelector');
  });

  it('returns error when scopeSelector element is not found', () => {
    const js = generateLocatorJs({ role: 'button' }, { scopeSelector: '.missing' });
    expect(js).toContain('Scope selector');
    expect(js).toContain('not found');
  });
});

// ─── generateLocatorJs — empty/invalid locator ──────────────────────────────

describe('generateLocatorJs - empty locator', () => {
  it('returns immediate failure for empty descriptor', () => {
    const js = generateLocatorJs({});
    expect(js).toContain('found: false');
    expect(js).toContain('No locator key provided');
  });

  it('returns a valid IIFE even for empty descriptor', () => {
    const js = generateLocatorJs({});
    expect(js.trimStart()).toMatch(/^\(function\(\)/);
    expect(js.trimEnd()).toMatch(/\)\(\)$/);
  });
});

// ─── generateLocatorJs — priority order ──────────────────────────────────────

describe('generateLocatorJs - priority when multiple locator keys present', () => {
  it('prefers testId over other keys', () => {
    const js = generateLocatorJs({
      testId: 'submit',
      role: 'button',
      text: 'Submit',
      label: 'Submit',
      placeholder: 'Type',
    });
    // testId uses exact attribute selector, not querySelectorAll('*')
    expect(js).toContain('[data-testid="submit"]');
    // Should NOT contain text resolution's querySelectorAll('*')
    expect(js).not.toContain("querySelectorAll('*')");
  });

  it('prefers role over label/placeholder/text when testId absent', () => {
    const js = generateLocatorJs({
      role: 'button',
      text: 'Submit',
      label: 'Submit',
    });
    // Should contain role pre-filter selectors (escaped quotes in generated JS)
    expect(js).toContain('[role=\\"button\\"]');
    // Should NOT contain text's querySelectorAll('*') or label's labelable selector
    expect(js).not.toContain("querySelectorAll('*')");
    expect(js).not.toContain('input,select,textarea,button,meter,output,progress');
  });

  it('prefers label over placeholder and text', () => {
    const js = generateLocatorJs({
      label: 'Email',
      placeholder: 'Enter email',
      text: 'Email',
    });
    // Label searches labelable elements
    expect(js).toContain('input,select,textarea,button,meter,output,progress');
    // Should NOT contain text's querySelectorAll('*')
    expect(js).not.toContain("querySelectorAll('*')");
  });

  it('prefers placeholder over text', () => {
    const js = generateLocatorJs({
      placeholder: 'Enter email',
      text: 'Email',
    });
    // Placeholder searches [placeholder] elements
    expect(js).toContain("[placeholder]");
    // Should NOT contain text's querySelectorAll('*')
    expect(js).not.toContain("querySelectorAll('*')");
  });
});

// ─── generateLocatorJs — string escaping ─────────────────────────────────────

describe('generateLocatorJs - string escaping', () => {
  it('handles single quotes in name', () => {
    const js = generateLocatorJs({ role: 'button', name: "Don't" });
    // Should produce valid JS — the quote must be escaped
    expect(js).toContain("Don\\'t");
  });

  it('handles double quotes in text', () => {
    const js = generateLocatorJs({ text: 'Say "hello"' });
    expect(js).toContain('\\"hello\\"');
  });

  it('handles backslashes in testId', () => {
    const js = generateLocatorJs({ testId: 'path\\to\\thing' });
    expect(js).toContain('path\\\\to\\\\thing');
  });

  it('handles newlines in label', () => {
    const js = generateLocatorJs({ label: 'Line1\nLine2' });
    expect(js).toContain('Line1\\nLine2');
  });

  it('handles special chars in scopeSelector', () => {
    const js = generateLocatorJs({ role: 'button' }, { scopeSelector: '[data-x="y\'z"]' });
    // The scope selector string should survive embedding
    expect(js).toContain('data-x');
  });
});

// ─── generateLocatorJs — multiple matches ────────────────────────────────────

describe('generateLocatorJs - multiple match handling', () => {
  it('uses first match for stamping (matched[0])', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('var target = matched[0]');
  });

  it('reports matchCount in result so agent knows about ambiguity', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('matchCount: matched.length');
  });
});

// ─── generateLocatorJs — role+name failure hint ──────────────────────────────

describe('generateLocatorJs - role+name mismatch hint', () => {
  it('includes candidate count in hint', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    expect(js).toContain('candidates.length');
  });

  it('includes names found (up to 10) in hint for debugging', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    expect(js).toContain('allNames.slice(0, 10)');
  });

  it('returns locator descriptor in failure result for role+name mismatch', () => {
    const js = generateLocatorJs({ role: 'button', name: 'Submit' });
    expect(js).toContain('locator: locatorDesc');
  });
});

// ─── Integration: generated JS is parseable ──────────────────────────────────

describe('generateLocatorJs - JS validity', () => {
  const locators: Array<[string, LocatorDescriptor]> = [
    ['role only', { role: 'button' }],
    ['role + name', { role: 'button', name: 'Submit' }],
    ['role + name + exact', { role: 'link', name: 'Home', exact: true }],
    ['text', { text: 'Sign in' }],
    ['text + exact', { text: 'Sign in', exact: true }],
    ['label', { label: 'Email' }],
    ['testId', { testId: 'submit-btn' }],
    ['placeholder', { placeholder: 'Enter email' }],
    ['placeholder + exact', { placeholder: 'Enter email', exact: true }],
    ['empty', {}],
    ['unknown role', { role: 'treegrid' }],
  ];

  for (const [label, locator] of locators) {
    it(`produces parseable JS for: ${label}`, () => {
      const js = generateLocatorJs(locator);
      // Attempt to parse the JS as a function expression — should not throw
      // We can't execute it (no DOM), but we can verify it's syntactically valid
      expect(() => new Function(js)).not.toThrow();
    });
  }

  it('produces parseable JS with scopeSelector', () => {
    const js = generateLocatorJs({ role: 'button' }, { scopeSelector: '#container' });
    expect(() => new Function(js)).not.toThrow();
  });

  it('produces parseable JS with special characters', () => {
    const js = generateLocatorJs({ role: 'button', name: "It's a \"test\" with \\backslash" });
    expect(() => new Function(js)).not.toThrow();
  });
});
