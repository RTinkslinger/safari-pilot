// ─── Auto-Wait: Playwright-style actionability checks as injectable JS ───────
//
// generateAutoWaitJs() produces a self-contained IIFE that polls for element
// actionability inside a browser tab. The returned string is suitable for
// Safari's `do JavaScript` (via AppleScript) or the daemon/extension bridge.
//
// Design constraints:
//   - Must use `var` (not let/const) for older Safari compat
//   - Must be a single IIFE returning a Promise
//   - Must be fully self-contained (no external imports in the generated JS)
//   - Selector embedded via JSON.stringify for safe escaping

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActionabilityCheck =
  | 'visible'
  | 'stable'
  | 'enabled'
  | 'editable'
  | 'receivesEvents';

export interface AutoWaitOptions {
  /** Maximum time to wait for all checks to pass (ms). Default: 5000. */
  timeout?: number;
  /** Skip all checks — just find the element and return. */
  force?: boolean;
}

export interface AutoWaitResult {
  ready: boolean;
  selector: string;
  waitedMs: number;
  checks?: Record<string, boolean>;
  failedCheck?: string;
  elementInfo?: {
    tagName: string;
    display?: string;
    visibility?: string;
    rect?: { x: number; y: number; width: number; height: number };
    disabled?: boolean;
    readOnly?: boolean;
    ariaDisabled?: string | null;
    ariaReadonly?: string | null;
  };
  hints?: string[];
}

// ─── Action check profiles (Playwright's matrix) ────────────────────────────

export const ACTION_CHECKS: Record<string, ActionabilityCheck[]> = {
  click: ['visible', 'stable', 'enabled', 'receivesEvents'],
  dblclick: ['visible', 'stable', 'enabled', 'receivesEvents'],
  check: ['visible', 'stable', 'enabled', 'receivesEvents'],
  hover: ['visible', 'stable', 'receivesEvents'],
  drag: ['visible', 'stable', 'receivesEvents'],
  fill: ['visible', 'enabled', 'editable'],
  selectOption: ['visible', 'enabled'],
  type: [],
  pressKey: [],
  scroll: [],
};

// ─── Backoff schedule ────────────────────────────────────────────────────────

const BACKOFF_MS = [0, 20, 100, 100, 500];

// ─── JS fragment builders ────────────────────────────────────────────────────
// Each returns a string of JS code (using `var`, no let/const) that defines
// functions used inside the generated IIFE.

function visibleCheckJs(): string {
  return `
function __isVisible(el) {
  if (!el || !el.isConnected) return false;
  var style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.display === 'contents') {
    for (var child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && __isVisible(child)) return true;
      if (child.nodeType === 3 && child.textContent.trim()) return true;
    }
    return false;
  }
  if (style.visibility !== 'visible') return false;
  var rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}`;
}

function stableCheckJs(): string {
  return `
function __checkStable(el) {
  return new Promise(function(resolve) {
    var lastRect = null;
    var stableCount = 0;
    var lastTime = 0;
    function check() {
      var time = performance.now();
      if (lastTime > 0 && time - lastTime < 15) {
        requestAnimationFrame(check);
        return;
      }
      lastTime = time;
      var r = el.getBoundingClientRect();
      var rect = { x: r.top, y: r.left, w: r.width, h: r.height };
      if (lastRect && rect.x === lastRect.x && rect.y === lastRect.y && rect.w === lastRect.w && rect.h === lastRect.h) {
        stableCount++;
        if (stableCount >= 2) { resolve(true); return; }
      } else {
        stableCount = 0;
      }
      lastRect = rect;
      requestAnimationFrame(check);
    }
    requestAnimationFrame(check);
  });
}`;
}

function enabledCheckJs(): string {
  return `
function __isEnabled(el) {
  if ('disabled' in el && el.disabled) return false;
  if (el.closest('fieldset:disabled') && !el.closest('legend')) return false;
  var node = el;
  while (node) {
    if (node.getAttribute && node.getAttribute('aria-disabled') === 'true') return false;
    node = node.parentElement;
  }
  return true;
}`;
}

