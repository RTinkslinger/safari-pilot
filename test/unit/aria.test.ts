import { describe, it, expect } from 'vitest';
import {
  generateSnapshotJs,
  resolveRefJs,
  buildRefSelector,
  type SnapshotOptions,
} from '../../src/aria.js';

// ── buildRefSelector ─────────────────────────────────────────────────────────

describe('buildRefSelector', () => {
  it('returns a CSS attribute selector for a ref', () => {
    expect(buildRefSelector('e1')).toBe('[data-sp-ref="e1"]');
  });

  it('works with large ref numbers', () => {
    expect(buildRefSelector('e999')).toBe('[data-sp-ref="e999"]');
  });

  it('handles arbitrary string input', () => {
    // buildRefSelector is a simple formatter — no validation
    expect(buildRefSelector('foo')).toBe('[data-sp-ref="foo"]');
  });
});

// ── resolveRefJs ─────────────────────────────────────────────────────────────

describe('resolveRefJs', () => {
  it('returns a querySelector call for valid ref', () => {
    const js = resolveRefJs('e1');
    expect(js).toBe('document.querySelector(\'[data-sp-ref="e1"]\')');
  });

  it('works with multi-digit refs', () => {
    const js = resolveRefJs('e42');
    expect(js).toContain('e42');
    expect(js).toContain('document.querySelector');
  });

  it('throws on invalid ref format — missing prefix', () => {
    expect(() => resolveRefJs('1')).toThrow('Invalid ref format');
  });

  it('throws on invalid ref format — wrong prefix', () => {
    expect(() => resolveRefJs('r1')).toThrow('Invalid ref format');
  });

  it('throws on invalid ref format — no number', () => {
    expect(() => resolveRefJs('e')).toThrow('Invalid ref format');
  });

  it('throws on invalid ref format — non-numeric suffix', () => {
    expect(() => resolveRefJs('eabc')).toThrow('Invalid ref format');
  });

  it('throws on empty string', () => {
    expect(() => resolveRefJs('')).toThrow('Invalid ref format');
  });

  it('throws on injection attempt', () => {
    expect(() => resolveRefJs('e1"]); alert("xss')).toThrow('Invalid ref format');
  });
});

// ── generateSnapshotJs — API contract ────────────────────────────────────────

describe('generateSnapshotJs', () => {
  it('returns a non-empty string', () => {
    const js = generateSnapshotJs();
    expect(typeof js).toBe('string');
    expect(js.length).toBeGreaterThan(100);
  });

  it('accepts empty options', () => {
    expect(() => generateSnapshotJs({})).not.toThrow();
  });

  it('accepts all options', () => {
    const opts: SnapshotOptions = {
      scopeSelector: '#main',
      maxDepth: 5,
      includeHidden: true,
      format: 'json',
    };
    expect(() => generateSnapshotJs(opts)).not.toThrow();
  });
});

// ── generateSnapshotJs — JS structure ────────────────────────────────────────

describe('generateSnapshotJs — JS structure', () => {
  const js = generateSnapshotJs();

  it('uses var, not let or const', () => {
    // The generated JS is intended for Safari compat — no let/const
    // Split into statements and check variable declarations
    // Note: the TS module itself uses let/const, but the GENERATED string must not
    expect(js).not.toMatch(/\blet\s+/);
    expect(js).not.toMatch(/\bconst\s+/);
  });

  it('does not contain backticks', () => {
    expect(js).not.toContain('`');
  });

  it('does not contain arrow functions', () => {
    // Arrow functions may not work in older Safari JS contexts
    expect(js).not.toMatch(/=>/);
  });

  it('contains the implicit role map function', () => {
    expect(js).toContain('__spImplicitRole');
  });

  it('contains the accessible name function', () => {
    expect(js).toContain('__spAccessibleName');
  });

  it('contains the tree walk function', () => {
    expect(js).toContain('__spWalk');
  });

  it('contains the YAML serializer', () => {
    expect(js).toContain('__spSerializeYaml');
  });

  it('contains the JSON serializer', () => {
    expect(js).toContain('__spSerializeJson');
  });

  it('contains data-sp-ref stamping logic', () => {
    expect(js).toContain('data-sp-ref');
  });

  it('references document.body as default root', () => {
    expect(js).toContain('document.body');
  });

  it('returns an object with expected result keys', () => {
    expect(js).toContain('snapshot:');
    expect(js).toContain('url:');
    expect(js).toContain('title:');
    expect(js).toContain('elementCount:');
    expect(js).toContain('interactiveCount:');
    expect(js).toContain('refMap:');
  });

  it('uses window.location.href for URL', () => {
    expect(js).toContain('window.location.href');
  });

  it('uses document.title for title', () => {
    expect(js).toContain('document.title');
  });
});

