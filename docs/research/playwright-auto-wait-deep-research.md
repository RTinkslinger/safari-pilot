# Executive Summary

Implementing Playwright-style actionability checks for Safari automation involves creating a robust pre-action validation system that ensures elements are ready for interaction. This system, known as 'auto-waiting', prevents common test flakiness by performing a series of checks before executing actions like clicks or fills. The core concept is to verify that a target element is not only present in the DOM but also visible, stable (not animating), enabled, editable (if applicable), and not obscured by other elements. For each action, Playwright defines a specific set of required checks; for instance, a `click` requires the element to be visible, stable, enabled, and able to receive pointer events. The primary challenge is replicating these checks reliably in Safari using standard Web APIs. Key strategies involve using `getBoundingClientRect` and `getComputedStyle` to determine visibility, with the modern `element.checkVisibility()` API offering a more direct method in Safari 17.4 and later. Stability is best detected by comparing an element's bounding box across two consecutive `requestAnimationFrame` callbacks. Obscuration is handled by using `document.elementFromPoint()` at the intended interaction coordinate to ensure the target element is the topmost one. The implementation must also handle scrolling elements into view, managing timeouts gracefully, and providing detailed error messages that distinguish between different failure modes (e.g., not visible vs. obscured vs. disabled) to aid in debugging and potential self-correction by an AI agent.

# Playwright Auto Wait Implementation

Playwright's auto-wait mechanism is a core feature that ensures actions behave as expected by performing a series of actionability checks before execution. It automatically waits for all relevant checks to pass for a given action. If the checks do not pass within the specified timeout, the action fails with a `TimeoutError`. The process generally follows a specific sequence of checks before an action is performed.

1.  **Attached/Singular Element Resolution**: This is a fundamental precondition. The locator must resolve to exactly one element that is attached to the DOM. If the locator resolves to zero or multiple elements, the action will fail.

2.  **Visible**: The element is considered visible if it has a non-empty bounding box and does not have the `visibility: hidden` computed style. Notably, elements with `display: none` are not considered visible, but elements with `opacity: 0` are.

3.  **Stable**: This check ensures the element is not animating. An element is considered stable when its bounding box has remained unchanged for at least two consecutive animation frames. This mechanism effectively handles CSS animations and transitions that affect an element's geometry by deferring the action until the movement stops.

4.  **Receives Events**: This check verifies that the element is not obscured by other elements and can be the target of pointer events. Playwright performs a hit test at the action point (e.g., the center for a click) to see which element would receive the event. If an overlay or another element is on top, this check fails, and Playwright waits until the target element is unobstructed.

5.  **Enabled**: The element must be enabled. This typically means it does not have the `disabled` attribute. This check is relevant for form controls and buttons.

6.  **Editable**: This check applies to actions like `fill()` and `clear()`. The element must be an `<input>`, `<textarea>`, or have the `contenteditable` attribute, and it must not be `readonly`.

**Scrolling and Timeouts:**
- **Scrolling**: Before performing actions, Playwright automatically scrolls the element into view if it's not already visible. The `locator.scrollIntoViewIfNeeded()` method specifically uses logic similar to `IntersectionObserver`'s `ratio` to determine if scrolling is necessary.
- **Timeouts**: Timeouts can be configured at multiple levels. An individual action can have a `timeout` option (in milliseconds), which defaults to `0` (no specific timeout for that call). A default for all actions can be set via the `actionTimeout` option in the configuration file or programmatically using `browserContext.setDefaultTimeout()` or `page.setDefaultTimeout()`. In the context of Playwright Test, there is also an overall test timeout, which defaults to 30 seconds.

# Playwright Actionability Check Matrix

## Action

locator.click()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

True

## Requires Editable

False

## Action

locator.dblclick()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

True

## Requires Editable

False

## Action

locator.check()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

True

## Requires Editable

False

## Action

locator.uncheck()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

True

## Requires Editable

False

## Action

locator.tap()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

True

## Requires Editable

False

## Action

locator.hover()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

False

## Requires Editable

False

## Action

locator.dragTo()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

True

## Requires Enabled

False

## Requires Editable

False

## Action

locator.screenshot()

## Requires Visible

True

## Requires Stable

True

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.fill()

## Requires Visible

