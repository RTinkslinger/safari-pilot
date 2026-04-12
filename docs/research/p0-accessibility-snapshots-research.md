# P0 Research: Structured Accessibility Snapshots

## Purpose

This document captures exhaustive research for implementing Playwright-compatible structured accessibility snapshots in Safari Pilot. It covers Playwright's internal architecture, Safari/WebKit API availability, the ARIA name/role computation algorithms, ref stability strategies, cross-browser differences, and performance considerations. A future session should be able to read this cold and produce a design spec + implementation plan.

---

## 1. How Playwright Builds Its Accessibility Tree

### Source Code Architecture

Playwright's accessibility snapshot system is spread across several files in the monorepo. The key files are:

| File | Purpose |
|------|---------|
| `packages/injected/src/ariaSnapshot.ts` | **Injected into the page.** Walks the DOM, builds the AriaNode tree, assigns refs, handles Shadow DOM/iframes |
| `packages/injected/src/roleUtils.ts` | Role computation (implicit + explicit), accessible name computation (full accname algorithm), hidden element detection |
| `packages/isomorphic/ariaSnapshot.ts` | Type definitions for `AriaNode`, `AriaRole`, YAML parsing for snapshot templates |
| `packages/playwright-core/src/tools/backend/snapshot.ts` | MCP tool definition for `browser_snapshot` |
| `packages/playwright-core/src/tools/backend/tab.ts` | Calls `page.ariaSnapshot({ mode: 'ai' })`, manages ref resolution via `aria-ref=` selector |
| `packages/playwright-core/src/tools/backend/response.ts` | Serializes the YAML snapshot into the MCP response, handles incremental diffs |

Source: https://github.com/microsoft/playwright (packages/injected/src/ariaSnapshot.ts, packages/injected/src/roleUtils.ts)

### The Injected Script: `ariaSnapshot.ts`

The core function is `generateAriaTree(rootElement, options)` which returns an `AriaSnapshot`:

```typescript
type AriaSnapshot = {
  root: AriaNode;
  elements: Map<string, Element>;  // ref -> Element
  refs: Map<Element, string>;       // Element -> ref
  iframeRefs: string[];
};
```

**Tree building algorithm:**

1. Start at `rootElement` (usually `document.body` or a scoped locator target)
2. Recursively `visit()` each DOM node
3. For each `Element` node:
   - Check visibility (three modes: `aria`, `ariaOrVisible`, `ariaAndVisible`)
   - Handle `aria-owns` to include owned elements
   - Call `toAriaNode()` to compute role, name, and create the AriaNode
   - If the element has a Shadow DOM root, walk into it
   - Handle `<slot>` elements and their assigned nodes
   - Process CSS pseudo-elements (`::before`, `::after`) via `getCSSContent()`
4. For text nodes: include text content unless parent is a textbox role
5. After full tree walk: normalize string children (whitespace collapse) and remove trivial generic wrappers

### Tree Options Modes

Playwright has four modes, controlled by `AriaTreeOptions.mode`:

| Mode | Visibility | Refs | Usage |
|------|-----------|------|-------|
| `ai` | `ariaOrVisible` | `interactable` only | **MCP / Claude Code** -- only refs visible + pointer-receiving elements |
| `default` | `aria` | none | Snapshot testing assertions |
| `codegen` | `aria` | none | Code generator (adds regex heuristics) |
| `autoexpect` | `ariaAndVisible` | none | Auto-generating assertions |

**Critical insight for Safari Pilot**: The `ai` mode is what Claude Code uses. It only assigns refs to elements that are both visually visible AND receive pointer events. Elements with `pointer-events: none` get NO ref. This is deliberate -- it prevents the LLM from trying to click non-interactive overlays.

### Shadow DOM Handling

Shadow DOM is handled naturally by the tree walker:

```typescript
if (element.shadowRoot) {
  for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
    visit(ariaNode, child, parentElementVisible);
}
```

For `<slot>` elements, Playwright checks `assignedNodes()` and walks those instead of direct children:

```typescript
const assignedNodes = element.nodeName === 'SLOT' 
  ? (element as HTMLSlotElement).assignedNodes() : [];
if (assignedNodes.length) {
  for (const child of assignedNodes)
    visit(ariaNode, child, parentElementVisible);
}
```

### iframe Handling