// ── generateSnapshotJs — options embedding ───────────────────────────────────

describe('generateSnapshotJs — options', () => {
  it('embeds maxDepth in generated JS', () => {
    const js = generateSnapshotJs({ maxDepth: 7 });
    expect(js).toContain('__spMaxDepth = 7');
  });

  it('uses default maxDepth of 15', () => {
    const js = generateSnapshotJs();
    expect(js).toContain('__spMaxDepth = 15');
  });

  it('embeds includeHidden as boolean', () => {
    const jsTrue = generateSnapshotJs({ includeHidden: true });
    expect(jsTrue).toContain('__spInclHidden = true');

    const jsFalse = generateSnapshotJs({ includeHidden: false });
    expect(jsFalse).toContain('__spInclHidden = false');
  });

  it('defaults includeHidden to false', () => {
    const js = generateSnapshotJs();
    expect(js).toContain('__spInclHidden = false');
  });

  it('embeds scopeSelector when provided', () => {
    const js = generateSnapshotJs({ scopeSelector: '#content' });
    expect(js).toContain("__spScopeSelector = '#content'");
  });

  it('defaults scopeSelector to empty string', () => {
    const js = generateSnapshotJs();
    expect(js).toContain("__spScopeSelector = ''");
  });

  it('escapes single quotes in scopeSelector', () => {
    const js = generateSnapshotJs({ scopeSelector: "[data-name='test']" });
    // The output should contain escaped single quotes: \'test\'
    expect(js).toContain("\\'test\\'");
    // Verify the generated JS is syntactically valid despite the quotes
    expect(() => new Function(js)).not.toThrow();
  });

  it('escapes backslashes in scopeSelector', () => {
    const js = generateSnapshotJs({ scopeSelector: '.class\\:name' });
    expect(js).toContain('\\\\');
  });

  it('embeds format option', () => {
    const jsYaml = generateSnapshotJs({ format: 'yaml' });
    expect(jsYaml).toContain("__spFormat = 'yaml'");

    const jsJson = generateSnapshotJs({ format: 'json' });
    expect(jsJson).toContain("__spFormat = 'json'");
  });

  it('defaults format to yaml', () => {
    const js = generateSnapshotJs();
    expect(js).toContain("__spFormat = 'yaml'");
  });
});

// ── Implicit Role Map coverage ───────────────────────────────────────────────