True

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

True

## Requires Editable

True

## Action

locator.clear()

## Requires Visible

True

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

True

## Requires Editable

True

## Action

locator.selectOption()

## Requires Visible

True

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

True

## Requires Editable

False

## Action

locator.selectText()

## Requires Visible

True

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.scrollIntoViewIfNeeded()

## Requires Visible

False

## Requires Stable

True

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.blur()

## Requires Visible

False

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.focus()

## Requires Visible

False

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.press()

## Requires Visible

False

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.dispatchEvent()

## Requires Visible

False

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False

## Action

locator.setInputFiles()

## Requires Visible

False

## Requires Stable

False

## Requires Receives Events

False

## Requires Enabled

False

## Requires Editable

False


# Playwright Stability And Timeout Details

## Stability Definition

Playwright considers an element 'stable' when it is not animating or has completed its animation. This is determined by checking if the element has maintained the same bounding box for a specific duration.

## Stability Check Logic

The technical implementation for the stability check involves ensuring the element's bounding box has remained unchanged for at least two consecutive animation frames. This check is performed using a mechanism tied to `requestAnimationFrame` to align with the browser's rendering cycle, effectively waiting for CSS transitions or animations that affect geometry to complete.

## Default Test Timeout Ms

30000.0

## Action Timeout Ms

0.0

## Timeout Configurability

Timeouts in Playwright can be configured at multiple levels. A global test timeout (defaulting to 30 seconds) applies to the entire test execution. A separate action timeout can be set globally in the configuration file via the `actionTimeout` option. This can be overridden for a specific browser context or page using `browserContext.setDefaultTimeout()` or `page.setDefaultTimeout()`. Finally, individual action calls can specify their own `timeout` in milliseconds, which takes the highest precedence. A timeout value of 0 disables the timeout for that specific action.


# Playwright Obscurity And Scrolling Logic

## Obscurity Check Description

Playwright performs a 'receives events' check to verify that an element is not obscured by other elements. It ensures that the element is the hit target of the pointer event at the specific action point (e.g., the center for a click). If another element, such as a modal overlay, would intercept the event, the check fails, and Playwright waits until the target element is clear.

## Obscurity Check Mechanism

The underlying mechanism for the obscurity check involves performing a hit test at the action coordinates. Playwright effectively asks the browser engine what element is at that point. This is equivalent to using `document.elementFromPoint(x, y)` to identify the topmost element at the action coordinates and verifying it is the intended target or one of its descendants.

## Scrolling Behavior

Before performing an action like a click or fill, Playwright automatically scrolls the element into view if it is not already. The dedicated `locator.scrollIntoViewIfNeeded()` method formalizes this by first waiting for actionability checks and then scrolling the element into view only if it is not already completely visible.

## Scrolling Api Used

The likely underlying browser API used for scrolling is `element.scrollIntoViewIfNeeded()` or a similar method like `element.scrollIntoView()`. To determine if scrolling is necessary, Playwright leverages the logic of the `IntersectionObserver` API, checking the element's intersection `ratio` with the viewport to decide if it's fully visible.


# Playwright Internal Polling Mechanism

Playwright employs a sophisticated polling strategy that prioritizes efficiency and alignment with the browser's rendering cycle, rather than using a fixed-interval timer like `setInterval`. The core of its stability check mechanism is built around `requestAnimationFrame` (rAF).

When Playwright needs to check if an element is 'stable' (i.e., has stopped moving or animating), it does not poll every X milliseconds. Instead, it samples the element's bounding box on each animation frame, requested via `rAF`. An element is officially considered 'stable' only after its bounding box has remained identical for at least two consecutive animation frames. This approach has several advantages:

1.  **Efficiency**: `requestAnimationFrame` is the browser's native mechanism for running code just before the next repaint. This means checks are perfectly synchronized with the browser's rendering engine, avoiding the performance overhead and potential for layout thrashing that can come from arbitrary `setInterval` timers. It also means no unnecessary CPU wakeups, especially for background tabs.

2.  **Effective Polling Interval**: The 'polling interval' for stability is effectively the refresh rate of the display. For a standard 60Hz monitor, this is approximately 16.7 milliseconds. This allows Playwright to detect stability with high precision and low latency, reacting as soon as an animation has visually completed.