iframes get a special `role: 'iframe'` node with a ref. The MCP server stitches iframe snapshots together:

- Main page snapshot includes `iframe [ref=e3]` nodes
- Each iframe gets its own snapshot with refs prefixed by frame ID: `f1e1`, `f1e2`, etc.
- The prefix format is `f{frameIndex}e{elementCounter}`
- Cross-origin iframes are treated as opaque (just the iframe node, no children)

Test example from Playwright source:
```yaml
- list [ref=e2]:
    - listitem [ref=e3]:
      - iframe [ref=e4]:
        - button "button1" [ref=f1e2]
    - listitem [ref=e5]:
      - iframe [ref=e6]:
        - button "button2" [ref=f2e2]
```

### Hidden Element Pruning

Playwright's `isElementHiddenForAria()` checks (in `roleUtils.ts`):

1. Skip `<style>`, `<script>`, `<noscript>`, `<template>` entirely
2. Check `aria-hidden="true"` (hides element and all descendants)
3. Check CSS `display: none` (hides element and all descendants)
4. Check CSS `visibility: hidden` / `visibility: collapse`
5. Special case: `display: contents` -- only hidden if ALL children are hidden
6. Special case: `<option>` inside `<select>` ignores visibility rules
7. Special case: `<slot>` elements ignore visibility rules
8. Check: light DOM children of shadow hosts that aren't assigned to a slot are hidden
9. `role="presentation"` or `role="none"` removes semantics but element still participates in name computation

### SVG and Canvas

- `<svg>` elements get implicit role `img` (following Chrome behavior; Firefox reports `diagram`, Safari reports no role)
- `<canvas>` elements: no implicit ARIA role. Only included if they have explicit ARIA attributes
- SVG child elements (circles, paths, etc.) are not individually exposed unless they have ARIA attributes

---

## 2. Playwright's Exact Output Format

### YAML Structure

The output is YAML with this structure for each node:

```
- role "name" [attribute=value] [ref=eN]:
    - child_role "child_name" [ref=eM]: inline text content
    - /url: "https://example.com"
```

**Key formatting rules:**
- Each node is a YAML list item (`- `)
- Role name comes first, then optional quoted name, then bracketed attributes, then ref
- Single text children are inlined after colon: `- button "Submit" [ref=e5]: Click here`
- If a node has only one text child that equals its name, children are omitted entirely
- Props like URL are listed as `/url: value`
- Indentation is 2 spaces per level

### Attributes Rendered

| Attribute | Format | When included |
|-----------|--------|--------------|
| `checked` | `[checked]` or `[checked=mixed]` | When element has checked state |
| `disabled` | `[disabled]` | When disabled=true |
| `expanded` | `[expanded]` | When expanded=true |
| `active` | `[active]` | **AI mode only** -- when element is `document.activeElement` |
| `level` | `[level=N]` | For headings (h1-h6) and tree items |
| `pressed` | `[pressed]` or `[pressed=mixed]` | For toggle buttons |
| `selected` | `[selected]` | For options, tabs, etc. |
| `ref` | `[ref=eN]` | **AI mode only** -- for interactable elements |
| `cursor` | `[cursor=pointer]` | **AI mode only** -- when element has pointer cursor |

### Real Output Example (from Playwright test suite)

For three buttons:
```yaml
- generic [active] [ref=e1]:
  - button "One" [ref=e2]
  - button "Two" [ref=e3]
  - button "Three" [ref=e4]
```

For nested iframes:
```yaml
- generic [active] [ref=e1]:
  - iframe [ref=e2]:
    - generic [active] [ref=f1e1]:
      - iframe [ref=f1e2]:
        - generic [ref=f3e2]: Hi, I'm frame
      - iframe [ref=f1e3]:
        - generic [ref=f4e2]: Hi, I'm frame
  - iframe [ref=e3]:
    - generic [ref=f2e2]: Hi, I'm frame
```

### Incremental Diff Support

When a previous snapshot exists, Playwright compares old vs new trees and:
- Marks unchanged subtrees with `ref=eN [unchanged]` (no children rendered)
- Marks changed nodes with `<changed>` prefix
- Only renders the changed portions of the tree

This is a significant optimization for the MCP use case -- after a click, only the parts of the page that changed are sent to the LLM.

---

## 3. Ref Identifier Strategy

### How Refs Are Generated

From the source code (`computeAriaRef` function):