function editableCheckJs(): string {
  // Editable = enabled AND not readonly
  return `
function __isEditable(el) {
  if (!__isEnabled(el)) return false;
  if (el.readOnly === true) return false;
  var node = el;
  while (node) {
    if (node.getAttribute && node.getAttribute('aria-readonly') === 'true') return false;
    node = node.parentElement;
  }
  return true;
}`;
}

function receivesEventsCheckJs(): string {
  return `
function __receivesEvents(el) {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var rect = el.getBoundingClientRect();
  var cx = rect.left + rect.width / 2;
  var cy = rect.top + rect.height / 2;
  var hit = document.elementFromPoint(cx, cy);
  if (!hit) return false;
  var node = hit;
  while (node) {
    if (node === el) return true;
    if (node.shadowRoot) {
      var shadowHit = node.shadowRoot.elementFromPoint(cx, cy);
      if (shadowHit) {
        var sNode = shadowHit;
        while (sNode) {
          if (sNode === el) return true;
          sNode = sNode.parentElement;
        }
      }
    }
    node = node.parentElement;
  }
  return el.contains(hit);
}`;
}

// ─── Hint generators ─────────────────────────────────────────────────────────

function hintJsForCheck(check: ActionabilityCheck): string {
  switch (check) {
    case 'visible':
      return `
        if (style.display === 'none') __hints.push('Element has display:none. It may be inside a hidden container.');
        else if (style.visibility !== 'visible') __hints.push('Element has visibility:' + style.visibility + '.');
        else if (rect.width === 0 || rect.height === 0) __hints.push('Element has zero dimensions (' + rect.width + 'x' + rect.height + '). It may be collapsed or not yet laid out.');
        else if (!el.isConnected) __hints.push('Element is not connected to the DOM.');`;
    case 'stable':
      return `__hints.push('Element position/size is still changing. It may be animating or in a layout shift.');`;
    case 'enabled':
      return `
        if ('disabled' in el && el.disabled) __hints.push('Element has the disabled attribute.');
        else if (el.closest('fieldset:disabled')) __hints.push('Element is inside a disabled fieldset.');
        else __hints.push('Element or an ancestor has aria-disabled=true.');`;
    case 'editable':
      return `
        if (!__isEnabled(el)) __hints.push('Element is not enabled (required for editable check).');
        else if (el.readOnly === true) __hints.push('Element has the readOnly property set.');
        else __hints.push('Element or an ancestor has aria-readonly=true.');`;
    case 'receivesEvents':
      return `__hints.push('Another element is covering this element at its center point. Check for overlays, modals, or sticky headers.');`;
  }
}

// ─── Main generator ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 5000;

/**
 * Generate a self-contained JavaScript IIFE that waits for an element to become
 * actionable according to the specified checks.
 *
 * The returned string evaluates to a Promise<AutoWaitResult>.
 */
export function generateAutoWaitJs(
  selector: string,
  checks: ActionabilityCheck[],
  options?: AutoWaitOptions,
): string {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const force = options?.force ?? false;
  const escapedSelector = JSON.stringify(selector);

  // Force mode: just find element, no checks
  if (force || checks.length === 0) {
    return generateForceJs(escapedSelector, timeout);
  }

  return generateFullJs(escapedSelector, checks, timeout);
}