For other actionability checks like visibility, enablement, or whether the element receives events, the evaluation occurs within the same auto-waiting loop. If an action is waiting for an element to become stable, these other checks are re-evaluated as part of the retry process until all necessary conditions for the action are met or the overall action timeout expires. While the exact implementation of the internal `InjectedScript.poll()` function is not detailed in public documentation, its behavior is to repeatedly execute these actionability checks until they all pass.

# Webkit Safari Actionability Detection

To determine an element's actionability in WebKit/Safari using native JavaScript, a series of checks analogous to Playwright's can be implemented. These checks cover visibility, disabled state, and whether the element is obscured.

**1. Determining Visibility:**
A multi-faceted approach is required:
- **Bounding Box:** Use `element.getBoundingClientRect()` to get the element's size and position. An element is generally not considered visible if its bounding box has zero width or height. Playwright considers an element visible if it has a non-empty bounding box.
- **Computed Styles:** Use `window.getComputedStyle(element)` to check CSS properties. An element is not visible if its `display` property is `none` or its `visibility` property is `hidden`. Notably, Playwright considers elements with `opacity: 0` to be visible, so this check should be excluded if mirroring that behavior.

**2. Detecting Disabled State:**
Several factors determine if an element is enabled:
- **HTML `disabled` Attribute:** For form controls like `<button>`, `<input>`, and `<select>`, the presence of the `disabled` attribute makes them non-interactive. You can check this with `element.disabled`.
- **`aria-disabled` Attribute:** The `aria-disabled="true"` attribute signals non-interactive intent to assistive technologies but does not natively disable the element. For automation purposes, it's a common practice to treat these elements as disabled.
- **CSS `pointer-events` Property:** If an element or one of its ancestors has `pointer-events: none`, it cannot be the target of pointer events, effectively making it non-actionable for clicks or hovers. This can be checked via `getComputedStyle(element).pointerEvents`.

**3. Detecting Obscurity ('Receives Events' Check):**
To ensure an element is not obscured by another (like a modal or overlay), you can simulate a hit test:
- **`document.elementFromPoint(x, y)`:** This method returns the topmost element at a specific coordinate. By providing the coordinates of the target element's action point (e.g., its center), you can check if the returned element is the target element itself or a descendant of it. If another element is returned, the target is obscured.
- **`document.elementsFromPoint(x, y)`:** This is a more robust alternative that returns an array of all elements at the given coordinates, ordered from topmost to bottommost. This can help identify the obscuring element for better error reporting.

**4. Checking Viewport Status:**
To determine if an element is scrolled out of view, you can:
- **Compare Bounding Rect to Viewport:** Compare the result of `element.getBoundingClientRect()` with the viewport dimensions (`window.innerWidth` and `window.innerHeight`).
- **Use `IntersectionObserver`:** This API is designed to asynchronously observe changes in an element's intersection with the viewport, providing a reliable way to know if an element is on-screen.

**5. Safari-Specific Quirks:**
When using `getBoundingClientRect`, be aware of historical issues in older Safari versions. For example, Safari 26 release notes mention fixes for inconsistent decimal values for sticky elements and issues with scroll-compensation transforms. When automating older versions, these quirks may require workarounds or tolerance in position comparisons.

# Safari Api Support For Actionability

Safari has added support for modern web APIs that are highly relevant for determining element actionability, most notably the `element.checkVisibility()` method.

**`element.checkVisibility()` Support in Safari:**
- **Supported Version:** Full support for `element.checkVisibility()` was added in **Safari 17.4**, as confirmed by the Safari 17.4 release notes. The feature was available in Safari Technology Preview builds prior to its stable release.
- **Functionality:** This method provides a standardized, browser-native way to check if an element is visible to the user. It consolidates several checks (e.g., display, visibility, on-screen status) into a single boolean-returning function call, simplifying what would otherwise require multiple manual JavaScript checks.