describe('generateSnapshotJs — implicit role map', () => {
  const js = generateSnapshotJs();

  // Verify key role mappings exist in the generated JS
  const expectedRoleMappings = [
    // Input types
    { pattern: '"checkbox"', desc: 'checkbox input type' },
    { pattern: '"radio"', desc: 'radio input type' },
    { pattern: '"slider"', desc: 'range input → slider' },
    { pattern: '"spinbutton"', desc: 'number input → spinbutton' },
    { pattern: '"searchbox"', desc: 'search input → searchbox' },
    { pattern: '"combobox"', desc: 'select → combobox' },
    // Landmark roles
    { pattern: '"navigation"', desc: 'nav → navigation' },
    { pattern: '"main"', desc: 'main → main' },
    { pattern: '"complementary"', desc: 'aside → complementary' },
    { pattern: '"banner"', desc: 'header → banner' },
    { pattern: '"contentinfo"', desc: 'footer → contentinfo' },
    // Structure roles
    { pattern: '"article"', desc: 'article → article' },
    { pattern: '"heading"', desc: 'h1-h6 → heading' },
    { pattern: '"list"', desc: 'ul/ol → list' },
    { pattern: '"listitem"', desc: 'li → listitem' },
    { pattern: '"table"', desc: 'table → table' },
    { pattern: '"row"', desc: 'tr → row' },
    { pattern: '"cell"', desc: 'td → cell' },
    { pattern: '"columnheader"', desc: 'th → columnheader' },
    { pattern: '"rowgroup"', desc: 'tbody → rowgroup' },
    { pattern: '"separator"', desc: 'hr → separator' },
    { pattern: '"figure"', desc: 'figure → figure' },
    // Widget roles
    { pattern: '"button"', desc: 'button → button' },
    { pattern: '"link"', desc: 'a[href] → link' },
    { pattern: '"textbox"', desc: 'textarea/input → textbox' },
    { pattern: '"progressbar"', desc: 'progress → progressbar' },
    { pattern: '"meter"', desc: 'meter → meter' },
    { pattern: '"status"', desc: 'output → status' },
    { pattern: '"listbox"', desc: 'datalist/select[multiple] → listbox' },
    { pattern: '"group"', desc: 'fieldset/details → group' },
    { pattern: '"dialog"', desc: 'dialog → dialog' },
    { pattern: '"option"', desc: 'option → option' },
    { pattern: '"paragraph"', desc: 'p → paragraph' },
    { pattern: '"search"', desc: 'search → search' },
    // Conditional roles
    { pattern: '"form"', desc: 'form with label → form' },
    { pattern: '"region"', desc: 'section with label → region' },
    { pattern: '"presentation"', desc: 'img[alt=""] → presentation' },
  ];

  for (const { pattern, desc } of expectedRoleMappings) {
    it(`includes role mapping: ${desc}`, () => {
      expect(js).toContain(pattern);
    });
  }

  it('handles input[list] → combobox before other input types', () => {
    // The list check must come before type checks to handle the override
    const listIdx = js.indexOf('hasAttribute("list")');
    const checkboxIdx = js.indexOf('"checkbox"');
    expect(listIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeLessThan(checkboxIdx);
  });

  it('handles form conditional: no label → generic', () => {
    expect(js).toContain('tag === "form"');
    expect(js).toContain('aria-label');
    expect(js).toContain('aria-labelledby');
  });

  it('handles section conditional: no label → generic', () => {
    expect(js).toContain('tag === "section"');
  });

  it('handles img alt="" → presentation', () => {
    expect(js).toContain('alt === ""');
    expect(js).toContain('"presentation"');
  });

  it('handles a[href] vs a without href', () => {
    // a with href → link, a without href → generic
    expect(js).toContain('hasAttribute("href")');
    expect(js).toContain('"link"');
  });

  it('handles hidden input → empty role (excluded)', () => {
    expect(js).toContain('"hidden"');
  });
});

// ── Accessible name computation ──────────────────────────────────────────────

describe('generateSnapshotJs — accessible name', () => {
  const js = generateSnapshotJs();

  it('tries computedName first (Safari 16.4+)', () => {
    expect(js).toContain('computedName');
  });

  it('falls back to aria-label', () => {
    expect(js).toContain('aria-label');
  });

  it('falls back to alt attribute', () => {
    // getAttribute("alt") in the name function
    expect(js).toMatch(/getAttribute\("alt"\)/);
  });

  it('falls back to title attribute', () => {
    expect(js).toMatch(/getAttribute\("title"\)/);
  });

  it('falls back to placeholder', () => {
    expect(js).toContain('placeholder');
  });

  it('falls back to label association', () => {
    expect(js).toContain('el.labels');
  });

  it('falls back to aria-labelledby', () => {
    expect(js).toContain('aria-labelledby');
    expect(js).toContain('getElementById');
  });

  it('truncates names to 80 characters', () => {
    expect(js).toContain('80');
    expect(js).toContain('substring(0, 80)');
  });
});

// ── State computation ────────────────────────────────────────────────────────

describe('generateSnapshotJs — states', () => {
  const js = generateSnapshotJs();

  it('detects checked state', () => {
    expect(js).toContain('el.checked');
    expect(js).toContain('aria-checked');
  });

  it('detects disabled state', () => {
    expect(js).toContain('el.disabled');
    expect(js).toContain('aria-disabled');
  });

  it('detects expanded state', () => {
    expect(js).toContain('aria-expanded');
  });

  it('detects pressed state', () => {
    expect(js).toContain('aria-pressed');
  });

  it('detects selected state', () => {
    expect(js).toContain('el.selected');
    expect(js).toContain('aria-selected');
  });

  it('detects heading level', () => {
    expect(js).toMatch(/\^h\(\\d\)\$/);
    expect(js).toContain('aria-level');
  });

  it('detects active element', () => {
    expect(js).toContain('document.activeElement');
  });

  it('detects required state', () => {
    expect(js).toContain('el.required');
    expect(js).toContain('aria-required');
  });

  it('detects readonly state', () => {
    expect(js).toContain('el.readOnly');
    expect(js).toContain('aria-readonly');
  });
});

// ── Interactability detection ────────────────────────────────────────────────

describe('generateSnapshotJs — interactability', () => {
  const js = generateSnapshotJs();

  it('considers native form controls interactable', () => {
    expect(js).toContain('tag === "button"');
    expect(js).toContain('tag === "select"');
    expect(js).toContain('tag === "textarea"');
  });

  it('considers anchors with href interactable', () => {
    expect(js).toContain('tag === "a" && el.hasAttribute("href")');
  });

  it('considers elements with tabindex interactable', () => {
    expect(js).toContain('hasAttribute("tabindex")');
  });

  it('skips tabindex=-1 from interactability', () => {
    expect(js).toContain('getAttribute("tabindex") !== "-1"');
  });

  it('considers ARIA interactive roles', () => {
    const interactiveRoles = [
      'button', 'link', 'checkbox', 'radio', 'tab', 'switch',
      'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
      'combobox', 'listbox', 'searchbox', 'slider', 'spinbutton',
      'textbox', 'treeitem',
    ];
    for (const role of interactiveRoles) {
      expect(js).toContain('"' + role + '"');
    }
  });

  it('considers contentEditable interactable', () => {
    expect(js).toContain('isContentEditable');
  });

  it('excludes pointer-events:none from interactability', () => {
    expect(js).toContain('pointerEvents');
    expect(js).toContain('"none"');
  });

  it('considers summary/details interactable', () => {
    expect(js).toContain('"summary"');
    expect(js).toContain('"details"');
  });
});

// ── Ref assignment ───────────────────────────────────────────────────────────

describe('generateSnapshotJs — ref assignment', () => {
  const js = generateSnapshotJs();

  it('assigns refs only to interactable elements', () => {
    expect(js).toContain('interactable ? __spAssignRef(el) : null');
  });

  it('stamps data-sp-ref attribute on DOM elements', () => {
    expect(js).toContain('setAttribute("data-sp-ref"');
  });

  it('uses monotonic eN naming', () => {
    expect(js).toContain('"e" + __spRefCounter');
  });

  it('reuses existing refs from previous snapshots', () => {
    expect(js).toContain('getAttribute("data-sp-ref")');
    // Should check for existing ref before assigning new one
    expect(js).toContain('var existing = el.getAttribute("data-sp-ref")');
  });

  it('continues numbering from highest existing ref', () => {
    expect(js).toContain('querySelectorAll("[data-sp-ref]")');
    expect(js).toContain('parseInt(refVal.substring(1), 10)');
  });

  it('populates refMap with selector strings', () => {
    expect(js).toContain('__spRefMap[ref]');
    expect(js).toContain('__spRefMap[existing]');
  });
});

// ── Visibility and skipping ──────────────────────────────────────────────────

describe('generateSnapshotJs — visibility', () => {
  const js = generateSnapshotJs();

  it('skips script tags', () => {
    expect(js).toContain('"script"');
  });

  it('skips style tags', () => {
    expect(js).toContain('"style"');
  });

  it('skips noscript tags', () => {
    expect(js).toContain('"noscript"');
  });

  it('skips template tags', () => {
    expect(js).toContain('"template"');
  });

  it('checks aria-hidden', () => {
    expect(js).toContain('aria-hidden');
  });

  it('checks display:none', () => {
    expect(js).toContain('cs.display === "none"');
  });

  it('handles display:contents transparently', () => {
    expect(js).toContain('cs.display === "contents"');
    expect(js).toContain('displayContents');
  });

  it('handles visibility:hidden (skip self, walk children)', () => {
    expect(js).toContain('cs.visibility === "hidden"');
    expect(js).toContain('visHidden');
  });

  it('respects maxDepth', () => {
    expect(js).toContain('depth > __spMaxDepth');
  });
});

// ── Shadow DOM ───────────────────────────────────────────────────────────────

describe('generateSnapshotJs — shadow DOM', () => {
  const js = generateSnapshotJs();

  it('walks into open shadow roots', () => {
    expect(js).toContain('el.shadowRoot');
  });

  it('uses shadow root as child root when present', () => {
    expect(js).toContain('el.shadowRoot ? el.shadowRoot : el');
  });
});

// ── Generic wrapper pruning ──────────────────────────────────────────────────

describe('generateSnapshotJs — wrapper pruning', () => {
  const js = generateSnapshotJs();

  it('removes generic wrappers with single ref child', () => {
    // Key optimization: generic node with no name wrapping a single child
    // that has a ref gets replaced by that child
    expect(js).toContain('role === "generic" && !name && !interactable && children.length === 1 && children[0].ref');
  });

  it('hoists children from role-less, content-less nodes', () => {
    expect(js).toContain('!hasRole && !hasContent && !interactable');
  });
});

// ── YAML output format ──────────────────────────────────────────────────────

describe('generateSnapshotJs — YAML format', () => {
  const js = generateSnapshotJs({ format: 'yaml' });

  it('uses 2-space indentation', () => {
    // The indent builder adds 2 spaces per depth level
    expect(js).toContain('indent += "  "');
  });

  it('prefixes lines with "- " plus role', () => {
    expect(js).toContain('indent + "- " + node.role');
  });

  it('renders level as [level=N]', () => {
    expect(js).toContain('[level=');
  });

  it('renders boolean states as [stateName]', () => {
    // When state value is "true", render as [checked] not [checked=true]
    expect(js).toContain('line += " [" + sk2 + "]"');
  });

  it('renders ref as [ref=eN]', () => {
    expect(js).toContain('[ref=');
  });

  it('renders link URL as /url: "path"', () => {
    expect(js).toContain('/url: ');
    expect(js).toContain('new URL(');
    expect(js).toContain('.pathname');
  });

  it('inlines direct text for leaf nodes', () => {
    expect(js).toContain('children.length === 0 && node.directText');
  });
});

// ── JSON format ──────────────────────────────────────────────────────────────

describe('generateSnapshotJs — JSON format', () => {
  const js = generateSnapshotJs({ format: 'json' });

  it('switches serializer based on format option', () => {
    expect(js).toContain('__spFormat === "json"');
    expect(js).toContain('__spSerializeJson');
  });
});

// ── Error handling ───────────────────────────────────────────────────────────

describe('generateSnapshotJs — error handling', () => {
  it('throws ELEMENT_NOT_FOUND when scope selector matches nothing', () => {
    const js = generateSnapshotJs({ scopeSelector: '#nonexistent' });
    expect(js).toContain('ELEMENT_NOT_FOUND');
    expect(js).toContain('Scope element not found');
  });
});

// ── Scope selector ───────────────────────────────────────────────────────────

describe('generateSnapshotJs — scoping', () => {
  it('scopes to document.body when no selector given', () => {
    const js = generateSnapshotJs();
    expect(js).toContain("__spScopeSelector ? document.querySelector(__spScopeSelector) : document.body");
  });

  it('uses querySelector when selector provided', () => {
    const js = generateSnapshotJs({ scopeSelector: '.main-content' });
    expect(js).toContain('document.querySelector(__spScopeSelector)');
    expect(js).toContain('.main-content');
  });
});

// ── Counting ─────────────────────────────────────────────────────────────────

describe('generateSnapshotJs — element counting', () => {
  const js = generateSnapshotJs();

  it('counts total elements', () => {
    expect(js).toContain('__spElementCount++');
  });

  it('counts interactive elements', () => {
    expect(js).toContain('if (node.interactable) __spInteractiveCount++');
  });

  it('recurses through children for counting', () => {
    // The count function walks the tree
    expect(js).toContain('function __spCount(node)');
  });
});

// ── Integration: resolveRefJs + buildRefSelector consistency ─────────────────

describe('resolveRefJs + buildRefSelector consistency', () => {
  it('resolveRefJs produces a querySelector using the same selector as buildRefSelector', () => {
    const ref = 'e5';
    const selector = buildRefSelector(ref);
    const jsQuery = resolveRefJs(ref);
    // The JS should contain the same selector string
    expect(jsQuery).toContain(selector);
  });

  it('both use data-sp-ref attribute', () => {
    const selector = buildRefSelector('e1');
    const js = resolveRefJs('e1');
    expect(selector).toContain('data-sp-ref');
    expect(js).toContain('data-sp-ref');
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('generateSnapshotJs — edge cases', () => {
  it('handles maxDepth of 0', () => {
    const js = generateSnapshotJs({ maxDepth: 0 });
    expect(js).toContain('__spMaxDepth = 0');
  });

  it('handles maxDepth of 1', () => {
    const js = generateSnapshotJs({ maxDepth: 1 });
    expect(js).toContain('__spMaxDepth = 1');
  });

  it('handles very large maxDepth', () => {
    const js = generateSnapshotJs({ maxDepth: 100 });
    expect(js).toContain('__spMaxDepth = 100');
  });

  it('handles empty scope selector as no-scope', () => {
    const js = generateSnapshotJs({ scopeSelector: '' });
    expect(js).toContain("__spScopeSelector = ''");
  });

  it('produces syntactically valid JavaScript', () => {
    // If the generated JS has mismatched braces/parens, this will throw
    const js = generateSnapshotJs();
    expect(() => new Function(js)).not.toThrow();
  });

  it('produces syntactically valid JS with all option combinations', () => {
    const combinations: SnapshotOptions[] = [
      {},
      { format: 'yaml' },
      { format: 'json' },
      { maxDepth: 3, includeHidden: true },
      { scopeSelector: '#app', format: 'json', maxDepth: 20 },
      { scopeSelector: '.class-name > div', includeHidden: false },
    ];
    for (const opts of combinations) {
      expect(() => new Function(generateSnapshotJs(opts))).not.toThrow();
    }
  });

  it('handles scope selector with special CSS characters', () => {
    const selectors = [
      'div.foo > span',
      'input[type="text"]',
      '#my-id',
      'ul > li:nth-child(2)',
    ];
    for (const sel of selectors) {
      expect(() => generateSnapshotJs({ scopeSelector: sel })).not.toThrow();
      // Verify the output is still valid JS
      expect(() => new Function(generateSnapshotJs({ scopeSelector: sel }))).not.toThrow();
    }
  });
});

// ── Completeness check ──────────────────────────────────────────────────────

describe('generateSnapshotJs — result shape', () => {
  const js = generateSnapshotJs();

  it('returns object with all required fields', () => {
    // The return statement should include all fields from SnapshotResult
    expect(js).toContain('snapshot: __spSnapshot');
    expect(js).toContain('url: window.location.href');
    expect(js).toContain('title: document.title');
    expect(js).toContain('elementCount: __spElementCount');
    expect(js).toContain('interactiveCount: __spInteractiveCount');
    expect(js).toContain('refMap: __spRefMap');
  });

  it('returns snapshot as YAML string by default', () => {
    expect(js).toContain("__spFormat = 'yaml'");
    expect(js).toContain('__spSerializeYaml');
  });

  it('returns snapshot as JSON string when format is json', () => {
    const jsonJs = generateSnapshotJs({ format: 'json' });
    expect(jsonJs).toContain("__spFormat = 'json'");
    expect(jsonJs).toContain('JSON.stringify(__spSerializeJson');
  });
});

// ── computedRole usage ──────────────────────────────────────────────────────

describe('generateSnapshotJs — computedRole', () => {
  const js = generateSnapshotJs();

  it('tries native computedRole first (Safari 16.4+)', () => {
    expect(js).toContain('el.computedRole');
  });

  it('falls back to implicit role map when computedRole is empty or generic', () => {
    // Should check computedRole !== "" and !== "generic"
    expect(js).toContain('el.computedRole !== ""');
    expect(js).toContain('el.computedRole !== "generic"');
  });
});