function generateForceJs(escapedSelector: string, timeout: number): string {
  return `(function() {
  var __sel = ${escapedSelector};
  var __timeout = ${timeout};
  var __backoff = [0, 20, 100, 100, 500];
  var __start = Date.now();

  function __attempt(idx) {
    return new Promise(function(resolve) {
      var el = document.querySelector(__sel);
      if (el) {
        resolve({
          ready: true,
          selector: __sel,
          waitedMs: Date.now() - __start,
          checks: {}
        });
        return;
      }
      var elapsed = Date.now() - __start;
      if (elapsed >= __timeout) {
        resolve({
          ready: false,
          selector: __sel,
          waitedMs: elapsed,
          failedCheck: 'not_found',
          hints: ['Element not found within timeout. Verify the selector is correct and the element exists in the DOM.']
        });
        return;
      }
      var delay = __backoff[idx < __backoff.length ? idx : __backoff.length - 1];
      setTimeout(function() { __attempt(idx + 1).then(resolve); }, delay);
    });
  }

  return __attempt(0);
})()`;
}

function generateFullJs(
  escapedSelector: string,
  checks: ActionabilityCheck[],
  timeout: number,
): string {
  // Collect only the helper functions we actually need
  const helpers: string[] = [];
  const needsVisible = checks.includes('visible');
  const needsStable = checks.includes('stable');
  const needsEnabled = checks.includes('enabled');
  const needsEditable = checks.includes('editable');
  const needsReceivesEvents = checks.includes('receivesEvents');

  if (needsVisible) helpers.push(visibleCheckJs());
  if (needsEnabled || needsEditable) helpers.push(enabledCheckJs());
  if (needsEditable) helpers.push(editableCheckJs());
  if (needsStable) helpers.push(stableCheckJs());
  if (needsReceivesEvents) helpers.push(receivesEventsCheckJs());

  // Build the per-iteration check logic
  const checkLines: string[] = [];
  const failedCheckCases: string[] = [];
  const checksResultEntries: string[] = [];

  for (const check of checks) {
    switch (check) {
      case 'visible':
        checkLines.push(`      var __visOk = __isVisible(el);`);
        checkLines.push(`      __results.visible = __visOk;`);
        checkLines.push(`      if (!__visOk) { __failed = 'not_visible'; }`);
        failedCheckCases.push(
          `      if (__failed === 'not_visible') {\n${hintJsForCheck('visible')}\n      }`,
        );
        checksResultEntries.push(`visible: __results.visible`);
        break;
      case 'stable':
        checkLines.push(`      var __stableOk = false;`);
        checkLines.push(`      __results.stable = false;`);
        checkLines.push(
          `      if (!__failed) { __stableOk = yield __checkStable(el); __results.stable = __stableOk; if (!__stableOk) __failed = 'not_stable'; }`,
        );
        failedCheckCases.push(
          `      if (__failed === 'not_stable') {\n${hintJsForCheck('stable')}\n      }`,
        );
        checksResultEntries.push(`stable: __results.stable`);
        break;
      case 'enabled':
        checkLines.push(`      var __enOk = __isEnabled(el);`);
        checkLines.push(`      __results.enabled = __enOk;`);
        checkLines.push(`      if (!__failed && !__enOk) { __failed = 'not_enabled'; }`);
        failedCheckCases.push(
          `      if (__failed === 'not_enabled') {\n${hintJsForCheck('enabled')}\n      }`,
        );
        checksResultEntries.push(`enabled: __results.enabled`);
        break;
      case 'editable':
        checkLines.push(`      var __edOk = __isEditable(el);`);
        checkLines.push(`      __results.editable = __edOk;`);
        checkLines.push(`      if (!__failed && !__edOk) { __failed = 'not_editable'; }`);
        failedCheckCases.push(
          `      if (__failed === 'not_editable') {\n${hintJsForCheck('editable')}\n      }`,
        );
        checksResultEntries.push(`editable: __results.editable`);
        break;
      case 'receivesEvents':
        checkLines.push(`      var __revOk = __receivesEvents(el);`);
        checkLines.push(`      __results.receivesEvents = __revOk;`);
        checkLines.push(`      if (!__failed && !__revOk) { __failed = 'not_receivesEvents'; }`);
        failedCheckCases.push(
          `      if (__failed === 'not_receivesEvents') {\n${hintJsForCheck('receivesEvents')}\n      }`,
        );
        checksResultEntries.push(`receivesEvents: __results.receivesEvents`);
        break;
    }
  }

  // The stable check is async (rAF-based), so we need a different flow when
  // it's included. We use a simple coroutine pattern with `yield` replaced by
  // explicit promise chaining to avoid generators (Safari compat).

  const hasAsyncCheck = needsStable;

  // Build the check block. The stable check returns a promise, so if present
  // we chain it; otherwise the block is fully synchronous.
  const syncCheckLines = checkLines.filter((l) => !l.includes('yield'));
  const stableCheckLine = checkLines.find((l) => l.includes('yield'));

  let runChecksBody: string;

  if (hasAsyncCheck && stableCheckLine) {
    // Split: run sync checks, then if no failure so far, run stable check async
    const stablePromiseCode = `
      if (!__failed) {
        return __checkStable(el).then(function(__stableOk) {
          __results.stable = __stableOk;
          if (!__stableOk) __failed = 'not_stable';
          return { el: el, failed: __failed, results: __results };
        });
      }
      return Promise.resolve({ el: el, failed: __failed, results: __results });`;

    runChecksBody = syncCheckLines.join('\n') + '\n' + stablePromiseCode;
  } else {
    runChecksBody =
      syncCheckLines.join('\n') +
      `\n      return Promise.resolve({ el: el, failed: __failed, results: __results });`;
  }

  const elementInfoJs = `
    var __rect = el.getBoundingClientRect();
    var __style = getComputedStyle(el);
    var __eInfo = {
      tagName: el.tagName,
      display: __style.display,
      visibility: __style.visibility,
      rect: { x: __rect.left, y: __rect.top, width: __rect.width, height: __rect.height },
      disabled: ('disabled' in el) ? el.disabled : undefined,
      readOnly: (el.readOnly !== undefined) ? el.readOnly : undefined,
      ariaDisabled: el.getAttribute('aria-disabled'),
      ariaReadonly: el.getAttribute('aria-readonly')
    };`;

  const hintBlock = failedCheckCases.join('\n');

  return `(function() {
  var __sel = ${escapedSelector};
  var __timeout = ${timeout};
  var __backoff = [0, 20, 100, 100, 500];
  var __start = Date.now();
${helpers.join('\n')}

  function __runChecks(el) {
    var __failed = null;
    var __results = {};
${runChecksBody}
  }

  function __attempt(idx) {
    return new Promise(function(resolve) {
      var el = document.querySelector(__sel);
      if (!el) {
        var elapsed = Date.now() - __start;
        if (elapsed >= __timeout) {
          resolve({
            ready: false,
            selector: __sel,
            waitedMs: elapsed,
            failedCheck: 'not_found',
            hints: ['Element not found within timeout. Verify the selector is correct and the element exists in the DOM.']
          });
          return;
        }
        var delay = __backoff[idx < __backoff.length ? idx : __backoff.length - 1];
        setTimeout(function() { __attempt(idx + 1).then(resolve); }, delay);
        return;
      }

      __runChecks(el).then(function(r) {
        if (!r.failed) {
          resolve({
            ready: true,
            selector: __sel,
            waitedMs: Date.now() - __start,
            checks: r.results
          });
          return;
        }

        var elapsed = Date.now() - __start;
        if (elapsed >= __timeout) {
          var __hints = [];
          var style = getComputedStyle(el);
          var rect = el.getBoundingClientRect();
${hintBlock}
${elementInfoJs}
          resolve({
            ready: false,
            selector: __sel,
            waitedMs: elapsed,
            failedCheck: r.failed,
            elementInfo: __eInfo,
            checks: r.results,
            hints: __hints
          });
          return;
        }

        var delay = __backoff[idx < __backoff.length ? idx : __backoff.length - 1];
        setTimeout(function() { __attempt(idx + 1).then(resolve); }, delay);
      });
    });
  }

  return __attempt(0);
})()`;
}
