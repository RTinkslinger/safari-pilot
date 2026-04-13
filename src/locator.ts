// ─── Locator Resolution ──────────────────────────────────────────────────────
//
// Generates self-contained JavaScript IIFEs that resolve Playwright-style
// locator descriptors (getByRole, getByText, getByLabel, getByTestId,
// getByPlaceholder) to actual DOM elements inside a Safari tab.
//
// Each generated JS string is designed for `do JavaScript` via AppleScript —
// synchronous, no external dependencies, uses `var` for Safari compat.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LocatorDescriptor {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  testId?: string;
  placeholder?: string;
  exact?: boolean; // default false (substring, case-insensitive)
}

export interface LocatorOptions {
  /** Narrow search to descendants of this CSS selector. */
  scopeSelector?: string;
}

export interface LocatorResult {
  found: boolean;
  selector?: string;
  element?: { tagName: string; id: string; textContent: string };
  matchCount?: number;
  locator?: LocatorDescriptor;
  candidateCount?: number;
  hint?: string;
}

// ─── Role → CSS Pre-Filter Map ───────────────────────────────────────────────
//
// Maps ARIA roles to CSS selectors that catch both explicit [role] attributes
// and HTML elements with matching implicit roles. Used as a pre-filter before
// the more expensive computed-role + accessible-name checks.

export const ROLE_SELECTORS: Record<string, string> = {
  button:
    '[role="button"],button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]',
  link: '[role="link"],a[href],area[href]',
  textbox:
    '[role="textbox"],input:not([type]),input[type="text"],input[type="email"],input[type="tel"],input[type="url"],textarea',
  searchbox: '[role="searchbox"],input[type="search"]',
  checkbox: '[role="checkbox"],input[type="checkbox"]',
  radio: '[role="radio"],input[type="radio"]',
  combobox:
    '[role="combobox"],select:not([multiple]):not([size]),input[list]',
  listbox: '[role="listbox"],select[multiple],datalist',
  slider: '[role="slider"],input[type="range"]',
  spinbutton: '[role="spinbutton"],input[type="number"]',
  heading: '[role="heading"],h1,h2,h3,h4,h5,h6',
  list: '[role="list"],ul,ol,menu',
  listitem: '[role="listitem"],li',
  navigation: '[role="navigation"],nav',
  main: '[role="main"],main',
  complementary: '[role="complementary"],aside',
  region:
    '[role="region"],section[aria-label],section[aria-labelledby]',
  form: '[role="form"],form[aria-label],form[aria-labelledby]',
  table: '[role="table"],table',
  row: '[role="row"],tr',
  cell: '[role="cell"],td',
  columnheader: '[role="columnheader"],th',
  img: '[role="img"],img[alt]:not([alt=""])',
  dialog: '[role="dialog"],dialog',
  tab: '[role="tab"]',
  tabpanel: '[role="tabpanel"]',
  menuitem: '[role="menuitem"]',
  option: '[role="option"],option',
  progressbar: '[role="progressbar"],progress',
  separator: '[role="separator"],hr',
  switch: '[role="switch"]',
  alert: '[role="alert"]',
  status: '[role="status"],output',
  article: '[role="article"],article',
  group: '[role="group"],fieldset,details,optgroup',
};

// ─── Locator Param Utilities ─────────────────────────────────────────────────

const LOCATOR_KEYS: ReadonlyArray<keyof LocatorDescriptor> = [
  'role',
  'text',
  'label',
  'testId',
  'placeholder',
];

/**
 * Returns true if the params object contains any locator-relevant key.
 */
export function hasLocatorParams(params: Record<string, unknown>): boolean {
  return LOCATOR_KEYS.some((k) => params[k] !== undefined && params[k] !== null);
}

/**
 * Extract a LocatorDescriptor from tool params. Returns null if no locator
 * keys are present.
 */
export function extractLocatorFromParams(
  params: Record<string, unknown>,
): LocatorDescriptor | null {
  if (!hasLocatorParams(params)) return null;

  const desc: LocatorDescriptor = {};
  if (typeof params.role === 'string') desc.role = params.role;
  if (typeof params.name === 'string') desc.name = params.name;
  if (typeof params.text === 'string') desc.text = params.text;
  if (typeof params.label === 'string') desc.label = params.label;
  if (typeof params.testId === 'string') desc.testId = params.testId;
  if (typeof params.placeholder === 'string') desc.placeholder = params.placeholder;
  if (typeof params.exact === 'boolean') desc.exact = params.exact;
  return desc;
}

// ─── JS Escaping ─────────────────────────────────────────────────────────────

/**
 * Escape a string for safe embedding inside a JS string literal (single-quoted).
 * Handles the shell → AppleScript → JavaScript round-trip.
 */