```typescript
let lastRef = 0;  // Module-level counter

function computeAriaRef(ariaNode: AriaNode, options: InternalOptions) {
  if (options.refs === 'none') return;
  if (options.refs === 'interactable' && (!ariaNode.box.visible || !ariaNode.receivesPointerEvents))
    return;

  const element = ariaNodeElement(ariaNode);
  let ariaRef = (element as any)._ariaRef as AriaRef | undefined;
  if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
    ariaRef = { role: ariaNode.role, name: ariaNode.name, 
                ref: (options.refPrefix ?? '') + 'e' + (++lastRef) };
    (element as any)._ariaRef = ariaRef;
  }
  ariaNode.ref = ariaRef.ref;
}
```

**Key findings:**

1. **Refs are monotonic counters**: `e1`, `e2`, `e3`, ... Never recycled.
2. **Refs are cached on the DOM element** via `element._ariaRef` property. If the same element is snapshotted again with the same role+name, it keeps its old ref.
3. **Invalidation**: If the element's role OR name changes, a new ref is assigned. The old counter value is gone forever.
4. **Module-level counter**: `lastRef` is a closure variable that persists for the lifetime of the page. It only resets on page navigation.
5. **iframe prefix**: iframe refs use a frame prefix like `f1`, `f2`, etc.

### Stability Characteristics

| Scenario | Ref stable? |
|----------|------------|
| Same element, same content, re-snapshot | YES -- cached on `element._ariaRef` |
| Element text content changes | NO -- new ref assigned (name changed) |
| Element moves in DOM (reordered) | YES -- ref is on the element object, not position |
| New element inserted before existing | YES -- existing elements keep their refs |
| Element removed, then re-added | NO -- new DOM element, new ref |
| Page navigation | NO -- all refs reset (`lastRef` survives but elements are new) |

### Ref Resolution in MCP

When Claude sends `ref=e42` to an action tool (click, fill, etc.), Playwright resolves it via:

```typescript
let locator = this.page.locator(`aria-ref=${param.ref}`);
```

This `aria-ref=` is a custom Playwright selector engine that:
1. Takes the current AriaSnapshot (which maps ref strings to Element objects)
2. Looks up the element for the given ref
3. Returns a Playwright Locator pointing to that element

If the ref is stale (element was removed or ref invalidated), it throws:
> "Ref e42 not found in the current page snapshot. Try capturing new snapshot."

### Implications for Safari Pilot

Safari Pilot can't use Playwright's `aria-ref=` selector engine. Options:

1. **Store a `ref -> CSS selector` map** -- generate a unique CSS selector for each ref'd element at snapshot time
2. **Store a `ref -> XPath` map** -- generate XPath for each ref'd element
3. **Inject a `data-sp-ref` attribute** -- stamp each ref'd element with a data attribute, then use `[data-sp-ref="e42"]` to find it later
4. **Use a WeakMap in the extension** -- store `ref -> element` in JS, query via extension messaging

Option 3 (data attribute stamping) is most robust because it survives across separate JS evaluation contexts. Option 4 is cleaner but requires the extension to maintain state between calls.

---

## 4. ARIA Role Computation Algorithm

### Playwright's Implementation (from `roleUtils.ts`)

The `getAriaRole(element)` function in Playwright follows this hierarchy:

1. **Check explicit role**: `element.getAttribute('role')` -- split on spaces, find first valid ARIA role
2. **If explicit role is `none` or `presentation`**: check for conflict resolution -- if the element is focusable or has global ARIA attributes, revert to implicit role
3. **If no explicit role**: use implicit role from HTML tag name
4. **Presentation inheritance**: if parent has `role="presentation"`, certain child roles are also removed (e.g., `<li>` inside `role="presentation" <ul>`)

### Complete Implicit Role Mapping Table (from Playwright source)

