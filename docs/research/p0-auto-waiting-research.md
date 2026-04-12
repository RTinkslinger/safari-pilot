# P0 Research: Auto-Waiting on All Actions

> Research for implementing Playwright-style actionability checks in Safari Pilot.
> Date: 2026-04-12

---

## Table of Contents

1. [Playwright's Auto-Wait Implementation](#1-playwrights-auto-wait-implementation)
2. [Element Actionability in WebKit/Safari](#2-element-actionability-in-webkitsafari)
3. [Stability Detection Strategies](#3-stability-detection-strategies)
4. [Polling vs Observer-Based Approaches](#4-polling-vs-observer-based-approaches)
5. [Error Messages and Recovery Hints](#5-error-messages-and-recovery-hints)
6. [Edge Cases](#6-edge-cases)
7. [Safari Pilot Architecture Constraints](#7-safari-pilot-architecture-constraints)
8. [Implementation Recommendations](#8-implementation-recommendations)

---

## 1. Playwright's Auto-Wait Implementation

### 1.1 Actionability Checks by Action Type

Playwright defines six actionability checks. Each action requires a specific subset:

| Action | Visible | Stable | Receives Events | Enabled | Editable |
|---|---|---|---|---|---|
| `click()` | Yes | Yes | Yes | Yes | -- |
| `dblclick()` | Yes | Yes | Yes | Yes | -- |
| `check()` / `uncheck()` | Yes | Yes | Yes | Yes | -- |
| `tap()` | Yes | Yes | Yes | Yes | -- |
| `hover()` | Yes | Yes | Yes | -- | -- |
| `dragTo()` | Yes | Yes | Yes | -- | -- |
| `fill()` / `clear()` | Yes | -- | -- | Yes | Yes |
| `selectOption()` | Yes | -- | -- | Yes | -- |
| `selectText()` | Yes | -- | -- | -- | -- |
| `screenshot()` | Yes | Yes | -- | -- | -- |
| `press()` | -- | -- | -- | -- | -- |
| `pressSequentially()` | -- | -- | -- | -- | -- |
| `setInputFiles()` | -- | -- | -- | -- | -- |
| `focus()` / `blur()` | -- | -- | -- | -- | -- |
| `dispatchEvent()` | -- | -- | -- | -- | -- |

**Key insight for Safari Pilot:** Click, hover, and drag need the full chain (visible + stable + enabled/receives-events). Fill needs visible + enabled + editable. Select needs visible + enabled. Press/type need nothing (they operate on the focused element).

Source: https://playwright.dev/docs/actionability

### 1.2 Exact Check Definitions

**Visible:** An element is visible when it has a non-empty bounding box AND does not have `visibility:hidden` computed style. Elements with `opacity:0` ARE considered visible (Playwright explicitly does not check opacity). Elements with `display:none` or zero-sized bounding boxes are not visible.

From Playwright source (`domUtils.ts`):
```typescript
function isElementVisible(element: Element): boolean {
  return computeBox(element).visible;
}

function computeBox(element: Element) {
  const style = getElementComputedStyle(element);
  if (!style) return { visible: true, inline: false };
  if (style.display === 'contents') {
    // Check if any child is visible
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && isElementVisible(child as Element))
        return { visible: true, inline: false };
      if (child.nodeType === 3 && isVisibleTextNode(child as Text))
        return { visible: true, inline: true };
    }
    return { visible: false, inline: false };
  }
  if (!isElementStyleVisibilityVisible(element, style))
    return { visible: false, inline: false };
  const rect = element.getBoundingClientRect();
  return { visible: rect.width > 0 && rect.height > 0, inline: style.display === 'inline' };
}
```

The `isElementStyleVisibilityVisible` function uses `checkVisibility()` where available (but NOT in WebKit due to a workaround flag), falling back to manual checks for `<details>` elements without `open` attribute and `visibility !== 'visible'`.

**Stable:** An element is stable when its bounding rect has remained unchanged for at least two consecutive `requestAnimationFrame` callbacks (configurable via `_stableRafCount`, default 2). The check compares `top`, `left`, `width`, `height` from `getBoundingClientRect()`.

From Playwright source (`injectedScript.ts`):
```typescript
private async _checkElementIsStable(node: Node): Promise<'error:notconnected' | boolean> {
  let lastRect: { x: number, y: number, width: number, height: number } | undefined;
  let stableRafCounter = 0;
  let lastTime = 0;

  const check = () => {
    const element = this.retarget(node, 'no-follow-label');
    if (!element) return 'error:notconnected';
    // Drop frames shorter than 16ms (WebKit bug workaround)
    const time = performance.now();
    if (this._stableRafCount > 1 && time - lastTime < 15)
      return continuePolling;
    lastTime = time;
    const clientRect = element.getBoundingClientRect();
    const rect = { x: clientRect.top, y: clientRect.left, width: clientRect.width, height: clientRect.height };
    if (lastRect) {
      const samePosition = rect.x === lastRect.x && rect.y === lastRect.y
        && rect.width === lastRect.width && rect.height === lastRect.height;
      if (!samePosition) return false;  // Reset: not stable
      if (++stableRafCounter >= this._stableRafCount) return true;  // Stable!
    }
    lastRect = rect;
    return continuePolling;
  };
  // ... runs via requestAnimationFrame loop
}
```

Critical details:
- Frames shorter than 15ms are dropped (WebKit bug where double-rAF fires too quickly)
- Exact floating-point comparison on all four rect properties -- no tolerance/epsilon
- If the rect changes at any point, the counter resets to 0 (must be consecutively stable)

**Enabled:** An element is disabled if it is a form control (`<button>`, `<select>`, `<input>`, `<textarea>`, `<option>`, `<optgroup>`) with the `[disabled]` attribute, is inside a disabled `<fieldset>`, or is a descendant of an element with `[aria-disabled=true]`. The `getAriaDisabled()` function walks up the tree checking for `aria-disabled="true"`.

**Editable:** An element is editable when it is enabled AND not readonly. Readonly applies to form inputs with `[readonly]` attribute or elements with `[aria-readonly=true]` that have supporting ARIA roles.

**Receives Events (hit testing):** Playwright checks whether the target element is the topmost element at the intended click point. It uses `elementsFromPoint()` and `elementFromPoint()` to find what's actually under the cursor, then walks up through shadow DOM boundaries to verify the hit target is the intended target or a descendant thereof.

From Playwright source (`injectedScript.ts`):
```typescript
expectHitTarget(hitPoint: { x: number, y: number }, targetElement: Element) {
  // Walk through all shadow roots from outermost to innermost
  const roots: (Document | ShadowRoot)[] = [];
  let parentElement = targetElement;
  while (parentElement) {
    const root = enclosingShadowRootOrDocument(parentElement);
    if (!root) break;
    roots.push(root);
    if (root.nodeType === 9) break;  // Document node
    parentElement = (root as ShadowRoot).host;
  }

  let hitElement: Element | undefined;
  for (let index = roots.length - 1; index >= 0; index--) {
    const elements = roots[index].elementsFromPoint(hitPoint.x, hitPoint.y);
    // ... handles display:contents, shadow hosts
    hitElement = elements[0];
    if (index && hitElement !== (roots[index - 1] as ShadowRoot).host) break;
  }

  // Walk up from hitElement to see if targetElement is an ancestor
  while (hitElement && hitElement !== targetElement) {
    hitElement = hitElement.assignedSlot ?? parentElementOrShadowHost(hitElement);
  }
  if (hitElement === targetElement) return 'done';

  // Element is obscured — return description of what's blocking it
  return { hitTargetDescription: this.previewNode(hitParents[0]) };
}
```

### 1.3 Execution Sequence

For pointer actions (click, hover, drag), the full sequence is:

1. **Iframe scroll** (best-effort to make parent frames visible)
2. **Wait for states** (unless `force: true`): calls `checkElementStates(node, ['visible', 'enabled', 'stable'])` for click, or `['visible', 'stable']` for hover
3. **Scroll into view**: `scrollIntoView()` with progressive fallback options
4. **Calculate click point**: center of element or specified position
5. **Hit target interception**: set up event listener to verify the element receives the pointer event
6. **Execute action**: dispatch mouse events
7. **Verify hit target**: check that the intended element actually received the event
8. **Wait for navigation**: if the action triggered a navigation

### 1.4 Retry Logic

Playwright wraps the entire action in a retry loop with exponential backoff:

```typescript
const waitTime = [0, 20, 100, 100, 500]; // ms between retries
```

On each retry, the scroll strategy also rotates through:
```typescript
const scrollOptions = [
  undefined,                              // Default scroll
  { block: 'end', inline: 'end' },       // Scroll to bottom-right
  { block: 'center', inline: 'center' }, // Scroll to center
  { block: 'start', inline: 'start' },   // Scroll to top-left
];
```

Retryable conditions: `error:notvisible`, `error:notinviewport`, `error:optionsnotfound`, `error:optionnotenabled`, hit target interception failure, missing required state.

Non-retryable with `force: true`: same conditions throw `NonRecoverableDOMError` instead.

### 1.5 Timeout Defaults

- **Playwright library (direct use):** Default action timeout is 0 (no timeout). Test timeout is 30 seconds.
- **Playwright config (`actionTimeout`):** Configurable per-test, per-project, or globally.
- **Playwright MCP plugin (Claude Code):** Uses its own defaults (typically 30 seconds for actions).
- **Safari Pilot recommendation:** 5 seconds is a good default for MCP tool use. The agent can retry at the tool level if needed, and 5s covers most page loads and animations without blocking the agent for too long on truly broken selectors.

### 1.6 The `force` Option

When `force: true`:
- Skips visibility, enabled, and stable checks
- Skips hit target interception
- Failures become non-recoverable exceptions (no retry)
- Still scrolls into view and dispatches events normally

This is useful when the automation knows the element state is correct but Playwright's checks are too conservative (e.g., elements behind transparent overlays, elements that are technically zero-height but still clickable).

---

## 2. Element Actionability in WebKit/Safari

### 2.1 Visibility Detection

**`getBoundingClientRect()`**: Returns the element's position and size relative to the viewport. Available in all Safari versions. A zero-width or zero-height rect indicates the element is not rendered (display:none, or collapsed).

**`getComputedStyle()`**: Returns the resolved CSS values. Check `display`, `visibility`, and `opacity` properties.

**`element.checkVisibility()`**: New API supported in Safari 17.4+ (released March 2024). Returns `false` if the element has no rendering box (display:none, display:contents with no visible children, content-visibility:hidden).

Parameters:
- `opacityProperty: true` -- also returns false if `opacity: 0`
- `visibilityProperty: true` -- also returns false if `visibility: hidden`
- `contentVisibilityAuto: true` -- also returns false if rendering is skipped by `content-visibility: auto`

Without options, `checkVisibility()` only checks for `display:none`, `display:contents` (no visible children), and `content-visibility:hidden`.

**Safari 17.4+ coverage is sufficient** for Safari Pilot since macOS Sonoma ships Safari 17.4+ and older systems are increasingly rare for Claude Code users.

However, Playwright deliberately does NOT use `checkVisibility()` on WebKit (`browserNameForWorkarounds !== 'webkit'`), falling back to manual checks. This suggests there may be edge cases or bugs in WebKit's implementation. For Safari Pilot, we should prefer manual checks with `checkVisibility()` as a supplementary signal.

Source: https://caniuse.com/mdn-api_element_checkvisibility, https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility

### 2.2 Recommended Visibility Check for Safari Pilot

```javascript
function isVisible(el) {
  if (!el || !el.isConnected) return false;

  const style = getComputedStyle(el);

  // display:none or display:contents (check children separately)
  if (style.display === 'none') return false;
  if (style.display === 'contents') {
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && isVisible(child)) return true;
      if (child.nodeType === 3 && child.textContent.trim()) return true;
    }
    return false;
  }

  // visibility:hidden (elements remain in layout but invisible)
  if (style.visibility !== 'visible') return false;

  // Zero-size bounding box
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  return true;
}
```

Note: Like Playwright, we do NOT check `opacity: 0` -- elements at zero opacity are still "visible" for actionability purposes because they still receive events unless `pointer-events: none` is set.

### 2.3 Obscured Element Detection (elementFromPoint)

`document.elementFromPoint(x, y)` returns the topmost element at the given viewport coordinates. Key behaviors in Safari:

- Elements with `pointer-events: none` are skipped (the element beneath is returned)
- For iframes, returns the `<iframe>` element itself (not contents)
- Returns `null` for coordinates outside the viewport
- Respects z-index and stacking contexts
- Does NOT penetrate Shadow DOM boundaries -- returns the shadow host

`document.elementsFromPoint(x, y)` returns ALL elements at the point (ordered from topmost to bottommost). Supported in Safari since version 11.1+.

For Shadow DOM, `shadowRoot.elementFromPoint(x, y)` can be used to check within a shadow tree.

Source: https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint

### 2.4 Viewport Detection

To check if an element is within the viewport:
```javascript
function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}
```

For more precise detection, `IntersectionObserver` with threshold 0 can be used, but it's asynchronous and overkill for a one-shot check. The `getBoundingClientRect()` approach is synchronous and fast.

### 2.5 Disabled State Detection

Three layers to check:

1. **HTML `disabled` attribute**: `el.disabled` (native property on form elements)
2. **`aria-disabled="true"`**: Must walk up the tree -- a child of an `aria-disabled="true"` element is also disabled
3. **CSS `pointer-events: none`**: The element won't receive click events but is not technically "disabled" in the HTML sense
4. **Inside disabled `<fieldset>`**: `el.closest('fieldset:disabled')` catches this

```javascript
function isDisabled(el) {
  // Native disabled (form elements only)
  if ('disabled' in el && el.disabled) return true;

  // Inside disabled fieldset
  if (el.closest('fieldset:disabled') && !el.closest('legend')) return true;

  // aria-disabled on self or ancestor
  let node = el;
  while (node) {
    if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return true;
    node = node.parentElement;
  }

  return false;
}
```

### 2.6 Safari-Specific getBoundingClientRect Quirks

- **CSS transforms**: `getBoundingClientRect()` returns the transformed bounding box (after applying transforms). This is correct for click targeting.
- **Sticky positioning**: Returns the current position (accounting for scroll state). Correct behavior.
- **Flex/Grid layouts**: Returns accurate rects. No known Safari-specific issues.
- **SVG elements**: Safari may return slightly different rects for SVG elements vs Chromium. Use `getBBox()` for SVG-specific measurements if needed.
- **Fixed positioning with nested scrolling**: Rects are always relative to the viewport, which is correct.

---

## 3. Stability Detection Strategies

### 3.1 Playwright's Approach: requestAnimationFrame Polling

Playwright measures the bounding rect on two consecutive animation frames. If both rects match exactly, the element is considered stable.

Key implementation details:
- Uses `requestAnimationFrame` (not `setInterval`) for frame-aligned checks
- Drops frames shorter than 15ms (WebKit-specific workaround for double-rAF firing too quickly)
- Default `_stableRafCount = 2` (configurable, but 2 is the default)
- Exact comparison of `top`, `left`, `width`, `height` -- no tolerance/epsilon
- If the rect changes at any point during the check, the counter resets

### 3.2 Performance Implications of rAF-Based Polling in Safari

`requestAnimationFrame` fires at the display refresh rate (typically 60Hz = ~16.67ms per frame). For stability checks:
- 2 frames = ~33ms minimum to confirm stability
- CPU cost is minimal -- one `getBoundingClientRect()` call per frame
- `getBoundingClientRect()` is a layout-triggering API, but the browser caches layout results until something changes, so reads are cheap when nothing has mutated

**Critical constraint for Safari Pilot:** The AppleScript engine executes JS synchronously via `osascript` -- each `executeJsInTab()` call is a separate process spawn. We cannot maintain a `requestAnimationFrame` loop across multiple calls. The entire stability check (including the rAF loop) must execute within a single JS invocation.

This is achievable: inject a self-contained JS function that runs the rAF loop internally and returns a Promise (which AppleScript's `do JavaScript` will await).

### 3.3 Observer APIs: When to Use Each

| Observer | Detects | Use For | Safari Support |
|---|---|---|---|
| `MutationObserver` | DOM mutations (attribute changes, child additions/removals, text changes) | Waiting for element to appear/disappear in DOM | Safari 7+ |
| `IntersectionObserver` | Element entering/leaving viewport or ancestor scroll container | Viewport visibility changes | Safari 12.1+ |
| `ResizeObserver` | Element size changes | Detecting layout shifts | Safari 13.1+ |

For auto-waiting, the most useful is `MutationObserver` for detecting when a target element appears in the DOM. However, for the single-invocation model we need, observers add complexity. Polling is simpler and more predictable.

### 3.4 getAnimations() API for Animation Detection

`Element.getAnimations()` returns an array of `Animation` objects currently targeting the element. Available in Safari since July 2020 (Safari 13.1+).

```javascript
// Check if element has running animations
const animations = el.getAnimations();
const isAnimating = animations.some(a => a.playState === 'running');

// Wait for all animations to finish
await Promise.all(el.getAnimations().map(a => a.finished));
```

This is useful for a more sophisticated stability check: instead of just comparing rects, we can also check if the element has no running animations. However, Playwright does NOT do this -- it relies purely on rect comparison, which naturally catches animations that move/resize the element.

**Recommendation for Safari Pilot:** Use the rect-comparison approach like Playwright. It's simpler and more reliable than tracking animation state. An element can be animating (e.g., color transition) while remaining stable in position/size -- we should not block on non-movement animations.

### 3.5 Elements That Are Animating But Actionable

A button that's fading in (opacity transition) is actionable as soon as it's visible (non-zero bounding rect) and stable (not moving). The opacity animation doesn't affect actionability. Similarly, color transitions, box-shadow transitions, and background transitions don't affect position/size.

Playwright's approach handles this correctly: rect-based stability only blocks on movement/resize animations, not visual-only transitions.

---

## 4. Polling vs Observer-Based Approaches

### 4.1 Playwright's Internal Polling

Playwright uses `requestAnimationFrame` for stability checks and a different mechanism for element state polling. The `checkElementStates()` method runs in a single evaluation -- it first checks stability (via rAF loop), then checks other states synchronously. If any state fails, it returns immediately and the server-side retry loop handles re-checking.

There is no continuous poll loop on the browser side. Instead:
1. Server calls `checkElementStates()` in the page
2. The injected function runs a rAF loop for stability, then checks other states
3. Returns result to server
4. Server retries with backoff: `[0, 20, 100, 100, 500]` ms

### 4.2 MutationObserver for DOM Changes

Pros:
- Zero CPU when nothing changes (event-driven, not polling)
- Immediate notification when the DOM mutates
- Can detect element addition/removal precisely

Cons:
- More complex to set up and tear down
- Doesn't detect visibility changes from CSS (only DOM mutations)
- Doesn't detect position/size changes
- Can fire too frequently on busy pages (many irrelevant mutations)

### 4.3 Recommended Hybrid Approach for Safari Pilot

Given Safari Pilot's single-invocation execution model (each tool call is one JS execution), the optimal strategy is:

**Within a single JS invocation:**
1. Check if element exists (`querySelector`)
2. If exists, check visibility (computed style + bounding rect)
3. If visible, check stability (2 rAF frames comparing rects)
4. If stable, check enabled/editable as required
5. If all pass, execute the action
6. Return result

**From the Node.js side (retry loop):**
If the initial invocation fails any check, use the existing `sleep + retry` pattern (like `wait.ts` already does) with backoff timing.

This avoids the complexity of observers while maintaining the Playwright behavior. The key insight: the Node.js-side retry loop serves the same role as Playwright's server-side retry loop, and the in-page rAF stability check serves the same role as Playwright's `_checkElementIsStable`.

### 4.4 Performance Cost Comparison

| Approach | CPU/frame | Latency | Complexity |
|---|---|---|---|
| rAF polling (2 frames) | ~0.1ms per `getBoundingClientRect()` call | ~33ms | Low |
| setInterval 50ms | ~0.1ms per check | 50-100ms | Low |
| setInterval 100ms | ~0.1ms per check | 100-200ms | Low |
| MutationObserver + rAF | ~0ms idle, ~0.1ms on change | Variable | High |

For Safari Pilot's use case, the rAF approach adds ~33ms to each action (2 frames at 60Hz). This is negligible compared to the AppleScript execution overhead (~5-50ms per osascript spawn).

---

## 5. Error Messages and Recovery Hints

### 5.1 Playwright's Error Information

When actionability times out, Playwright provides:

1. **The specific failed check**: "element is not visible", "element is not enabled", "element is not stable"
2. **The element description**: A serialized preview of the element (tag, id, class, text content)
3. **Hit target description**: When another element intercepts pointer events, Playwright names the intercepting element: `"<div class='overlay'> intercepts pointer events"`
4. **Action context**: Which action was being attempted ("attempting click action")
5. **Retry history**: Log entries showing each retry attempt and why it failed

### 5.2 Playwright's Error Classification

| Error | Meaning | Retryable |
|---|---|---|
| `error:notconnected` | Element detached from DOM | Yes (re-query) |
| `error:notvisible` | Element has no bounding box or visibility:hidden | Yes (may appear) |
| `error:notinviewport` | Element outside viewport bounds | Yes (scroll) |
| `{ missingState: 'visible' }` | Not visible | Yes |
| `{ missingState: 'enabled' }` | Disabled | Yes |
| `{ missingState: 'stable' }` | Still moving | Yes |
| `{ missingState: 'editable' }` | Readonly or disabled | Yes |
| `{ hitTargetDescription: ... }` | Another element blocks it | Yes |
| `error:optionsnotfound` | Select option doesn't exist | Yes |

### 5.3 Recommended Error Messages for Safari Pilot

For an AI agent (Claude), error messages need to be:
1. **Diagnostic**: What exactly went wrong
2. **Actionable**: What the agent can try instead
3. **Contextual**: Include selector, element state, timing info

Proposed error format:
```json
{
  "error": "ELEMENT_NOT_ACTIONABLE",
  "reason": "not_visible",
  "message": "Element matching '#submit-btn' exists but is not visible (display: none)",
  "selector": "#submit-btn",
  "elementInfo": {
    "tagName": "BUTTON",
    "id": "submit-btn",
    "display": "none",
    "visibility": "visible",
    "boundingRect": { "width": 0, "height": 0, "top": 0, "left": 0 }
  },
  "waitedMs": 5000,
  "hints": [
    "The element has display:none. It may be inside a hidden container or waiting for a user action to show it.",
    "Try: safari_wait_for with condition 'selector' and value '#submit-btn:not([style*=\"display: none\"])' before this action.",
    "Or check if there's a different element that triggers showing this one."
  ]
}
```

### 5.4 Hint Taxonomy for Agent Recovery

| Reason | Hints |
|---|---|
| `not_found` | "Element does not exist in the DOM. Check if the page has loaded, or if the selector is correct. Try safari_snapshot to see current page structure." |
| `not_visible` | "Element exists but is not visible (display:none or visibility:hidden or zero-size). It may appear after scrolling, clicking a tab, or waiting for content to load." |
| `not_enabled` | "Element is disabled. It may become enabled after filling required fields or completing a previous step in a form." |
| `not_editable` | "Element has readonly attribute. It may not accept direct input. Check if there's a different input mechanism." |
| `not_stable` | "Element is still moving (animating or transitioning). Wait longer or check if a page transition is in progress." |
| `obscured` | "Element is behind another element (e.g., modal, overlay, cookie banner). Close the overlay first, or use a more specific selector." |
| `outside_viewport` | "Element is outside the visible viewport. It should have been auto-scrolled, but scrolling may have failed. Try safari_scroll first." |

---

## 6. Edge Cases

### 6.1 Special Element Types

**`<select>` elements:** Playwright checks `visible` and `enabled` but NOT `stable` or `receives-events` for `selectOption()`. This is because select dropdowns are handled via the `<select>` element's value property, not via click simulation. Safari Pilot's current `handleSelectOption` already sets the value directly -- just add visible + enabled checks.

**`contenteditable` elements:** Treated like form inputs for editability. Check `contentEditable === 'true'` (or inherited). For `fill()`, these need special handling: clear via `selectAll + delete`, then insert text.

**File inputs (`<input type="file">`):** Playwright's `setInputFiles()` requires NO actionability checks (see table above). File inputs are typically hidden and programmatically controlled. Safari Pilot should skip all checks for file input tools.

**Date pickers (`<input type="date">`):** These are native OS-level controls in Safari. The `fill()` method should set the value property directly and dispatch change events, bypassing the native picker UI. Actionability checks (visible + enabled + editable) still apply.

### 6.2 Shadow DOM

Safari Pilot already has shadow DOM support via the extension engine. For auto-waiting:

- `querySelector()` does NOT cross shadow boundaries. Use `el.shadowRoot.querySelector()` for open shadow DOMs.
- `elementFromPoint()` returns the shadow host, not internal elements. Use `shadowRoot.elementFromPoint()` to check hit targets within shadows.
- Stability and visibility checks work the same -- `getBoundingClientRect()` and `getComputedStyle()` work on shadow DOM elements.
- Playwright walks up through shadow roots in its `expectHitTarget()` function, checking `elementsFromPoint()` at each shadow boundary.

### 6.3 iframes

- `document.elementFromPoint()` returns the `<iframe>` element, not its contents.
- To check actionability inside an iframe, execute JS in the iframe's context separately.
- Safari Pilot's current iframe tools (`src/tools/frames.ts`) already handle cross-frame execution.
- For auto-waiting on iframe contents, the check should run inside the iframe document.

### 6.4 Navigation-Triggering Actions

Playwright handles this with `waitForSignalsCreatedBy()` -- it wraps the action in a navigation listener. If a click triggers navigation:
1. The click succeeds
2. Playwright waits for the navigation to complete (unless `noWaitAfter: true`)

Safari Pilot already has `waitForNavigation` as an option on `safari_click`. The auto-wait change should preserve this: auto-wait checks happen BEFORE the action, navigation waiting happens AFTER.

### 6.5 Lazy-Loaded Elements

Elements not yet in the DOM (e.g., infinite scroll, lazy-loaded components) cannot be found by `querySelector()`. The auto-wait should return `not_found` after the timeout, with a hint suggesting the agent scroll down or trigger the lazy load.

This is consistent with Playwright's behavior -- auto-wait only waits for elements that EXIST to become actionable. For elements that don't exist yet, the locator resolution fails and the entire action retries.

### 6.6 Detached/Re-added Elements

If an element is removed and re-added to the DOM during the wait:
- The `querySelector()` on each retry will find the new element
- All checks run fresh on the new element
- This is correct behavior -- the new element may have different state

### 6.7 The `force` Option

Safari Pilot should support a `force` option on all interaction tools. When set:
- Skip all actionability checks (visible, enabled, stable, hit target)
- Execute the action immediately on whatever `querySelector()` returns
- Still throw if the element doesn't exist at all

Use cases: clicking invisible elements (e.g., hidden form submits), interacting with elements behind transparent overlays the agent knows about, bypassing false-positive stability failures.

---

## 7. Safari Pilot Architecture Constraints

### 7.1 Execution Model

Safari Pilot has three engine tiers:
1. **AppleScript engine**: Spawns `osascript` process per JS execution. Each call is independent -- no persistent JS context.
2. **Daemon engine**: Uses a persistent Swift daemon for faster execution (~1ms p50). JS execution still goes through AppleScript's `do JavaScript`.
3. **Extension engine**: Routes through the Safari Web Extension. Can execute in MAIN world with persistent context.

**Key constraint:** With the AppleScript/daemon engines, each `executeJsInTab()` call is a standalone JS execution. There's no way to maintain state between calls (no globals persist reliably).

**However:** Within a single call, `async/await` and Promises work. The Safari `do JavaScript` command WILL wait for a Promise to resolve before returning. This means:

```javascript
// This works -- do JavaScript waits for the Promise
(async function() {
  await new Promise(resolve => {
    let lastRect;
    let stableCount = 0;
    function check() {
      const rect = el.getBoundingClientRect();
      if (lastRect && rect.top === lastRect.top && rect.left === lastRect.left
          && rect.width === lastRect.width && rect.height === lastRect.height) {
        if (++stableCount >= 2) { resolve(); return; }
      } else {
        stableCount = 0;
      }
      lastRect = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  });
  // ... execute action
})();
```

**IMPORTANT VERIFICATION NEEDED:** Confirm that Safari's `do JavaScript` blocks on async functions and Promises. If it doesn't (returns immediately with "[object Promise]"), the stability check must be reimplemented as a synchronous polling loop using a busy-wait or setTimeout-based approach with a completion callback.

### 7.2 Current Interaction Tool Pattern

Each handler in `interaction.ts` currently:
1. Builds a JS string with the selector and action
2. Calls `this.engine.executeJsInTab(tabUrl, js, timeout)`
3. Parses the result
4. Returns a `ToolResponse`

The auto-wait logic should be injected INTO the JS string, before the action code. This keeps the change self-contained -- no new tool calls needed, no multi-step orchestration.

### 7.3 Timeout Architecture

The existing `timeout` parameter on each tool specifies the osascript process timeout. The auto-wait timeout should fit WITHIN this limit:
- Tool timeout (default 5000ms for most tools, 10000ms for fill): overall limit
- Auto-wait timeout: should be `toolTimeout - 500ms` to leave room for action execution
- Each rAF check: ~16ms
- The polling loop within JS should have its own deadline to avoid blocking osascript past the timeout

---

## 8. Implementation Recommendations

### 8.1 Architecture Decision: In-JS Wait vs Node.js Retry Loop

**Option A: All-in-one JS (recommended for Safari Pilot)**
- Inject the full wait + action into a single JS string
- The JS runs the rAF stability check, visibility check, etc. internally
- One round-trip to Safari per tool call (same as today)
- Timeout managed within the JS via `Date.now()` deadline

**Option B: Node.js retry loop (like current wait.ts)**
- Execute visibility check JS, get result, sleep, retry from Node.js
- Multiple round-trips per tool call (expensive with AppleScript overhead)
- More flexible but much slower

**Option A is clearly superior** for Safari Pilot because:
- Minimizes round-trips (the biggest latency cost)
- Keeps stability checking frame-aligned (rAF can't work across separate osascript calls)
- Simpler control flow in the TypeScript handlers

### 8.2 Proposed `waitForActionable()` JS Function

A single injectable JS function that all interaction tools use:

```javascript
async function waitForActionable(selector, options) {
  const { timeout = 5000, checks = ['visible', 'enabled', 'stable'],
          force = false } = options;
  const deadline = Date.now() + timeout;

  if (force) {
    const el = document.querySelector(selector);
    if (!el) throw { name: 'ELEMENT_NOT_FOUND', message: `No element found: ${selector}` };
    return el;
  }

  // Phase 1: Wait for element to exist in DOM
  let el;
  while (!el) {
    el = document.querySelector(selector);
    if (el) break;
    if (Date.now() > deadline) throw { name: 'ELEMENT_NOT_FOUND',
      message: `Element not found within ${timeout}ms: ${selector}` };
    await new Promise(r => setTimeout(r, 100));
  }

  // Phase 2: Wait for visibility
  if (checks.includes('visible')) {
    while (true) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display !== 'none' && style.visibility === 'visible'
          && rect.width > 0 && rect.height > 0) break;
      if (Date.now() > deadline) throw { name: 'ELEMENT_NOT_VISIBLE',
        message: `Element not visible: ${selector}`,
        details: { display: style.display, visibility: style.visibility,
                   width: rect.width, height: rect.height } };
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Phase 3: Wait for stability (2 consecutive rAF frames with same rect)
  if (checks.includes('stable')) {
    await new Promise((resolve, reject) => {
      let lastRect, stableCount = 0, lastTime = 0;
      function check() {
        if (Date.now() > deadline) {
          reject({ name: 'ELEMENT_NOT_STABLE',
            message: `Element not stable within ${timeout}ms: ${selector}` });
          return;
        }
        const time = performance.now();
        if (time - lastTime < 15) { requestAnimationFrame(check); return; }
        lastTime = time;
        const r = el.getBoundingClientRect();
        const rect = { t: r.top, l: r.left, w: r.width, h: r.height };
        if (lastRect && rect.t === lastRect.t && rect.l === lastRect.l
            && rect.w === lastRect.w && rect.h === lastRect.h) {
          if (++stableCount >= 2) { resolve(); return; }
        } else { stableCount = 0; }
        lastRect = rect;
        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    });
  }

  // Phase 4: Check enabled
  if (checks.includes('enabled')) {
    if (el.disabled || el.closest('fieldset:disabled')) {
      throw { name: 'ELEMENT_NOT_ENABLED', message: `Element is disabled: ${selector}` };
    }
    let node = el;
    while (node) {
      if (node.getAttribute && node.getAttribute('aria-disabled') === 'true')
        throw { name: 'ELEMENT_NOT_ENABLED', message: `Element is aria-disabled: ${selector}` };
      node = node.parentElement;
    }
  }

  // Phase 5: Check editable
  if (checks.includes('editable')) {
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true')
      throw { name: 'ELEMENT_NOT_EDITABLE', message: `Element is readonly: ${selector}` };
  }

  // Phase 6: Check hit target (not obscured)
  if (checks.includes('receivesEvents')) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hitEl = document.elementFromPoint(cx, cy);
    if (hitEl !== el && !el.contains(hitEl)) {
      const desc = hitEl ? `<${hitEl.tagName.toLowerCase()}${hitEl.id ? '#'+hitEl.id : ''}${hitEl.className ? '.'+hitEl.className.split(' ')[0] : ''}>` : 'unknown';
      throw { name: 'ELEMENT_OBSCURED',
        message: `Element obscured by ${desc}: ${selector}`,
        obscuredBy: desc };
    }
  }

  return el;
}
```

### 8.3 Per-Tool Check Configuration

Based on Playwright's table, map Safari Pilot tools to checks:

```typescript
const TOOL_CHECKS: Record<string, string[]> = {
  safari_click:         ['visible', 'stable', 'enabled', 'receivesEvents'],
  safari_double_click:  ['visible', 'stable', 'enabled', 'receivesEvents'],
  safari_fill:          ['visible', 'enabled', 'editable'],
  safari_select_option: ['visible', 'enabled'],
  safari_check:         ['visible', 'stable', 'enabled', 'receivesEvents'],
  safari_hover:         ['visible', 'stable', 'receivesEvents'],
  safari_type:          ['visible', 'enabled', 'editable'],
  safari_drag:          ['visible', 'stable', 'receivesEvents'],
  safari_scroll:        [],  // No checks needed
  safari_press_key:     [],  // No checks needed (operates on focused element)
};
```

Note: `safari_type` should check `visible + enabled + editable` since it targets a specific element and types into it. `safari_press_key` operates on the focused element and shouldn't check actionability.

### 8.4 Schema Changes

Each interaction tool should get an optional `force` parameter:
```typescript
force: {
  type: 'boolean',
  default: false,
  description: 'Skip actionability checks (visible, enabled, stable). Use when you know the element state is correct but checks fail.',
}
```

The existing `timeout` parameter already exists on most tools -- it should control both the auto-wait timeout and the osascript process timeout.

### 8.5 Backward Compatibility

This is a **behavior change**, not a new tool. Current tools that fail immediately on invisible/disabled elements will now auto-wait up to `timeout` ms before failing. This is strictly better for MCP tool users (fewer timing bugs, fewer manual `safari_wait_for` calls).

The `safari_wait_for` tool should remain -- it serves different use cases (waiting for text to appear, URL to change, network idle, custom conditions). Auto-waiting only covers actionability checks for interaction tools.

### 8.6 Implementation Order

1. **Create `actionability.ts`** -- the shared `waitForActionable()` JS builder function
2. **Update `interaction.ts`** -- inject auto-wait JS before each action's JS
3. **Add `force` param** to all interaction tool schemas
4. **Update error handling** -- parse actionability errors into structured `ToolError` with hints
5. **Test** against real pages with animations, overlays, disabled elements

### 8.7 Trial Mode for Pre-Flight Checks

Playwright supports a `trial: true` option that runs all actionability checks without executing the action. This is valuable for AI agents that want to "look before they leap" -- verify an element is ready without triggering side effects.

Safari Pilot should add a `trial` option to all interaction tools. When `trial: true`:
- Run all actionability checks (visibility, stability, enabled, etc.)
- Return the check results (pass/fail per check, element info) without executing the action
- The agent can use this to confirm targeting before committing

### 8.8 Floating-Point Precision in Stability Checks

Playwright uses exact floating-point comparison for bounding rect stability. The deep research suggests using an epsilon for sub-pixel rendering differences. However, examining the actual source code, Playwright does NOT use epsilon -- it requires exact match. This is intentional: sub-pixel differences indicate the element is still settling.

**Recommendation:** Follow Playwright's exact-match approach. If this causes false instability in Safari (which would manifest as elements never reaching "stable"), we can add a small epsilon (e.g., 0.5px) as a learned workaround. Start strict, relax if needed.

### 8.9 Open Questions for Implementation

1. **Does Safari's `do JavaScript` await Promises?** If not, the rAF stability check needs a different approach (busy-wait polling with `Date.now()` comparisons instead of rAF). This MUST be verified before implementation.

2. **Should auto-wait also scroll into view?** Playwright does this. Adding `el.scrollIntoView({ block: 'center', behavior: 'instant' })` before the hit-target check would be beneficial. Playwright even rotates scroll strategies on retry (`end/end`, `center/center`, `start/start`).

3. **Should the `receivesEvents` check be default-on or default-off?** It adds complexity (Shadow DOM traversal) and can false-positive on legitimate transparent overlays. Playwright makes it mandatory for pointer actions. We should match that behavior for parity, but provide `force: true` as the escape hatch.

4. **How should timeout interact between auto-wait and AppleScript process timeout?** The JS-internal deadline should be `timeout - 200ms` to leave headroom for the osascript wrapper.

5. **Should we expose `pointer-events: none` as a separate disabled state?** Playwright checks it implicitly via the hit-target test. An element with `pointer-events: none` will fail the "receives events" check, not the "enabled" check. This distinction matters for error messages.

---

## Sources

### Primary (Playwright Source Code)
- Playwright `injectedScript.ts` (actionability core): `packages/injected/src/injectedScript.ts` in https://github.com/microsoft/playwright
- Playwright `domUtils.ts` (visibility/DOM helpers): `packages/injected/src/domUtils.ts` in https://github.com/microsoft/playwright
- Playwright `dom.ts` (action orchestration, retry loop): `packages/playwright-core/src/server/dom.ts` in https://github.com/microsoft/playwright

### Playwright Documentation
- Actionability checks: https://playwright.dev/docs/actionability
- locator.click() API: https://playwright.dev/docs/api/class-locator#locator-click
- Timeout configuration: https://playwright.dev/docs/test-timeouts

### Web Platform APIs (MDN)
- Element.checkVisibility(): https://developer.mozilla.org/en-US/docs/Web/API/Element/checkVisibility
- document.elementFromPoint(): https://developer.mozilla.org/en-US/docs/Web/API/Document/elementFromPoint
- Element.getAnimations(): https://developer.mozilla.org/en-US/docs/Web/API/Element/getAnimations
- IntersectionObserver: https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver
- MutationObserver: https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver

### Browser Compatibility
- checkVisibility() support: https://caniuse.com/mdn-api_element_checkvisibility (Safari 17.4+)
- Safari 17.4 release notes: https://webkit.org/blog/15419/webkit-features-in-safari-17-4/

### Supplementary Research
- Parallel Deep Research report: `docs/research/playwright-auto-wait-deep-research.md` (comprehensive multi-source analysis confirming findings above)