**Parameters for `checkVisibility()`:**
The method accepts an optional options object to customize the visibility checks. According to MDN documentation referenced in the source, these options include:
- **`checkOpacity`**: A boolean that, if set to `true`, will cause the method to return `false` if the element has a computed `opacity` of `0`. By default, opacity is not checked.
- **`checkVisibilityCSS`**: A boolean that, if set to `true`, will cause the method to return `false` if the element has a computed `visibility` of `hidden` or `collapse`. By default, this is checked.
- **`contentVisibilityAuto`**: A boolean that, if set to `true`, will cause the method to return `false` if the element has `content-visibility: auto` and is currently not rendered. By default, this is not checked, and such elements are considered visible.

Using this API on supported Safari versions (17.4+) is the recommended approach for checking visibility, as it aligns with web standards and offloads the complex logic to the browser's rendering engine.

# Stability Detection Strategies For Safari

Detecting when an element has stopped moving (achieved stability) is a critical part of actionability checks, especially in dynamic web applications. For Safari, several strategies can be employed, with a `requestAnimationFrame`-based approach being the most direct for geometric stability, complemented by Observer APIs.

**1. `requestAnimationFrame`-based Stability Polling:**
This is the core technique used by Playwright and is highly effective in Safari.
- **How it Works:** The element's position and size are sampled by calling `element.getBoundingClientRect()` within a `requestAnimationFrame` (rAF) callback. The resulting `DOMRectReadOnly` object is stored. In the next animation frame, a new reading is taken and compared to the previous one. The element is considered 'stable' when its bounding box remains unchanged for a set number of consecutive frames.
- **Recommended Frames:** Playwright's standard is **2 consecutive frames**. This is a good baseline, as it ensures the element has settled after an animation tick. For applications with particularly jittery animations, this could be increased to 3 or 4 to reduce flakiness, at the cost of slightly increased latency.
- **Performance:** Using `rAF` is highly performant and battery-efficient compared to `setInterval`. It aligns checks with the browser's rendering cycle, ensuring you're not performing redundant checks between screen paints. The polling should only be active while waiting for stability and should be canceled immediately once the condition is met or a timeout occurs.

**2. Observer APIs for Triggering Re-evaluation:**
While `rAF` is ideal for the final stability check, Observer APIs are more efficient for detecting *when* a check might be necessary, avoiding constant polling.
- **`ResizeObserver`:** This observer is specifically designed to monitor changes to an element's content or border box size. It is highly appropriate for detecting size stability but will not fire if the element only changes its position (e.g., via `transform: translate()`).
- **`MutationObserver`:** This observer watches for changes in the DOM tree, such as an element being added/removed, or attributes (like `style` or `class`) changing. It can be a good signal to re-evaluate an element's state, but it is not a reliable tool for detecting visual stability resulting from CSS transitions or animations that don't involve direct style attribute mutations.
- **`IntersectionObserver`:** This API tracks when an element enters or exits the viewport. It is excellent for determining if an element is on-screen but is insufficient for detecting fine-grained motion stability within the viewport.

**3. Hybrid Strategy (Recommended):**
A robust and efficient approach combines these methods. Use Observers (`ResizeObserver`, `MutationObserver`) to detect initial changes that might affect stability. Once triggered, or if a wait is initiated, use the `rAF`-based polling loop to confirm that the element's bounding box has truly stopped changing. This hybrid pattern minimizes constant CPU usage from polling while providing precise confirmation of visual stability.

# Animation Detection In Safari

Safari provides robust support for the Web Animations API, which can be used to programmatically inspect running animations on an element.

**`getAnimations()` API Support in Safari:**
- **Support:** The `element.getAnimations()` method is fully supported in **Safari since version 13.1**. This means that CSS Animations, CSS Transitions, and animations created via the Web Animations JavaScript API are all exposed through this method.
- **Functionality:** Calling `element.getAnimations()` returns an array of `Animation` objects, each representing an animation currently affecting the element.

**How to Detect Running Animations:**
To determine if an element is actively animating, you can iterate through the array returned by `getAnimations()` and check the `playState` property of each `Animation` object. An element can be considered to be animating if any of its associated animations have a `playState` of `'running'`. 

Example check:
```javascript
const isAnimating = element.getAnimations().some(animation => animation.playState === 'running');
```