| HTML Element | Implicit Role | Conditions/Notes |
|-------------|--------------|-----------------|
| `<a>` | `link` | Only if `href` present; otherwise `null` |
| `<area>` | `link` | Only if `href` present |
| `<article>` | `article` | |
| `<aside>` | `complementary` | |
| `<blockquote>` | `blockquote` | |
| `<button>` | `button` | |
| `<caption>` | `caption` | |
| `<code>` | `code` | |
| `<datalist>` | `listbox` | |
| `<dd>` | `definition` | |
| `<del>` | `deletion` | |
| `<details>` | `group` | |
| `<dfn>` | `term` | |
| `<dialog>` | `dialog` | |
| `<dt>` | `term` | |
| `<em>` | `emphasis` | |
| `<fieldset>` | `group` | |
| `<figure>` | `figure` | |
| `<footer>` | `contentinfo` | Only if NOT inside `<article>`, `<aside>`, `<main>`, `<nav>`, `<section>` |
| `<form>` | `form` | Only if has explicit accessible name (`aria-label` or `aria-labelledby`) |
| `<h1>`-`<h6>` | `heading` | |
| `<header>` | `banner` | Only if NOT inside landmark-preventing ancestor |
| `<hr>` | `separator` | |
| `<html>` | `document` | |
| `<img>` | `img` or `presentation` | `presentation` when `alt=""` and no title/global ARIA/tabindex |
| `<input type="text/email/tel/url">` | `textbox` or `combobox` | `combobox` when `list` attribute points to a `<datalist>` |
| `<input type="search">` | `searchbox` or `combobox` | `combobox` with `list` attribute |
| `<input type="checkbox">` | `checkbox` | |
| `<input type="radio">` | `radio` | |
| `<input type="range">` | `slider` | |
| `<input type="number">` | `spinbutton` | |
| `<input type="file">` | `button` | Not in spec but all browsers report button |
| `<input type="hidden">` | `null` | Not exposed |
| `<ins>` | `insertion` | |
| `<li>` | `listitem` | |
| `<main>` | `main` | |
| `<mark>` | `mark` | |
| `<math>` | `math` | |
| `<menu>` | `list` | |
| `<meter>` | `meter` | |
| `<nav>` | `navigation` | |
| `<ol>` | `list` | |
| `<optgroup>` | `group` | |
| `<option>` | `option` | |
| `<output>` | `status` | |
| `<p>` | `paragraph` | |
| `<progress>` | `progressbar` | |
| `<search>` | `search` | |
| `<section>` | `region` | Only if has explicit accessible name |
| `<select>` | `combobox` or `listbox` | `listbox` when `multiple` or `size > 1` |
| `<strong>` | `strong` | |
| `<sub>` | `subscript` | |
| `<sup>` | `superscript` | |
| `<svg>` | `img` | Chrome behavior; Firefox = `diagram`, Safari = no role |
| `<table>` | `table` | |
| `<tbody>`, `<thead>`, `<tfoot>` | `rowgroup` | |
| `<td>` | `cell` or `gridcell` | `gridcell` when parent table has `role="grid"` or `role="treegrid"` |
| `<textarea>` | `textbox` | |
| `<th>` | `columnheader` or `rowheader` | Based on `scope` attribute and context |
| `<time>` | `time` | |
| `<tr>` | `row` | |
| `<ul>` | `list` | |

Source: https://www.w3.org/TR/html-aria/#docconformance, https://w3c.github.io/html-aam/#html-element-role-mappings

### Roles that are "generic" in Playwright's AI mode

In `ai` mode, Playwright includes `generic` as the default role for elements that don't have an implicit or explicit ARIA role (like `<div>`, `<span>`). These are normalized: if a `generic` node with no name wraps a single child that has a ref, the `generic` wrapper is removed to reduce noise.

---

## 5. Accessible Name Computation Algorithm

### Playwright's Implementation (from `roleUtils.ts`)

The `getElementAccessibleName(element, includeHidden)` function implements the full W3C accname algorithm. Here is the priority order:

#### Step 1: Check if naming is prohibited
Roles that prohibit naming: `caption`, `code`, `definition`, `deletion`, `emphasis`, `generic`, `insertion`, `mark`, `paragraph`, `presentation`, `strong`, `subscript`, `suggestion`, `superscript`, `term`, `time`. Return empty string for these.

#### Step 2a: Hidden check
If element is hidden for ARIA and not being traversed from `aria-labelledby`/`aria-describedby`, return empty string.

