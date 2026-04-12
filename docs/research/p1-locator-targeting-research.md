# P1 Research: Locator-Style Element Targeting for Safari Pilot

> Research date: 2026-04-12
> Sources: Playwright source code, Testing Library source code, aria-query, dom-accessibility-api, W3C HTML-ARIA spec, HTML-AAM spec, MDN
> Purpose: Inform implementation of resilient element targeting (getByRole, getByText, getByLabel, getByTestId, getByPlaceholder) in Safari Pilot

---

## Table of Contents

1. [Playwright Locator Internals](#1-playwright-locator-internals)
2. [ARIA Role-to-Element Mapping](#2-aria-role-to-element-mapping)
3. [Text Matching Strategies](#3-text-matching-strategies)
4. [CSS Selector Alternatives for Safari](#4-css-selector-alternatives-for-safari)
5. [Locator + Auto-Wait Integration](#5-locator--auto-wait-integration)
6. [Performance Considerations](#6-performance-considerations)
7. [Implementation Recommendations for Safari Pilot](#7-implementation-recommendations-for-safari-pilot)

---

## 1. Playwright Locator Internals

### 1.1 Core Architecture: Locators Are Lazy Descriptors

Playwright locators are **not** element references. They are descriptors that re-resolve to DOM elements at action time. From the Playwright docs:

> "Every time a locator is used for an action, an up-to-date DOM element is located in the page."

This means:

```javascript
const locator = page.getByRole('button', { name: 'Sign in' });
await locator.hover();  // resolves to DOM element #1
await locator.click();  // resolves to DOM element #2 (may be different if DOM changed)
```

Locators are constructed by chaining selector fragments. Internally, Playwright converts locator API calls into an internal selector syntax:

| Locator API | Internal Selector |
|---|---|
| `getByRole('button', {name: 'Submit'})` | `internal:role=button[name="Submit"s]` |
| `getByText('Sign in')` | `internal:text="Sign in"s` |
| `getByLabel('Email')` | `internal:label="Email"s` |
| `getByTestId('submit-btn')` | `internal:testid=[data-testid="submit-btn"s]` |
| `getByPlaceholder('Enter email')` | `internal:attr=[placeholder="Enter email"s]` |

The `s` suffix indicates strict string matching (exact). Without it, substring matching is used.

### 1.2 How getByRole Resolves

Source: Playwright `frames.ts`, Testing Library `queries/role.ts`

**Resolution algorithm (verified from source):**

1. **Build a CSS pre-filter selector.** Testing Library's `makeRoleSelector()` combines:
   - `*[role~="button"]` (explicit role attribute)
   - Implicit role selectors from `aria-query`'s `roleElements` map (e.g., `button`, `input[type="button"]`, `input[type="submit"]`, `input[type="reset"]`, `input[type="image"]`)
   - These are joined with commas into a single `querySelectorAll()` call

2. **Filter by role match.** For each candidate element:
   - If element has explicit `role` attribute: check if the first space-separated token matches (or any token if `queryFallbacks: true`)
   - If no explicit role: compute implicit ARIA roles using `getImplicitAriaRoles()` and check for match

3. **Filter by ARIA state/property options** (checked, pressed, expanded, selected, disabled, level, value, etc.)

4. **Filter by accessible name.** If `name` option provided:
   - Compute the element's accessible name using the `dom-accessibility-api` library's `computeAccessibleName()` (implements W3C Accessible Name and Description Computation spec)
   - Match against the `name` option (string = exact match, regex = regex match, function = custom matcher)

5. **Filter by accessible description** (if `description` option provided)

6. **Filter out inaccessible elements** (unless `hidden: true`):
   - `display: none` = inaccessible
   - `visibility: hidden` = inaccessible
   - `aria-hidden="true"` = inaccessible (includes ancestors)
   - `hidden` attribute = inaccessible

### 1.3 How getByText Resolves

Source: Testing Library `queries/text.ts`, `matches.ts`, `get-node-text.ts`

**Algorithm:**

1. Query `container.querySelectorAll('*')` (or custom selector)
2. Filter out elements matching `ignore` pattern (default: `'script, style'` via config)
3. For each element, extract text via `getNodeText()`:
   - For `input[type=submit]`, `input[type=button]`, `input[type=reset]`: use `.value`
   - For all others: concatenate `textContent` of direct TEXT_NODE children only (not descendant elements)
4. Match extracted text against the matcher:
   - **`exact: true` (default)**: exact string equality after normalization
   - **`exact: false`**: case-insensitive substring match (`normalizedText.toLowerCase().includes(matcher.toLowerCase())`)
   - **RegExp**: `matcher.test(normalizedText)`
   - **Function**: `matcher(normalizedText, element)`

**Key insight for Safari Pilot:** `getNodeText()` only reads direct text node children, NOT `innerText` or recursive `textContent`. This means `<button><span>Sign</span> <span>in</span></button>` would return empty string for the button element itself. Playwright handles this differently -- it uses `elementText()` which does recursively collect text.

### 1.4 How getByLabel Resolves

Source: Testing Library `queries/label-text.ts`, `label-helpers.ts`

**Algorithm (four label association strategies):**

1. **`aria-labelledby` resolution**: If element has `aria-labelledby`, split the space-separated IDs, find each referenced element by ID, extract its text content

2. **HTML `<label>` element resolution** (via `getRealLabels()`):
   - Use `element.labels` property (native browser API) if available
   - Fallback: query all `<label>` elements and check if `label.control === element`
   - Extract label text via `getLabelContent()` (excludes text from nested labelable elements like buttons, inputs, etc.)

3. **Wrapping label detection**: The `label.control` property handles both:
   - `<label for="email"><input id="email"></label>` (for/id association)
   - `<label>Email <input type="text"></label>` (wrapping association)

4. **`aria-label` fallback**: `queryAllByAttribute('aria-label', container, text, ...)`

**Priority order**: aria-labelledby > HTML label associations > aria-label

### 1.5 How getByTestId and getByPlaceholder Resolve

These are straightforward attribute selectors:

- **getByTestId**: `querySelectorAll('[data-testid="value"]')` (attribute name is configurable)
- **getByPlaceholder**: `querySelectorAll('[placeholder="value"]')`

Both use the same text matching infrastructure (exact/fuzzy/regex).

### 1.6 Multiple Match Handling

**Playwright (strict mode, verified from `frames.ts` source):**

```javascript
// From frames.ts _retryWithProgressIfNotConnected:
if (elements.length > 1) {
  if (info.strict)
    throw injected.strictModeViolationError(info.parsed, elements);
  log = `  locator resolved to ${elements.length} elements. Proceeding with the first one`;
}
```

- **All action methods are strict by default** -- they throw if the locator matches more than one element
- Exception: multi-element operations like `.count()`, `.all()`, `.evaluateAll()`
- To explicitly select: `.first()`, `.last()`, `.nth(index)`

**Testing Library:**
- `getByRole()` throws "Found multiple elements" error
- `queryAllByRole()` returns all matches as an array
- `getAllByRole()` returns all matches or throws if none found

### 1.7 Locator Chaining

Locators can be chained to narrow scope:

```javascript
// Chaining narrows the search to descendants
page.getByRole('dialog').getByRole('button', { name: 'Submit' })

// Filter narrows by additional constraints
page.getByRole('listitem').filter({ hasText: 'Product 2' })

// Intersection of two locators
page.getByRole('button').and(page.getByTitle('Subscribe'))

// Union of two locators
page.getByRole('button', { name: 'New' }).or(page.getByText('Confirm'))
```

Internally, chaining appends selector fragments separated by `>>`:
```
internal:role=dialog >> internal:role=button[name="Submit"s]
```

Each `>>` means "find within the results of the previous selector."

---

## 2. ARIA Role-to-Element Mapping

### 2.1 Complete Implicit Role Mapping

Source: W3C HTML-ARIA spec (REC-2026-04-07), HTML-AAM spec, aria-query library

| HTML Element | Conditions | Implicit ARIA Role |
|---|---|---|
| `<a href="...">` | has href | `link` |
| `<a>` | no href | `generic` |
| `<area href="...">` | has href | `link` |
| `<article>` | | `article` |
| `<aside>` | | `complementary` |
| `<b>` | | `generic` |
| `<bdi>` | | `generic` |
| `<bdo>` | | `generic` |
| `<blockquote>` | | `blockquote` |
| `<body>` | | `generic` |
| `<button>` | | `button` |
| `<caption>` | | `caption` |
| `<code>` | | `code` |
| `<data>` | | `generic` |
| `<datalist>` | | `listbox` |
| `<dd>` | | (no role) |
| `<del>` | | `deletion` |
| `<details>` | | `group` |
| `<dfn>` | | `term` |
| `<dialog>` | | `dialog` |
| `<div>` | | `generic` |
| `<dt>` | | (no role) |
| `<em>` | | `emphasis` |
| `<fieldset>` | | `group` |
| `<figure>` | | `figure` |
| `<footer>` | scoped to body | `contentinfo` |
| `<footer>` | scoped to article/aside/main/nav/section | `generic` |
| `<form>` | has accessible name | `form` |
| `<form>` | no accessible name | `form` (but not a landmark) |
| `<h1>`-`<h6>` | | `heading` (with aria-level) |
| `<header>` | scoped to body | `banner` |
| `<header>` | scoped to article/aside/main/nav/section | `generic` |
| `<hr>` | | `separator` |
| `<i>` | | `generic` |
| `<img alt="...">` | non-empty alt | `img` |
| `<img alt="">` | empty alt | `presentation` / `none` |
| `<img>` | no alt attribute | `img` |
| `<input type="button">` | | `button` |
| `<input type="checkbox">` | | `checkbox` |
| `<input type="email">` | no list attr | `textbox` |
| `<input type="image">` | | `button` |
| `<input type="number">` | | `spinbutton` |
| `<input type="radio">` | | `radio` |
| `<input type="range">` | | `slider` |
| `<input type="reset">` | | `button` |
| `<input type="search">` | no list attr | `searchbox` |
| `<input type="submit">` | | `button` |
| `<input type="tel">` | no list attr | `textbox` |
| `<input type="text">` | no list attr | `textbox` |
| `<input type="url">` | no list attr | `textbox` |
| `<input>` with `list` attr | any text-like type | `combobox` |
| `<ins>` | | `insertion` |
| `<li>` | child of ul/ol/menu | `listitem` |
| `<main>` | | `main` |
| `<mark>` | | `mark` |
| `<math>` | | `math` |
| `<menu>` | | `list` |
| `<meter>` | | `meter` |
| `<nav>` | | `navigation` |
| `<ol>` | | `list` |
| `<optgroup>` | | `group` |
| `<option>` | | `option` |
| `<output>` | | `status` |
| `<p>` | | `paragraph` |
| `<pre>` | | `generic` |
| `<progress>` | | `progressbar` |
| `<search>` | | `search` |
| `<section>` | has accessible name | `region` |
| `<section>` | no accessible name | `generic` (not a landmark) |
| `<select>` | no multiple, size <= 1 | `combobox` |
| `<select multiple>` | or size > 1 | `listbox` |
| `<span>` | | `generic` |
| `<strong>` | | `strong` |
| `<sub>` | | `subscript` |
| `<summary>` | | (no standard role) |
| `<sup>` | | `superscript` |
| `<table>` | | `table` |
| `<tbody>` | | `rowgroup` |
| `<td>` | | `cell` (in table context) |
| `<textarea>` | | `textbox` |
| `<tfoot>` | | `rowgroup` |
| `<th>` | column context | `columnheader` |
| `<th>` | row context | `rowheader` |
| `<thead>` | | `rowgroup` |
| `<time>` | | `time` |
| `<tr>` | | `row` |
| `<ul>` | | `list` |

### 2.2 Explicit Role Override Behavior

When an element has an explicit `role` attribute, it **overrides** the implicit role:

```html
<button role="link">Click me</button>
<!-- Exposed as role=link, NOT role=button -->
```

The W3C HTML-ARIA spec constrains which roles can be used on which elements. For example, `<button>` allows: `checkbox`, `combobox`, `link`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `radio`, `separator`, `slider`, `switch`, `tab`, `treeitem`.

**For Safari Pilot's resolver**: Always check `element.getAttribute('role')` first. If present, use the first space-separated token. Only compute implicit role if no explicit role is set.

### 2.3 Landmark Roles

| Landmark Role | HTML Element | Conditions |
|---|---|---|
| `banner` | `<header>` | Direct child of `<body>` (not nested in article/aside/main/nav/section) |
| `complementary` | `<aside>` | Always |
| `contentinfo` | `<footer>` | Direct child of `<body>` (not nested in article/aside/main/nav/section) |
| `form` | `<form>` | Only when it has an accessible name |
| `main` | `<main>` | Always |
| `navigation` | `<nav>` | Always |
| `region` | `<section>` | Only when it has an accessible name |
| `search` | `<search>` | Always |

### 2.4 Abstract Roles (NOT Queryable)

These exist only in the ARIA ontology for inheritance purposes. Authors must never use them, and locators should never match them:

`command`, `composite`, `input`, `landmark`, `range`, `roletype`, `section`, `sectionhead`, `select`, `structure`, `widget`, `window`

---

## 3. Text Matching Strategies

### 3.1 Default Matching Behavior

| Library / Method | Default Mode | Details |
|---|---|---|
| **Playwright** getByText | Substring, case-insensitive | Matches if the normalized text of the element contains the query string |
| **Playwright** getByRole `name` | Substring, case-insensitive | Matches against accessible name; use `exact: true` for full string match |
| **Playwright** getByLabel | Substring, case-insensitive | Same as getByText |
| **Playwright** getByPlaceholder | Substring, case-insensitive | Same as getByText |
| **Playwright** getByTestId | Exact, case-sensitive | No `exact` option; always exact |
| **Testing Library** getByText | Exact match (`exact: true`) | String equality after normalization; set `exact: false` for substring |
| **Testing Library** getByRole `name` | Exact match | Uses `matches()` not `fuzzyMatches()` |

**Critical difference**: Playwright defaults to substring/case-insensitive matching for all locator `name`/`text` options (except getByTestId), while Testing Library defaults to exact matching. Playwright's choice reduces false negatives (agent finds elements more easily), at the cost of occasional ambiguity. For Safari Pilot (used by AI agents), **substring default is the better choice** -- it matches how an agent would describe elements.

**Playwright's getByText specifics:**
- `page.getByText('Sign in')` matches `<p>Please Sign in to continue</p>` (substring)
- `page.getByText('Sign in', { exact: true })` requires exact match
- Regex is supported: `page.getByText(/sign in/i)`

### 3.2 Whitespace Normalization

Source: Testing Library `matches.ts` `getDefaultNormalizer()`

```javascript
function getDefaultNormalizer({ trim = true, collapseWhitespace = true } = {}) {
  return text => {
    let normalizedText = text;
    normalizedText = trim ? normalizedText.trim() : normalizedText;
    normalizedText = collapseWhitespace
      ? normalizedText.replace(/\s+/g, ' ')
      : normalizedText;
    return normalizedText;
  };
}
```

Both Playwright and Testing Library normalize whitespace before matching:
- Leading/trailing whitespace: trimmed
- Internal whitespace sequences: collapsed to single space
- This handles `\n`, `\t`, multiple spaces

### 3.3 Hidden Text Handling

**Elements with `display: none`**: Not visible, text NOT included in accessible name computation by default
**Elements with `visibility: hidden`**: Not visible, text NOT included by default
**Elements with `aria-hidden="true"`**: Text excluded from accessible name computation (per spec step 2A)
**Elements with `opacity: 0`**: Playwright considers these VISIBLE (have non-empty bounding box)

Source: `dom-accessibility-api` `accessible-name-and-description.ts`:
```javascript
// Step 2A: Skip hidden elements unless referenced
if (!hidden && isHidden(current, getComputedStyle) && !context.isReferenced) {
  consultedNodes.add(current);
  return "" as FlatString;
}
```

### 3.4 CSS ::before/::after Content

Source: `dom-accessibility-api`:
```javascript
if (isElement(node) && computedStyleSupportsPseudoElements) {
  const pseudoBefore = uncachedGetComputedStyle(node, "::before");
  const beforeContent = getTextualContent(pseudoBefore);
  accumulatedText = `${beforeContent} ${accumulatedText}`;
}
```

Pseudo-element content IS included in accessible name computation (when `computedStyleSupportsPseudoElements` is true). However, `getNodeText()` in Testing Library does NOT include pseudo-element content for text queries.

**For Safari Pilot**: In Safari/WebKit, `getComputedStyle(element, '::before')` works correctly. We can include pseudo-element content in accessible name computation.

### 3.5 Text Inside Nested Elements

For `<button><span>Sign</span> <span>in</span></button>`:

- **`getNodeText()`** (Testing Library text query): Returns empty string for button (only direct text nodes)
- **`computeAccessibleName()`** (role query name matching): Returns "Sign in" (recursively computed)
- **`element.textContent`**: Returns "Sign in" (recursive)
- **`element.innerText`**: Returns "Sign in" (with layout-aware spacing)

**Recommendation for Safari Pilot**: Use `innerText` or recursive textContent for text matching. The Testing Library approach of only reading direct text nodes is too restrictive for real-world pages.

### 3.6 aria-label vs Visible Text Priority

Per the Accessible Name Computation (accname) spec:
1. `aria-labelledby` (highest priority)
2. `aria-label`
3. Native label mechanisms (HTML `<label>`, `alt`, `title`, etc.)
4. Text content (for elements that allow naming from content)

For `getByRole({name: ...})`, the accessible name computation is used, so `aria-label` takes priority over visible text.

For `getByText()`, only visible text content is matched (not aria-label). This is intentional -- `getByText` finds what the user can SEE.

---

## 4. CSS Selector Alternatives for Safari

### 4.1 ARIA Attribute Selectors

Safari supports standard CSS attribute selectors for ARIA attributes:

```javascript
// Elements with explicit role
document.querySelectorAll('[role="button"]')

// Elements with aria-label
document.querySelectorAll('[aria-label="Submit"]')

// Combined
document.querySelectorAll('[role="button"][aria-label="Submit"]')

// data-testid
document.querySelectorAll('[data-testid="submit-btn"]')

// Placeholder
document.querySelectorAll('[placeholder="Enter email"]')
```

**Limitation**: These only find elements with EXPLICIT attributes. They miss implicit ARIA roles (e.g., `<button>` without `role="button"`).

### 4.2 Safari XPath Support

Source: MDN `Document.evaluate()`, Baseline "Widely Available" since July 2015

Safari fully supports `document.evaluate()` for XPath queries. All result types are supported (iterator, snapshot, first-node, etc.).

```javascript
// Find all buttons
document.evaluate('//button', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

// Find elements with specific text
document.evaluate('//*[contains(text(), "Sign in")]', document, null, ...);

// Find elements by attribute
document.evaluate('//*[@role="button"][@aria-label="Submit"]', document, null, ...);
```

**Performance note from MDN**: "Generally, more specific xpath selectors give a significant performance improvement, especially on very large documents." Using a context node (e.g., `document.body`) instead of `document` helps.

**XPath advantages for locator resolution**:
- Can match text content: `contains(text(), "...")`
- Can match attributes: `@role`, `@aria-label`
- Can navigate to associated elements: `//label[@for="id"]/following::input`

**XPath disadvantages**:
- Does NOT pierce shadow DOM
- More complex to construct programmatically
- Slower than `querySelector` for simple queries

### 4.3 Testing Library's Approach (Extractable Algorithm)

Source: Testing Library `role-helpers.js`, `queries/role.ts`

The core algorithm is extractable. The key dependencies are:

1. **`aria-query`** library (~15KB): Maps between HTML elements and ARIA roles
2. **`dom-accessibility-api`** library (~10KB): Computes accessible names per W3C spec

The algorithm from Testing Library's `makeRoleSelector()`:

```javascript
function makeRoleSelector(role) {
  const explicitRoleSelector = `*[role~="${role}"]`;
  const roleRelations = roleElements.get(role) ?? new Set();
  const implicitRoleSelectors = new Set(
    Array.from(roleRelations).map(({name}) => name)
  );
  return [explicitRoleSelector]
    .concat(Array.from(implicitRoleSelectors))
    .join(',');
}
```

This builds a CSS selector like: `*[role~="button"],button,input[type="button"],input[type="image"],input[type="reset"],input[type="submit"]`

Then it runs `querySelectorAll()` with that combined selector and post-filters.

### 4.4 Minimum Viable Implementation (No External Dependencies)

For Safari Pilot, we can build a self-contained resolver in ~300 lines of JavaScript that runs in the Safari extension's content script:

```javascript
// Core: implicit role lookup table (hardcoded, no library needed)
const IMPLICIT_ROLES = {
  'button': 'button',
  'a[href]': 'link',
  'input[type="text"]': 'textbox',
  'input[type="email"]': 'textbox',
  'input[type="tel"]': 'textbox',
  'input[type="url"]': 'textbox',
  'input[type="search"]': 'searchbox',
  'input[type="checkbox"]': 'checkbox',
  'input[type="radio"]': 'radio',
  'input[type="range"]': 'slider',
  'input[type="number"]': 'spinbutton',
  'input[type="submit"]': 'button',
  'input[type="reset"]': 'button',
  'input[type="image"]': 'button',
  'input[type="button"]': 'button',
  'select:not([multiple]):not([size])': 'combobox',
  'select[multiple]': 'listbox',
  'textarea': 'textbox',
  'nav': 'navigation',
  'main': 'main',
  'aside': 'complementary',
  'article': 'article',
  'section[aria-label]': 'region',
  'section[aria-labelledby]': 'region',
  'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
  'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
  'ul': 'list', 'ol': 'list', 'menu': 'list',
  'li': 'listitem',
  'table': 'table',
  'tr': 'row',
  'td': 'cell',
  'th': 'columnheader', // simplified
  'img[alt]:not([alt=""])': 'img',
  'form[aria-label]': 'form',
  'form[aria-labelledby]': 'form',
  'dialog': 'dialog',
  'hr': 'separator',
  'progress': 'progressbar',
  'meter': 'meter',
  'output': 'status',
  'option': 'option',
  'fieldset': 'group',
  'details': 'group',
  'datalist': 'listbox',
  'search': 'search',
};

// Build reverse map: role -> CSS selectors
const ROLE_SELECTORS = {};
for (const [selector, role] of Object.entries(IMPLICIT_ROLES)) {
  if (!ROLE_SELECTORS[role]) ROLE_SELECTORS[role] = [];
  ROLE_SELECTORS[role].push(selector);
}
```

This avoids importing aria-query (~15KB) and dom-accessibility-api (~10KB) into the extension content script.

---

## 5. Locator + Auto-Wait Integration

### 5.1 Playwright's Retry Architecture

Source: Playwright `frames.ts` `_retryWithProgressIfNotConnected()`

```javascript
return this.retryWithProgressAndTimeouts(
  progress,
  [0, 20, 50, 100, 100, 500],  // backoff intervals in ms
  async (progress, continuePolling) => {
    // 1. Resolve the locator to DOM element(s)
    const resolved = await progress.race(
      this.selectors.resolveInjectedForSelector(selector, ...)
    );

    // 2. If no elements found and auto-waiting, retry
    if (!resolved) {
      if (noAutoWaiting) throw new NonRecoverableDOMError('not found');
      return continuePolling;  // retry after backoff
    }

    // 3. Check elements, handle strict mode
    const elements = injected.querySelectorAll(info.parsed, document);
    if (elements.length > 1 && info.strict)
      throw injected.strictModeViolationError(...);
    if (!element) return continuePolling;  // retry

    // 4. Execute the action
    const result = await action(progress, element);

    // 5. If element disconnected during action, retry
    if (result === 'error:notconnected') return continuePolling;

    return result;
  }
);
```

**Key design decisions:**
- Backoff schedule: `[0, 20, 50, 100, 100, 500]` ms between retries
- Default timeout: 30 seconds (configurable)
- If element is found but disconnects during action: full retry from step 1
- If zero elements found: keep polling until timeout

### 5.2 Actionability Checks

Source: Playwright docs `/docs/actionability`

Before performing an action, Playwright checks (in order):

| Check | Definition | Actions |
|---|---|---|
| **Visible** | Non-empty bounding box AND no `visibility:hidden`. Note: `opacity:0` IS visible, `display:none` is NOT | click, fill, check, hover, screenshot |
| **Stable** | Same bounding box for 2 consecutive animation frames | click, check, hover, drag |
| **Receives Events** | Element is the hit target at the action point (not obscured) | click, check, hover |
| **Enabled** | Not `disabled` attribute, not in disabled fieldset, not `aria-disabled="true"` | click, fill, check, selectOption |
| **Editable** | Enabled AND not `readonly` attribute AND not `aria-readonly="true"` | fill, clear |

**Safari Pilot implementation note**: We can implement these checks in the content script:

```javascript
function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== 'hidden';
}

function isStable(el) {
  return new Promise(resolve => {
    const rect1 = el.getBoundingClientRect();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const rect2 = el.getBoundingClientRect();
        resolve(
          rect1.x === rect2.x && rect1.y === rect2.y &&
          rect1.width === rect2.width && rect1.height === rect2.height
        );
      });
    });
  });
}

function receivesEvents(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const topEl = document.elementFromPoint(x, y);
  return el === topEl || el.contains(topEl);
}

function isEnabled(el) {
  if (el.disabled) return false;
  if (el.closest('fieldset[disabled]')) return false;
  if (el.closest('[aria-disabled="true"]')) return false;
  return true;
}
```

### 5.3 What Happens with 0 Matches

- **Auto-waiting ON (default)**: Locator polls/retries until an element appears or timeout expires
- **Auto-waiting OFF (noAutoWaiting)**: Throws `NonRecoverableDOMError('Element(s) not found')` immediately
- **Element appears then disappears then reappears**: Each retry re-resolves from scratch, so the reappeared element is found

### 5.4 Testing Library's Wait-For Mechanism

Source: Testing Library `wait-for.js`

```javascript
function waitFor(callback, {
  timeout = 1000,      // default 1 second
  interval = 50,       // poll every 50ms
  mutationObserverOptions = {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  },
}) {
  // Uses BOTH:
  // 1. setInterval(checkCallback, 50) - regular polling
  // 2. MutationObserver - reactive (triggers immediately on DOM change)
  // Whichever fires first
}
```

**Key insight**: Testing Library uses MutationObserver in ADDITION to polling. This means the callback re-runs immediately when any DOM mutation occurs, rather than waiting for the next poll interval. This is more responsive than pure polling.

**Recommendation for Safari Pilot**: Use MutationObserver + polling hybrid for auto-wait, same as Testing Library.

---

## 6. Performance Considerations

### 6.1 Cost of ARIA Role Computation

Computing the ARIA role of a single element is cheap (~1 microsecond):
- Check `element.getAttribute('role')` (fast, just attribute lookup)
- If no explicit role, match against `IMPLICIT_ROLES` table (CSS selector matching via `element.matches()`)

Computing roles for ALL elements on a page:

| Page Size | Elements | querySelectorAll('*') | Role computation | Total |
|---|---|---|---|---|
| Simple page | ~100 | < 1ms | < 1ms | < 2ms |
| Medium page | ~1,000 | ~1ms | ~2ms | ~3ms |
| Complex SPA | ~5,000 | ~3ms | ~8ms | ~11ms |
| Heavy page (Facebook) | ~20,000+ | ~10ms | ~30ms | ~40ms |

These timings are rough estimates. The accessible name computation (`computeAccessibleName()`) is significantly more expensive (~10-50x slower per element) because it must:
- Walk the DOM tree
- Compute styles (may trigger layout)
- Resolve aria-labelledby references
- Handle recursive name computation

### 6.2 Optimization: Pre-Filter with CSS Selectors

The key optimization (used by both Playwright and Testing Library) is to **pre-filter with CSS before computing roles and names**:

```javascript
// Instead of:
document.querySelectorAll('*').forEach(el => {
  if (getRole(el) === 'button' && getAccessibleName(el) === 'Submit') ...
});

// Do:
document.querySelectorAll(
  '*[role~="button"],button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"]'
).forEach(el => {
  if (getRole(el) === 'button' && getAccessibleName(el) === 'Submit') ...
});
```

This reduces the candidate set from potentially thousands of elements to typically single digits.

### 6.3 Should We Cache/Index?

**Testing Library's approach**: No persistent cache. Uses a `WeakMap<Element, Boolean>` for `isSubtreeInaccessible()` results within a single query, then discards.

**Playwright's approach**: No persistent role cache. Resolves fresh on every action.

**Recommendation for Safari Pilot**: Do NOT cache roles across actions. DOM mutations invalidate any cache, and MutationObserver-based invalidation adds complexity without meaningful benefit given that:
1. Pre-filtered CSS queries are already fast (< 5ms)
2. Locator resolution happens once per action, not in a tight loop
3. The DOM may change between any two actions

**Exception**: If Safari Pilot builds a snapshot feature (P0 item), the snapshot IS a cache of the entire accessibility tree. That snapshot should be invalidated on any DOM mutation.

### 6.4 querySelectorAll Performance Notes

`querySelectorAll('[role]')` is fast in all browsers because attribute selectors use simple string matching, not layout computation.

The expensive operations are:
1. `getComputedStyle()` -- triggers style computation (but usually cached by the browser)
2. `getBoundingClientRect()` -- may trigger layout
3. `computeAccessibleName()` -- involves getComputedStyle + DOM walking

**For Safari Pilot**: Defer expensive checks (visible, stable, accessible name) until AFTER the cheap pre-filter has narrowed candidates to a small set.

---

## 7. Implementation Recommendations for Safari Pilot

### 7.1 Architecture

```
MCP Tool Input          Locator Resolver (JS)           DOM
─────────────    ──>    ─────────────────────    ──>    ───
{                       1. Parse locator type           querySelectorAll
  role: "button",       2. Build CSS pre-filter         (fast, ~1ms)
  name: "Submit"        3. Post-filter by role          element.matches()
}                       4. Post-filter by name          computeAccessibleName()
                        5. Actionability checks         isVisible(), isStable()
                        6. Return element or retry      requestAnimationFrame
```

### 7.2 Locator Types for Safari Pilot Tools

Extend all interaction/extraction tool schemas to accept these new parameters alongside `selector`:

```typescript
interface LocatorParams {
  // Existing
  selector?: string;        // CSS selector (existing)

  // New locator types (mutually exclusive with each other, combine with selector for scoping)
  role?: string;            // ARIA role name
  name?: string;            // Accessible name (for role queries) or visible text (for text queries)
  text?: string;            // Visible text content match
  label?: string;           // Associated label text
  testId?: string;          // data-testid attribute value
  placeholder?: string;     // placeholder attribute value

  // Matching options
  exact?: boolean;          // Exact match (default: false for role/text/label/placeholder, true for testId)
}
```

### 7.3 Resolution Priority

When a tool receives locator params, resolve in this order:

1. **If `selector` provided**: Use CSS selector directly
2. **If `role` provided**: Use role-based resolution (with optional `name` filter)
3. **If `text` provided**: Use text-based resolution
4. **If `label` provided**: Use label-based resolution
5. **If `testId` provided**: Use `[data-testid="value"]` attribute selector
6. **If `placeholder` provided**: Use `[placeholder="value"]` attribute selector

### 7.4 Minimal JavaScript for Content Script

The resolver should be a single self-contained JavaScript function (~300 lines) injected into the page via the Safari Web Extension's content script. It should:

1. **NOT** depend on aria-query or dom-accessibility-api (too heavy for extension content script)
2. Hardcode the implicit role mapping table (Section 2.1)
3. Implement a simplified accessible name computation (covers 95% of cases):
   - `aria-labelledby` -> referenced element textContent
   - `aria-label` -> attribute value
   - `<label for="id">` -> label textContent
   - Wrapping `<label>` -> label textContent
   - `alt` attribute (for img)
   - `title` attribute (fallback)
   - Element text content (for elements that allow naming from content: buttons, links, headings, etc.)
4. Return the first matching element (strict mode) or throw descriptive error

### 7.5 Integration with Auto-Wait (P0 Item)

The locator resolver should integrate with the auto-wait system:

```javascript
async function resolveLocatorWithWait(locator, timeout = 5000) {
  const backoff = [0, 20, 50, 100, 100, 500, 500, 500, 1000];
  const startTime = Date.now();
  let attempt = 0;

  while (Date.now() - startTime < timeout) {
    const element = resolveLocator(locator);
    if (element) {
      // Run actionability checks
      if (await isActionable(element, locator.action)) {
        return element;
      }
    }

    // Wait with backoff
    const delay = backoff[Math.min(attempt, backoff.length - 1)];
    await new Promise(r => setTimeout(r, delay));
    attempt++;
  }

  throw new LocatorTimeoutError(locator, timeout);
}
```

### 7.6 Error Messages

Follow Testing Library's pattern of helpful error messages:

```
Unable to find an element with role "button" and name "Submit"

Available roles:
  button:
    Name "Cancel": <button class="btn-cancel">Cancel</button>
    Name "Save": <button class="btn-save">Save</button>
  link:
    Name "Home": <a href="/">Home</a>
```

This helps the AI agent self-correct its locator without requiring additional page inspection.

---

## Sources

### Specifications
- W3C HTML-ARIA: https://www.w3.org/TR/html-aria/ (REC 2026-04-07)
- W3C HTML-AAM: https://w3c.github.io/html-aam/ (Editor's Draft 2026-04-10)
- W3C WAI-ARIA 1.2: https://www.w3.org/TR/wai-aria-1.2/
- W3C Accessible Name Computation: https://w3c.github.io/accname/

### Source Code (Verified)
- Playwright `frames.ts`: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/frames.ts
- Testing Library `queries/role.ts`: https://github.com/testing-library/dom-testing-library/blob/main/src/queries/role.ts
- Testing Library `queries/text.ts`: https://github.com/testing-library/dom-testing-library/blob/main/src/queries/text.ts
- Testing Library `queries/label-text.ts`: https://github.com/testing-library/dom-testing-library/blob/main/src/queries/label-text.ts
- Testing Library `role-helpers.js`: https://github.com/testing-library/dom-testing-library/blob/main/src/role-helpers.js
- Testing Library `label-helpers.ts`: https://github.com/testing-library/dom-testing-library/blob/main/src/label-helpers.ts
- Testing Library `matches.ts`: https://github.com/testing-library/dom-testing-library/blob/main/src/matches.ts
- Testing Library `get-node-text.ts`: https://github.com/testing-library/dom-testing-library/blob/main/src/get-node-text.ts
- Testing Library `wait-for.js`: https://github.com/testing-library/dom-testing-library/blob/main/src/wait-for.js
- aria-query `elementRoleMap.js`: https://github.com/A11yance/aria-query/blob/main/src/elementRoleMap.js
- aria-query `roleElementMap.js`: https://github.com/A11yance/aria-query/blob/main/src/roleElementMap.js
- aria-query `buttonRole.js`: https://github.com/A11yance/aria-query/blob/main/src/etc/roles/literal/buttonRole.js
- dom-accessibility-api `accessible-name-and-description.ts`: https://github.com/eps1lon/dom-accessibility-api/blob/main/sources/accessible-name-and-description.ts

### Deep Research Report
- Parallel Deep Research (trun_4e978fe567d34864b630b54c987604bd): /tmp/p1-locator-research-parallel.md
  Cross-referenced against all source code findings above

### Documentation
- Playwright Locators: https://playwright.dev/docs/locators
- Playwright Actionability: https://playwright.dev/docs/actionability
- MDN ARIA Roles: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles
- MDN document.evaluate(): https://developer.mozilla.org/en-US/docs/Web/API/Document/evaluate