**Handling Actionability During Animations:**
It's important to note that not all animations should necessarily block an action. The context suggests a nuanced approach similar to Playwright's:
- **Geometry-Affecting vs. Non-Geometry-Affecting Animations:** An element might be considered actionable even while animating if the animation does not change its position or size. A common example is a button that is fading in (animating its `opacity`). Since its bounding box is stable, it can be clicked.
- **Recommended Strategy:** The most reliable strategy for actionability is to gate stability on the element's bounding box, not on the presence of any running animation. This means you would wait for the element's `x`, `y`, `width`, and `height` to remain constant for a few animation frames. This implicitly handles animations that move or resize the element, while correctly allowing actions on elements with non-disruptive animations like color or opacity changes. The `getAnimations()` API can still be useful for debugging or for implementing more complex waiting logic if needed.

# Polling Vs Observer Based Approaches

Playwright's approach to waiting for element stability deviates from traditional fixed-interval polling (e.g., `setInterval`). Instead, it primarily uses frame-based checks tied to `requestAnimationFrame` (rAF). This means stability is verified on the cadence of the browser's rendering cycle, which is more efficient and accurate for visual checks.

**Polling vs. Observers:**
*   **Polling (`setInterval`)**: Using a fixed interval like 50ms or 100ms has significant downsides. It introduces periodic CPU wakeups even when nothing is changing, which can be costly, especially on background tabs. It can also miss very brief transient states that occur between polls.
*   **Frame-Based Checks (`requestAnimationFrame`)**: This is Playwright's method for stability. It's a more efficient form of polling where checks are aligned with the browser's compositor timing. It's ideal for confirming geometry stability (e.g., an element's bounding box has stopped changing) but still involves running checks on every frame while a wait is pending.
*   **Observer-Based (`MutationObserver`, `ResizeObserver`, `IntersectionObserver`)**: These APIs are more efficient for detecting when to re-check an element's state. Instead of constantly polling, an observer can be set up to fire an event only when a relevant change occurs (e.g., a DOM attribute changes, an element resizes, or it enters the viewport). This avoids unnecessary computation when the page is idle.

**Hybrid Approach:**
A recommended, highly efficient pattern is a hybrid approach. This involves using observers as a trigger and rAF for final confirmation:
1.  Use `MutationObserver`, `ResizeObserver`, and `IntersectionObserver` to detect relevant changes in the DOM, element size, or viewport visibility.
2.  When an observer's callback is fired, it signals that the element's state *may* have changed, triggering a re-evaluation.
3.  The re-evaluation process then uses `requestAnimationFrame` to confirm final visual stability (e.g., waiting for the bounding box to remain unchanged for two consecutive frames).
4.  This hybrid model combines the low-CPU cost of observers with the precise visual validation of rAF-based checks, falling back to polling only when a change is likely to have occurred.

**CPU and Performance Cost:**
The cost of polling is directly related to its frequency. A 50ms `setInterval` will cause more CPU wakeups and consume more battery than a 100ms interval. However, `requestAnimationFrame` is generally the most preferable for visual stability, as it's optimized by the browser. The key to performance, regardless of the method, is to ensure that these checks are only active while an action is pending and are immediately canceled once the element is ready or the action times out. Debouncing checks can also prevent thrashing during periods of rapid change.

# Playwright Error Message Structure

## Error Condition

Locator does not resolve to a single element

## Playwright Error Name

TimeoutError

## Distinguishing Information

The error message indicates that the locator resolved to either zero elements ('Not attached') or more than one element ('multiple matches'). This is a precondition check before other actionability checks are performed.

## Recovery Hint

Ensure the locator is unique and correctly identifies a single element on the page. It may be necessary to wait for the element to be attached to the DOM using a specific wait function like 'toBeAttached()' before proceeding.

## Error Condition

Element is not visible

## Playwright Error Name

TimeoutError

## Distinguishing Information

The error log specifies that the element failed the visibility check. This can be because it has a 'display:none' or 'visibility:hidden' computed style, or its bounding box has zero width or height. The context notes that elements with 'opacity:0' are still considered visible by Playwright.

## Recovery Hint

Wait for the element to become visible, for example by using a 'toBeVisible()' assertion. If the element is supposed to appear after an interaction or scroll, ensure that action has completed. Consider scrolling the element or its container into view.

## Error Condition

Element is not stable

## Playwright Error Name

TimeoutError

## Distinguishing Information

The error indicates that the element's bounding box was continuously changing, failing the stability check. Playwright defines 'stable' as maintaining the same bounding box for at least two consecutive animation frames. The error message will state that the element was still in motion when the timeout was reached.

## Recovery Hint

Increase the action timeout to allow more time for animations or transitions to complete. For testing environments, consider disabling or fast-forwarding long-running animations. If flakiness persists, you might increase the number of stable frames required, balancing reliability against latency.

## Error Condition

Element does not receive pointer events

## Playwright Error Name

TimeoutError

## Distinguishing Information

The error message specifies that the element is obscured by another element at the point of interaction. Playwright performs a hit test at the action coordinates and the error will often name the element that is on top and would intercept the event (e.g., a modal overlay).

## Recovery Hint

Wait for any overlays, pop-ups, or modals to disappear before interacting with the element. If the overlay is expected, interact with it to close it first. As a last resort, use the 'force: true' option to bypass this check, but be aware this may not reflect actual user behavior.

## Error Condition

Element is not enabled

## Playwright Error Name

TimeoutError

## Distinguishing Information

The error indicates that the element has the 'disabled' attribute or an equivalent state that prevents interaction. The check fails for form controls that are not enabled.

## Recovery Hint

Wait for the element to become enabled, for instance by using a 'toBeEnabled()' assertion. This is common in dynamic forms where fields are enabled based on other inputs. Ensure the application logic that enables the element has been triggered and completed.

## Error Condition

Element is not editable

## Playwright Error Name

TimeoutError

## Distinguishing Information

This error occurs when trying to use an action like 'fill' or 'clear' on an element that is not an '<input>', '<textarea>', or does not have the '[contenteditable]' attribute. The error message will state that the target element is not editable.

## Recovery Hint

Verify that the locator targets the correct element that is designed to accept text input. Ensure the element is not 'readonly'.


# Error Message Design For Ai Agents

Best practices for designing actionability error messages for an AI agent focus on providing structured, detailed, and actionable feedback to enable effective self-correction. The error message should go beyond a simple 'TimeoutError' and include a machine-readable failure category (e.g., 'NotVisible', 'ObscuredByAnotherElement', 'NotStable'). It should provide specific diagnostic data, such as the exact reason for the failure (e.g., 'element has CSS property display: none' or 'element is obscured by element with selector .modal-overlay at coordinates (x,y)'). This level of detail allows the agent to understand the root cause instead of just the symptom. Furthermore, the message should offer concrete recovery hints tailored to the failure type. For an obscured element, it could suggest 'Wait for the overlay to be removed or use force: true'. For an unstable element, it could suggest 'Increase timeout or wait for animations to complete'. The system should also distinguish between temporary states (like an element animating) and permanent ones (like an element being disabled), which informs the agent whether to retry, wait, or find an alternative path. Providing last-seen diagnostics, such as the element's last known bounding rectangle or the computed styles that caused the failure, can further aid in debugging. Finally, exposing a 'trial' mode (like Playwright's `trial: true`) allows an agent to pre-flight an action to check for actionability without executing it, preventing unintended side effects and enabling a safer 'look before you leap' strategy.