function escapeForJs(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// ─── JS Code Generators (per locator type) ───────────────────────────────────
//
// Each returns the body of the resolution logic as a JS string. The caller
// wraps it in the common IIFE + scoping + stamping + result envelope.

function buildRoleResolutionJs(
  role: string,
  name: string | undefined,
  exact: boolean,
): string {
  const preFilter = ROLE_SELECTORS[role];
  // If we don't have a pre-filter for this role, fall back to [role="<role>"]
  const selectorStr = preFilter
    ? escapeForJs(preFilter)
    : '[role="' + escapeForJs(role) + '"]';

  const nameMatch = name !== undefined ? buildNameMatchJs(name, exact) : '';

  return `
    var candidates = Array.prototype.slice.call(root.querySelectorAll('${selectorStr}'));

    // Post-filter: verify computed role matches (handles implicit roles the CSS missed,
    // and filters out elements where CSS matched but actual role differs)
    var roleTarget = '${escapeForJs(role)}';
    candidates = candidates.filter(function(el) {
      // Explicit role attribute takes priority
      var explicit = el.getAttribute('role');
      if (explicit) return explicit.toLowerCase() === roleTarget;
      // Implicit role matched via CSS pre-filter — keep it
      return true;
    });

    ${nameMatch ? `
    // Filter by accessible name
    var nameQuery = '${escapeForJs(name!)}';
    var exact = ${exact};
    var nameMatched = [];
    var allNames = [];

    for (var i = 0; i < candidates.length; i++) {
      var accName = getAccessibleName(candidates[i]);
      allNames.push(accName);
      if (matchText(accName, nameQuery, exact)) {
        nameMatched.push(candidates[i]);
      }
    }

    if (nameMatched.length === 0) {
      return JSON.stringify({
        found: false,
        locator: locatorDesc,
        candidateCount: candidates.length,
        hint: 'Found ' + candidates.length + ' ' + roleTarget + (candidates.length === 1 ? '' : 's') +
              ' but none matched name ' + JSON.stringify(nameQuery) +
              '. Names found: ' + JSON.stringify(allNames.slice(0, 10))
      });
    }
    candidates = nameMatched;
    ` : ''}

    matched = candidates;
  `;
}

function buildTextResolutionJs(text: string, exact: boolean): string {
  return `
    var textQuery = '${escapeForJs(text)}';
    var exact = ${exact};
    var allEls = Array.prototype.slice.call(root.querySelectorAll('*'));
    var skipTags = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (skipTags[el.tagName]) continue;

      // Use innerText (layout-aware) with textContent fallback
      var elText = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
      elText = normalizeWhitespace(elText);

      if (matchText(elText, textQuery, exact)) {
        matched.push(el);
      }
    }

    // Prefer the most specific (deepest) match — filter out ancestors of matched elements
    if (matched.length > 1) {
      var filtered = matched.filter(function(el) {
        for (var j = 0; j < matched.length; j++) {
          if (matched[j] !== el && el.contains(matched[j])) return false;
        }
        return true;
      });
      if (filtered.length > 0) matched = filtered;
    }
  `;
}

function buildLabelResolutionJs(label: string, exact: boolean): string {
  return `
    var labelQuery = '${escapeForJs(label)}';
    var exact = ${exact};
    var labelable = Array.prototype.slice.call(
      root.querySelectorAll('input,select,textarea,button,meter,output,progress')
    );

    for (var i = 0; i < labelable.length; i++) {
      var el = labelable[i];
      var labelText = '';

      // 1. aria-labelledby references
      var labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        var ids = labelledBy.split(/\\s+/);
        var parts = [];
        for (var j = 0; j < ids.length; j++) {
          var ref = document.getElementById(ids[j]);
          if (ref) parts.push(normalizeWhitespace((ref.innerText || ref.textContent || '')));
        }
        if (parts.length > 0) labelText = parts.join(' ');
      }

      // 2. Associated <label> elements (via element.labels or for= attribute)
      if (!labelText && el.labels && el.labels.length > 0) {
        var lblParts = [];
        for (var k = 0; k < el.labels.length; k++) {
          lblParts.push(normalizeWhitespace(el.labels[k].innerText || el.labels[k].textContent || ''));
        }
        labelText = lblParts.join(' ');
      }

      // 3. aria-label attribute
      if (!labelText) {
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) labelText = normalizeWhitespace(ariaLabel);
      }

      if (labelText && matchText(labelText, labelQuery, exact)) {
        matched.push(el);
      }
    }
  `;
}

function buildTestIdResolutionJs(testId: string): string {
  // TestId is always exact match, case-sensitive
  return `
    var el = root.querySelector('[data-testid="${escapeForJs(testId)}"]');
    if (el) matched.push(el);
  `;
}

function buildPlaceholderResolutionJs(
  placeholder: string,
  exact: boolean,
): string {
  if (exact) {
    // Exact match — use attribute selector directly
    return `
      var el = root.querySelector('[placeholder="${escapeForJs(placeholder)}"]');
      if (el) matched.push(el);
    `;
  }

  // Substring, case-insensitive match — must iterate
  return `
    var phQuery = '${escapeForJs(placeholder)}';
    var phEls = Array.prototype.slice.call(root.querySelectorAll('[placeholder]'));
    for (var i = 0; i < phEls.length; i++) {
      var phVal = phEls[i].getAttribute('placeholder') || '';
      if (matchText(phVal, phQuery, false)) {
        matched.push(phEls[i]);
      }
    }
  `;
}

// ─── Name Match Helper JS ────────────────────────────────────────────────────

function buildNameMatchJs(name: string, exact: boolean): string {
  // Just a marker — actual match logic is inline in buildRoleResolutionJs
  return 'HAS_NAME_FILTER';
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Generate a self-contained JavaScript IIFE that resolves a locator descriptor
 * to a DOM element. The JS stamps the matched element with a `data-sp-ref`
 * attribute and returns a JSON result envelope.
 *
 * Designed for injection via `do JavaScript` in Safari (AppleScript engine).
 */
export function generateLocatorJs(
  locator: LocatorDescriptor,
  options?: LocatorOptions,
): string {
  const exact = locator.exact ?? false;

  // Determine which resolution strategy to use — priority order matches spec:
  // testId > role+name > label > placeholder > text
  let resolutionBody: string;
  let locatorType: string;

  if (locator.testId !== undefined) {
    resolutionBody = buildTestIdResolutionJs(locator.testId);
    locatorType = 'testId';
  } else if (locator.role !== undefined) {
    resolutionBody = buildRoleResolutionJs(locator.role, locator.name, exact);
    locatorType = locator.name !== undefined ? 'role+name' : 'role';
  } else if (locator.label !== undefined) {
    resolutionBody = buildLabelResolutionJs(locator.label, exact);
    locatorType = 'label';
  } else if (locator.placeholder !== undefined) {
    resolutionBody = buildPlaceholderResolutionJs(locator.placeholder, exact);
    locatorType = 'placeholder';
  } else if (locator.text !== undefined) {
    resolutionBody = buildTextResolutionJs(locator.text, exact);
    locatorType = 'text';
  } else {
    // No locator key — return immediate failure
    return `return JSON.stringify({ found: false, locator: {}, candidateCount: 0, hint: 'No locator key provided (need role, text, label, testId, or placeholder)' });`;
  }

  // Build the locator descriptor JSON for error messages
  const locatorJson = escapeForJs(JSON.stringify(locator));

  // Build scope selector
  const scopeJs = options?.scopeSelector
    ? `var root = document.querySelector('${escapeForJs(options.scopeSelector)}'); if (!root) { return JSON.stringify({ found: false, locator: locatorDesc, candidateCount: 0, hint: 'Scope selector ${escapeForJs(options.scopeSelector)} not found on page' }); }`
    : 'var root = document;';

  return `var locatorDesc = JSON.parse('${locatorJson}');

  // ── Scope ──
  ${scopeJs}

  // ── Helpers ──
  function normalizeWhitespace(s) {
    return (s || '').replace(/^\\s+|\\s+$/g, '').replace(/\\s+/g, ' ');
  }

  function matchText(haystack, needle, isExact) {
    if (isExact) return haystack === needle;
    return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  }

  function getAccessibleName(el) {
    // 1. element.computedName (Safari 16.4+, first-class a11y API)
    if (typeof el.computedName === 'string') return el.computedName;

    // 2. aria-label
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    // 3. aria-labelledby
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ids = labelledBy.split(/\\s+/);
      var parts = [];
      for (var j = 0; j < ids.length; j++) {
        var ref = document.getElementById(ids[j]);
        if (ref) parts.push(normalizeWhitespace(ref.innerText || ref.textContent || ''));
      }
      if (parts.length > 0) return parts.join(' ');
    }

    // 4. alt (for img, input[type=image])
    var alt = el.getAttribute('alt');
    if (alt) return alt;

    // 5. title
    var title = el.getAttribute('title');
    if (title) return title;

    // 6. Associated <label> elements
    if (el.labels && el.labels.length > 0) {
      var lblParts = [];
      for (var k = 0; k < el.labels.length; k++) {
        lblParts.push(normalizeWhitespace(el.labels[k].innerText || el.labels[k].textContent || ''));
      }
      return lblParts.join(' ');
    }

    // 7. textContent (last resort)
    return normalizeWhitespace(el.textContent || '');
  }

  // ── Resolution ──
  var matched = [];

  ${resolutionBody}

  // ── Result ──
  if (matched.length === 0) {
    return JSON.stringify({
      found: false,
      locator: locatorDesc,
      candidateCount: 0,
      hint: 'No elements matched ${locatorType} locator'
    });
  }

  // Stamp the first match with a data-sp-ref for subsequent tool calls
  var target = matched[0];
  var refId = 'sp-' + Math.random().toString(36).substring(2, 8);
  target.setAttribute('data-sp-ref', refId);

  return JSON.stringify({
    found: true,
    selector: '[data-sp-ref="' + refId + '"]',
    element: {
      tagName: target.tagName || '',
      id: target.id || '',
      textContent: normalizeWhitespace((target.textContent || '').substring(0, 200))
    },
    matchCount: matched.length
  });`;
}