#### Step 2b: `aria-labelledby` (HIGHEST PRIORITY)
If `aria-labelledby` is set and not already in a labelledby traversal:
- Get all referenced elements by ID
- Recursively compute name for each
- Join with spaces
- This CAN reference hidden elements (the referenced element's hidden status is tracked)

#### Step 2c/2d: Embedded control in label
If currently inside a label traversal and the element is a control:
- **textbox**: return `element.value`
- **combobox/listbox**: return selected option text
- **slider/spinbutton/progressbar/meter**: return `aria-valuetext`, then `aria-valuenow`, then `value`
- **menu**: return empty string

#### Step 2d: `aria-label`
If `aria-label` is set and non-empty after trimming, return its value.

#### Step 2e: Native host language features
Special handling for:
- `<input type="button/submit/reset">`: use `value`, fallback to "Submit"/"Reset"
- `<input type="file">`: use labels, fallback to "Choose File"
- `<input type="image">`: use labels, then `alt`, then `title`, fallback to "Submit"
- `<button>`: use associated `<label>` elements
- `<output>`: use associated labels, then `title`
- Form controls with labels: `element.labels` -> concatenate label text
- `<fieldset>`: use `<legend>` child
- `<img>`: use `alt` attribute
- `<table>`: use `<caption>` child

#### Step 2f: Name from content
If the role allows name-from-content (buttons, links, headings, checkboxes, options, etc.):
- Recursively collect text from all descendants
- Include CSS `::before` and `::after` generated content
- Normalize whitespace

#### Step 2g: Title fallback
If nothing else provides a name, use `element.getAttribute('title')`.

### Roles that allow name-from-content

Always: `button`, `cell`, `checkbox`, `columnheader`, `gridcell`, `heading`, `link`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `radio`, `row`, `rowheader`, `switch`, `tab`, `tooltip`, `treeitem`

When traversing descendants: `caption`, `code`, `contentinfo`, `definition`, `deletion`, `emphasis`, `insertion`, `list`, `listitem`, `mark`, `none`, `paragraph`, `presentation`, `region`, `row`, `rowgroup`, `section`, `strong`, `subscript`, `superscript`, `table`, `term`, `time`

Source: https://w3c.github.io/accname/, https://w3c.github.io/aria/#namefromcontent

---

## 6. WebKit/Safari Accessibility APIs

### JavaScript APIs Available in Safari

| API | Safari Support | Notes |
|-----|---------------|-------|
| `element.computedRole` | YES (Safari 16.4+) | AOM Phase 1. Returns computed ARIA role as string. |
| `element.computedName` | YES (Safari 16.4+) | AOM Phase 1. Returns computed accessible name. Known bug: empty string for nested labels (WebKit Bug 242101). |
| `window.getComputedAccessibleNode()` | NO (experimental, not in stable) | AOM Phase 2. Would allow tree traversal. Not available in production Safari. |
| `element.ariaLabel`, `element.ariaRoleDescription`, etc. | YES | All 51 `aria*` reflection properties on Element interface are supported. |
| `TreeWalker` API | YES (DOM walker only) | Can walk DOM tree but NOT the accessibility tree. Cannot filter by ARIA role. |
| `element.getAttribute('role')` | YES | Standard DOM API for reading explicit role. |
| `element.labels` | YES | For form controls, returns associated labels. |
| `getComputedStyle()` | YES | For checking visibility. |

Source: https://developer.mozilla.org/en-US/docs/Web/API/Element, https://caniuse.com

### Critical Finding: `computedRole` and `computedName`

Safari DOES support `element.computedRole` and `element.computedName` (since Safari 16.4 / WebKit, early 2023). This is a major finding -- it means Safari Pilot can lean on the browser's own ARIA computation rather than reimplementing the full algorithm in JS.

**However**, there are known bugs:
- **WebKit Bug 242101**: `computedName` returns empty string for elements with nested `<label>` elements
- Concatenation of names from multiple `aria-labelledby` targets may be incomplete

**Recommendation**: Use `computedRole` and `computedName` as primary source, but implement fallback name computation for known bug cases (nested labels, multi-ID labelledby).

### Native macOS AX APIs (via Swift daemon)

Safari Pilot already has a Swift daemon. The macOS Accessibility APIs offer a complementary approach:

| API | Capability |
|-----|-----------|
| `AXUIElementCreateApplication(pid)` | Get top-level AX element for Safari process |
| `AXUIElementCopyAttributeValue` | Read any attribute (AXRole, AXTitle, AXDescription, AXValue, AXChildren, etc.) |
| `AXUIElementCopyAttributeNames` | List all available attributes for an element |
| `AXUIElementGetAttributeValueCount` | Count children without allocating array |
| `kAXFocusedUIElementAttribute` | Get currently focused element |
| `kAXChildrenAttribute` | Get child elements for tree walking |

**Advantages of native AX over JS:**
- Access to the COMPLETE accessibility tree including browser chrome
- Not affected by JS AOM bugs
- Can inspect elements in cross-origin iframes
- Provides platform-native role names and states

**Disadvantages:**
- Requires Accessibility permission (TCC prompt)
- Returns macOS-native role names (`AXButton`) not ARIA role names (`button`) -- requires mapping
- Includes browser UI elements (address bar, tabs) mixed with web content
- Much slower for large pages (IPC overhead for each attribute query)
- Cannot directly correlate AX elements back to DOM elements for ref targeting

**Recommendation**: Use JS-based approach as primary (faster, directly maps to DOM elements for ref targeting). Use native AX as a validation/debugging tool, not for production snapshots.

---

## 7. Cross-Browser Accessibility Tree Differences

### Safari vs Chrome vs Firefox

| Aspect | Chrome/Blink | Firefox/Gecko | Safari/WebKit |
|--------|-------------|---------------|--------------|
| `<svg>` role | `img` | `diagram` (non-standard) | No role |
| `<select>` role | `combobox` | `combobox` | `combobox` (but `listbox` for `size>1`) |
| `<section>` without name | No role | No role | Sometimes `group` |
| `<th>` in single-cell table | `columnheader` | `columnheader` | No role |
| Off-screen elements | Always in tree | Always in tree | **Sometimes omitted** (Bug 245333) |
| `role="listbox"` | `listbox` | `listbox` | Sometimes `AXList` (Bug 235678) |
| `computedName` for nested labels | Correct | Correct | **Empty string** (Bug 242101) |
| `aria-modal` | Full support | Full support | Partial (relies on native dialog detection) |
| `aria-live` regions | Full support | Full support | Inconsistent announcements |

### Known WebKit Bugs Affecting Snapshots

| Bug ID | Description | Impact |
|--------|------------|--------|
| 235678 | `role="listbox"` mapped as `AXList` | Incorrect role in snapshot |
| 239012 | `aria-allowed-roles` missing from tree | Validation gaps |
| 242101 | `computedName` empty for nested labels | Missing names |
| 245333 | Off-screen nodes omitted from tree | Non-deterministic snapshots based on scroll position |

### Implications for Safari Pilot

1. **Do NOT use native AX role names** -- map everything to standard ARIA role names
2. **Implement workaround for nested label bug** -- compute name manually when `computedName` is empty but labels exist
3. **Handle off-screen elements explicitly** -- always include elements that pass visibility check, even if WebKit's tree would omit them
4. **SVG elements** -- assign `img` role to top-level `<svg>` to match Playwright convention

---

## 8. Element Ref Stability Strategy for Safari Pilot

### Analysis of Approaches

| Strategy | Stability | Performance | Complexity | Recommended? |
|----------|-----------|-------------|-----------|-------------|
| Monotonic counter (Playwright's approach) | Medium -- survives reorder, breaks on content change | O(1) assign | Low | YES as primary |
| XPath hash | Medium -- breaks on ancestor changes | O(depth) per element | Medium | No |
| Content hash (role + name) | Low -- breaks on any text change | O(name length) | Low | No |
| `data-testid` priority | High -- application-controlled | O(1) lookup | Low | YES as supplement |
| DOM element caching via WeakMap | High within session | O(1) | Low | YES for persistence |

### Recommended Strategy

**Hybrid approach matching Playwright's design:**

1. **Assign refs via monotonic counter**: `e1`, `e2`, `e3`, etc. -- simple, predictable
2. **Cache ref on the DOM element**: Use the Safari Web Extension to stamp a non-visible property on each element. When re-snapshotting, check if the element already has a ref and its role+name haven't changed -- if so, reuse the ref.
3. **Resolution via data attribute**: Stamp `data-sp-ref="e42"` on each ref'd element. This allows any subsequent tool call to find the element via `document.querySelector('[data-sp-ref="e42"]')`.
4. **Invalidation on name/role change**: If an element's computed role or name changes between snapshots, assign a new ref (new counter value). The old ref is dead.
5. **Frame prefixing**: For iframes, prefix refs with `f{index}` matching Playwright convention.

**Why data attributes over WeakMap:**
- Data attributes survive across separate `executeJsInTab` calls (Safari Pilot's JS execution is stateless between calls)
- They can be queried from both the extension and injected scripts
- They're visible in DevTools for debugging
- The only downside is DOM mutation, but these are non-visible attributes

### Ref Cleanup

Before each snapshot, consider:
- Leave old `data-sp-ref` attributes in place (they don't cause harm)
- Only clean up on page navigation (when all refs are invalid anyway)
- If an element loses its ref (role/name changed), the old data attribute remains but the ref registry doesn't include it

---

## 9. Performance Considerations

### Benchmarks (from research + Playwright's own data)

| Page complexity | DOM nodes | Expected tree nodes | Traversal time | Payload size |
|----------------|-----------|-------------------|----------------|-------------|
| Simple page | ~100 | ~50 | <10ms | <5KB |
| Medium web app | ~2,000 | ~500-1,000 | 50-100ms | 50-200KB |
| Complex SPA | ~10,000 | ~3,000-7,000 | 200-500ms | 500KB-2MB |
| Massive page | ~50,000+ | ~15,000+ | 1-5s+ | 5MB+ |

### Playwright's Approach

- **No caching**: Every `ariaSnapshot()` call does a full tree walk
- **No incremental updates**: No diffing against previous state during the walk itself
- **Post-hoc diffing**: The render phase compares current vs previous snapshot and emits only changes (but the walk is still full)
- **Caching within a single walk**: Role computations and name computations use per-walk caches (`beginAriaCaches()` / `endAriaCaches()`) to avoid recomputing for the same element

### Optimizations for Safari Pilot

1. **Scoping**: Support `scope` parameter to limit walk to a subtree (already partially implemented in current `safari_snapshot`)
2. **Depth limiting**: Support `maxDepth` parameter (already implemented, keep it)
3. **Per-walk caches**: Cache `computedRole` and `computedName` lookups during a single walk to avoid redundant calls
4. **Visibility short-circuit**: If an element's computed style is `display: none`, skip its entire subtree
5. **Diff-based output**: After first snapshot, emit only changes on subsequent snapshots. This is critical for MCP where token count matters.
6. **Payload size limit**: Cap output at ~5MB and truncate with a warning
7. **Timeout**: Add a configurable timeout (default 5s) for the tree walk. Abort and return partial results if exceeded.

### Safari-Specific Performance Notes

- `computedRole` and `computedName` are browser-computed, so they should be fast (single property access, no recalculation)
- `getComputedStyle()` is the most expensive per-element call -- cache it
- Safari's JS engine (JavaScriptCore) is generally fast but can be slower than V8 for complex DOM operations
- AppleScript `do JavaScript` has significant IPC overhead (~5-10ms per call) -- the entire snapshot JS must run in a single evaluation, not multiple calls

---

## 10. Current Safari Pilot Implementation Gap Analysis

### What exists today (`extraction.ts` handleSnapshot)

The current `safari_snapshot` implementation:
- Walks the DOM manually via `node.children` iteration
- Has a basic `getRole()` function with a hardcoded 15-entry tag-to-role map
- Has a basic `getName()` that checks: `aria-label` -> `alt` -> `title` -> `placeholder` -> label text -> `textContent`
- Has a basic `getState()` for form control states
- Has an `isInteractive()` check based on tag name and onclick presence
- Outputs in a custom `-` indented text format (NOT Playwright YAML format)
- Has NO ref system
- Has NO Shadow DOM handling
- Has NO iframe handling
- Has NO CSS pseudo-element content
- Has NO `aria-owns` support
- Has NO presentation/none role handling
- Has NO name-from-content recursion
- Has NO name-from-labelledby computation

### What needs to be built

1. **Full role computation** matching the 40+ entry table from Playwright's `roleUtils.ts`
2. **Full name computation** following the accname algorithm (or use `computedRole`/`computedName` as shortcut)
3. **Ref system** with monotonic counter, DOM caching, and data attribute stamping
4. **YAML output format** matching Playwright's exact structure
5. **Shadow DOM walking** via `element.shadowRoot`
6. **iframe handling** with frame-prefixed refs
7. **Visibility/pruning** matching Playwright's `isElementHiddenForAria()`
8. **Attribute rendering** (checked, disabled, expanded, level, pressed, selected, active)
9. **Incremental diff support** for efficient subsequent snapshots
10. **Ref resolution** in all interaction tools (click, fill, etc.) via `[data-sp-ref]` selector

### Implementation approach options

**Option A: Full JS reimplementation** (like Playwright does)
- Pro: Complete control, handles all edge cases, works on older Safari
- Con: Massive implementation effort (~800+ lines of roleUtils.ts alone)

**Option B: Lean on `computedRole` + `computedName`** (Safari 16.4+)
- Pro: Browser does the heavy lifting, much less code, more correct by default
- Con: Requires Safari 16.4+, known bugs need workarounds
- Implementation: Walk DOM tree, for each element call `computedRole` and `computedName`, build AriaNode tree, assign refs

**Option C: Hybrid** (recommended)
- Use `computedRole` as primary role source
- Use `computedName` as primary name source
- Implement fallback role computation for elements where `computedRole` returns empty/null (some edge cases)
- Implement fallback name computation for known `computedName` bugs (nested labels)
- Keep the full implicit role mapping table as fallback data

**Recommendation: Option C (Hybrid).** It gets 90% of the way with `computedRole`/`computedName`, then patches the remaining 10% with targeted fallbacks. Total implementation is maybe 300-400 lines of new JS vs 800+ for full reimplementation.

---

## 11. Source References

### Playwright Source Code
- `ariaSnapshot.ts` (injected): https://github.com/microsoft/playwright/blob/main/packages/injected/src/ariaSnapshot.ts
- `roleUtils.ts` (injected): https://github.com/microsoft/playwright/blob/main/packages/injected/src/roleUtils.ts
- `ariaSnapshot.ts` (isomorphic types): https://github.com/microsoft/playwright/blob/main/packages/isomorphic/ariaSnapshot.ts
- MCP snapshot tool: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/backend/snapshot.ts
- MCP tab/ref resolution: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/backend/tab.ts
- MCP response rendering: https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/tools/backend/response.ts
- AI snapshot tests: https://github.com/microsoft/playwright/blob/main/tests/page/page-aria-snapshot-ai.spec.ts
- Aria snapshot docs: https://github.com/microsoft/playwright/blob/main/docs/src/aria-snapshots.md

### W3C Specifications
- ARIA Roles: https://www.w3.org/TR/wai-aria-1.2/#role_definitions
- Accessible Name Computation: https://w3c.github.io/accname/
- HTML-AAM Role Mappings: https://w3c.github.io/html-aam/#html-element-role-mappings
- HTML ARIA conformance: https://www.w3.org/TR/html-aria/#docconformance

### WebKit / Safari
- WebKit Bug 235678 (listbox role mapping): https://bugs.webkit.org/show_bug.cgi?id=235678
- WebKit Bug 242101 (computedName nested labels): https://bugs.webkit.org/show_bug.cgi?id=242101
- WebKit Bug 245333 (off-screen node omission): https://bugs.webkit.org/show_bug.cgi?id=245333
- MDN Element ARIA properties: https://developer.mozilla.org/en-US/docs/Web/API/Element

### Parallel Research Report
- Full deep research output: `/docs/research/parallel-a11y-snapshots.md`

---

## 12. Summary of Key Design Decisions for Implementation

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Role computation | `computedRole` + fallback table | Leverages browser, handles edge cases |
| Name computation | `computedName` + fallback for known bugs | Leverages browser, patches WebKit bugs |
| Ref generation | Monotonic counter (`e1`, `e2`, ...) | Matches Playwright, simple, predictable |
| Ref persistence | `data-sp-ref` attribute on DOM elements | Survives across JS execution contexts |
| Ref resolution | `document.querySelector('[data-sp-ref="eN"]')` | Simple, reliable selector |
| Output format | YAML matching Playwright's `ai` mode | Drop-in compatible for LLM consumption |
| Shadow DOM | Walk `element.shadowRoot` children | Same approach as Playwright |
| iframes | Frame-prefixed refs (`f1e1`) | Matches Playwright convention |
| Hidden elements | `aria-hidden`, `display:none`, `visibility:hidden` | Standard pruning |
| Incremental diffs | Compare previous snapshot, emit changes only | Token efficiency for MCP |
| Performance | Walk caching, scope limiting, depth limiting, timeout | Handle large pages gracefully |
| Min Safari version | 16.4+ (for `computedRole`/`computedName`) | Released March 2023, reasonable baseline |