# Handling Edge Cases In Auto Wait

## Edge Case

iframes

## Playwright Handling Strategy

Playwright handles elements inside iframes by requiring the user to scope their locators to the specific frame. Actionability checks are then performed correctly within the context of that iframe's document. For example, the 'receives events' check will validate that the target element is the topmost element at the action point *within the iframe*, correctly handling any overlays that exist only inside that frame. Furthermore, Playwright's auto-wait mechanism is aware of navigations; if an action like a click inside an iframe triggers a navigation of that frame, Playwright will wait for the navigation to complete before proceeding, ensuring the state is stable.

## Relevant Playwright Api

frameLocator()


# The Force Option In Playwright

The `force` option in Playwright is a boolean parameter available for certain actions (e.g., `locator.click()`, `locator.check()`) that, when set to `true`, bypasses non-essential actionability checks. Its primary purpose is to force an action on an element even if it fails checks like 'receives events', which verifies the element is not obscured by another element. Using `force: true` allows a click to be dispatched to an element that is covered by an overlay or another element. It should be used with caution and typically only as a last resort when the default auto-waiting behavior is not desired and you intentionally want to click an element regardless of its visibility or whether it can receive pointer events.

# Recommended Implementation For Safari

To build a robust, Playwright-style actionability checking mechanism for Safari, the following synthesized strategy should be implemented:

1.  **Action-Specific Check Pipeline:** Implement a pre-action validation function that runs a sequence of checks based on the action type, mirroring Playwright's official table. The general order of checks should be: Attached/Singular Locator Resolution → Visible → Stable → Receives Events → Enabled → Editable.
    *   `click`, `check`, `tap`: Visible + Stable + Receives Events + Enabled.
    *   `fill`, `clear`: Visible + Enabled + Editable.
    *   `hover`: Visible + Stable + Receives Events.
    *   `selectOption`: Visible + Enabled.

2.  **Visibility Check:**
    *   **Baseline:** Combine `element.getBoundingClientRect()` to ensure a non-empty bounding box (width > 0 and height > 0) with `window.getComputedStyle(element)` to verify `visibility` is not `hidden` and `display` is not `none`.
    *   **Modern Approach (Safari 17.4+):** Prefer `element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })`. This standard API encapsulates multiple visibility heuristics. Note that Playwright considers `opacity: 0` elements visible, so `checkOpacity` should be `false` for parity.

3.  **Stability Check:**
    *   Implement a `requestAnimationFrame` (rAF) loop. In each frame, capture the element's `getBoundingClientRect()`. 
    *   An element is 'stable' when its `DOMRect` properties (x, y, width, height) remain identical for at least two consecutive animation frames. Use a small epsilon for floating-point comparisons to prevent flakiness from sub-pixel rendering differences.

4.  **'Receives Events' (Obscuration) Check:**
    *   Calculate the target coordinate for the action (typically the center of the element's bounding box).
    *   Use `document.elementFromPoint(x, y)`. The check passes if the returned element is the target element itself or a descendant of it.
    *   Also, traverse up the DOM from the target to check for any ancestor with `pointer-events: none`, which would also cause the check to fail.
    *   This check must be re-run after any scrolling action.

5.  **State Checks (Enabled/Editable):**
    *   **Enabled:** Check if the element has the `disabled` attribute. This applies primarily to form controls like `<button>`, `<input>`, `<select>`, and `<textarea>`.
    *   **Editable:** Verify the element is an `<input>` (and not `readonly`), a `<textarea>` (not `readonly`), or any element with the `contenteditable="true"` attribute.

6.  **Scrolling into View:**
    *   Before running checks, determine if the element is in the viewport. This can be done by comparing its `getBoundingClientRect` with `window.innerHeight/innerWidth` or, more robustly, by using an `IntersectionObserver` to check its intersection ratio.
    *   If not sufficiently visible, call `element.scrollIntoView({ block: 'center', inline: 'center' })` to bring it into view. After scrolling, all actionability checks must be re-validated as the element's position and potential obscurers may have changed.

7.  **Handling Animations:**
    *   The rAF-based stability check naturally waits for animations affecting the element's position or size to complete.
    *   To avoid blocking on non-disruptive animations (e.g., color or opacity fades), you can use `element.getAnimations()` (supported in Safari 13.1+) to inspect running animations. If only properties like `opacity` are animating and the bounding box is stable, the action can proceed.

8.  **Timeouts and Error Reporting:**
    *   The entire auto-wait process must be wrapped in a timeout mechanism. Support both a per-action `timeout` option (defaulting to 0 for no timeout) and a configurable global default.
    *   If the timeout is exceeded, throw a `TimeoutError` with a highly specific message indicating which check failed (e.g., "TimeoutError: Element is not stable - bounding box changed continuously" or "TimeoutError: Element is obscured by another element <div class='modal-overlay'> at point (x, y)"). Include diagnostic data like the last known bounding box, relevant CSS properties, and the identity of the obscuring element to aid debugging.

9.  **Architecture and Edge Cases:**
    *   Use a hybrid approach: employ `MutationObserver` to efficiently detect DOM changes that might make an element actionable, triggering a re-evaluation, but use the rAF loop for the final visual stability proof. Avoid inefficient `setInterval` polling.
    *   For iframes, use a `frameLocator` concept to execute the checks within the context of the correct frame. For Shadow DOM, ensure locators can pierce shadow boundaries, and run checks on the actual element inside the shadow root.
