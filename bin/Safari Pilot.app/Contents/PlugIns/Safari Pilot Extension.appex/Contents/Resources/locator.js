// extension/locator.js — MAIN-world helpers for safari_scroll_to_element
// (v0.1.31 Task 5) and forthcoming safari_dismiss_overlays (v0.1.31 Task 10).
//
// This file is registered in manifest.json's MAIN-world content_scripts
// BEFORE content-main.js, so window.__SP_LOCATOR__ is guaranteed to exist
// by the time content-main.js processes any execute_script sentinel.
//
// Helpers:
//   querySelectorWithShadow(selector, root) — single-element search through
//     open shadow roots; returns first match or null.
//   resolveScrollTargets({ selector, text, role, name, includeHidden }) —
//     precedence selector > role+name > text; same-origin iframe traversal;
//     visibility filter; returns [{ element, strategy }, ...].
//   waitForScrollSettle(maxMs) — RAF-driven idle detection (50ms grace, capped
//     at maxMs). Resolves when window.scrollY stops changing.
//   serializeNode(el, shallow) — { tagName, role, text(80c), xpath, bbox }.

(function () {
  'use strict';

  // ── querySelectorWithShadow: traverses open shadow roots ─────────────────
  function querySelectorWithShadow(selector, root) {
    root = root || document;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const children = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (const el of children) {
        if (el.shadowRoot && el.shadowRoot.mode === 'open') {
          const found = el.shadowRoot.querySelector(selector);
          if (found) return found;
          stack.push(el.shadowRoot);
        }
      }
    }
    return null;
  }

  // ── resolveInDoc: helper for same-origin iframe traversal ───────────────
  function resolveInDoc(doc, opts) {
    const { selector, text, role, name } = opts;
    const out = [];
    if (selector) {
      out.push(...Array.from(doc.querySelectorAll(selector)));
    } else if (role) {
      const m = Array.from(doc.querySelectorAll('[role="' + role + '"]'));
      if (name) {
        const needle = name.toLowerCase();
        for (const el of m) {
          const accName = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
          if (accName.includes(needle)) out.push(el);
        }
      } else {
        out.push(...m);
      }
    } else if (text) {
      const needle = text.toLowerCase().replace(/\s+/g, ' ').trim();
      const all = doc.querySelectorAll('body *:not(script):not(style)');
      for (const el of all) {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || '')
          .join('')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        if (directText.includes(needle)) out.push(el);
      }
    }
    return out;
  }

  // ── resolveScrollTargets: precedence selector > role+name > text ─────────
  function resolveScrollTargets(opts) {
    opts = opts || {};
    const { selector, text, role, name } = opts;
    const includeHidden = opts.includeHidden === true;
    let candidates = [];
    let strategy = null;

    if (selector) {
      strategy = 'selector';
      candidates = Array.from(document.querySelectorAll(selector));
    } else if (role) {
      strategy = 'role';
      const roleMatches = Array.from(document.querySelectorAll('[role="' + role + '"]'));
      if (name) {
        const needle = name.toLowerCase();
        candidates = roleMatches.filter((el) => {
          const accName = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
          return accName.includes(needle);
        });
      } else {
        candidates = roleMatches;
      }
    } else if (text) {
      strategy = 'text';
      const needle = text.toLowerCase().replace(/\s+/g, ' ').trim();
      const all = document.querySelectorAll('body *:not(script):not(style)');
      candidates = Array.from(all).filter((el) => {
        const directText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent || '')
          .join('')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
        return directText.includes(needle);
      });
    }

    // Same-origin iframe traversal — cross-origin frames silently skip
    // (yields TARGET_NOT_FOUND when no frame matches, per spec).
    const frames = document.querySelectorAll('iframe');
    for (const frame of frames) {
      let frameDoc = null;
      try { frameDoc = frame.contentDocument; } catch (_e) { frameDoc = null; }
      if (!frameDoc) continue;
      candidates.push(...resolveInDoc(frameDoc, { selector, text, role, name }));
    }

    // Visibility filter (skipped when includeHidden=true)
    const filtered = candidates
      .filter((el) => el && el.nodeType === 1)
      .filter((el) => {
        if (includeHidden) return true;
        if (el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.width > 0;
      });

    return filtered.map((element) => ({ element, strategy }));
  }

  // ── waitForScrollSettle: RAF + 50ms grace, capped at maxMs ──────────────
  function waitForScrollSettle(maxMs) {
    const cap = typeof maxMs === 'number' ? maxMs : 500;
    return new Promise((resolve) => {
      let lastY = window.scrollY;
      const start = Date.now();
      function tick() {
        if (Date.now() - start >= cap) { resolve(); return; }
        const currentY = window.scrollY;
        if (currentY === lastY) {
          setTimeout(resolve, 50);
        } else {
          lastY = currentY;
          requestAnimationFrame(tick);
        }
      }
      requestAnimationFrame(tick);
    });
  }

  // ── computeXPath: minimal positional XPath ──────────────────────────────
  function computeXPath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(cur.tagName.toLowerCase() + '[' + idx + ']');
      cur = cur.parentElement;
    }
    return '/html/body/' + parts.join('/');
  }

  // ── serializeNode: small JSON-safe element descriptor ───────────────────
  function serializeNode(el, shallow) {
    const text = (el.textContent || '').trim().slice(0, 80);
    const role = el.getAttribute('role') || undefined;
    const out = {
      tagName: el.tagName.toLowerCase(),
      role,
      text,
    };
    if (!shallow) {
      const rect = el.getBoundingClientRect();
      out.xpath = computeXPath(el);
      out.bbox = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    } else {
      out.xpath = '';
    }
    return out;
  }

  // ── matchSignal: does element satisfy a single signal? ──────────────────
  function matchSignal(el, signal) {
    switch (signal.type) {
      case 'selector':
        // Element-matches, not document-querySelector. The latter returns false
        // for shadow-encapsulated elements because hostDoc is the outer light-DOM
        // document. el.matches() works in both shadow and light DOM.
        return !!(el.matches && el.matches(signal.value));
      case 'aria-label-substring': {
        const label = (el.getAttribute && el.getAttribute('aria-label')) || '';
        const v = signal.caseInsensitive ? signal.value.toLowerCase() : signal.value;
        const l = signal.caseInsensitive ? label.toLowerCase() : label;
        return l.includes(v);
      }
      case 'aria-role':
        return (el.getAttribute && el.getAttribute('role')) === signal.value;
      case 'fixed-position': {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        return cs.position === 'fixed';
      }
      case 'z-index-above': {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        const z = parseInt(cs.zIndex, 10);
        return Number.isFinite(z) && z > parseInt(signal.value, 10);
      }
      default:
        return false;
    }
  }

  // ── findPatternRoot: finds the first element matching ALL signals ──────
  function findPatternRoot(pattern) {
    // Primary signal is selector if present
    const primarySignal = pattern.signals.find((s) => s.type === 'selector');
    const primarySelector = primarySignal ? primarySignal.value : '*';
    const candidates = [];
    // Main document (with shadow penetration)
    const mainCandidate = querySelectorWithShadow(primarySelector);
    if (mainCandidate) candidates.push(mainCandidate);
    // Same-origin iframes
    const frames = document.querySelectorAll('iframe');
    for (const frame of frames) {
      let frameDoc = null;
      try { frameDoc = frame.contentDocument; } catch (_e) { continue; }
      if (!frameDoc) continue;
      const c = frameDoc.querySelector(primarySelector);
      if (c) candidates.push(c);
    }
    for (const el of candidates) {
      const allMatch = pattern.signals.every((s) => matchSignal(el, s));
      if (allMatch) return el;
    }
    return null;
  }

  // ── dismissPattern: execute the dismiss action, verify removal ─────────
  async function dismissPattern(pattern, root) {
    const action = pattern.dismiss.action;
    let actionExecuted = false;
    try {
      if (action === 'click') {
        const target = (pattern.dismiss.selector
          ? root.ownerDocument.querySelector(pattern.dismiss.selector) || querySelectorWithShadow(pattern.dismiss.selector)
          : root);
        if (target) { target.click(); actionExecuted = true; }
      } else if (action === 'esc-key') {
        const evt = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(evt); actionExecuted = true;
      } else if (action === 'remove-node') {
        const target = pattern.dismiss.selector
          ? root.ownerDocument.querySelector(pattern.dismiss.selector) || querySelectorWithShadow(pattern.dismiss.selector)
          : root;
        if (target && target.parentNode) { target.parentNode.removeChild(target); actionExecuted = true; }
      }
    } catch (e) {
      // try fallback if defined
      if (pattern.dismiss.fallbackAction) {
        return dismissPattern({ ...pattern, dismiss: { action: pattern.dismiss.fallbackAction, selector: pattern.dismiss.fallbackSelector } }, root);
      }
      throw e;
    }
    if (!actionExecuted && pattern.dismiss.fallbackAction) {
      return dismissPattern({ ...pattern, dismiss: { action: pattern.dismiss.fallbackAction, selector: pattern.dismiss.fallbackSelector } }, root);
    }
    // Verify after stabilityMs
    await new Promise((r) => setTimeout(r, pattern.verify.stabilityMs));
    const stillThere = findPatternRoot(pattern);
    return { verified: !stillThere };
  }

  // ── v0.1.34 T7b: full locator resolution in MAIN world ─────────────────
  //
  // Mirrors the IIFE body generated by src/locator.ts `generateLocatorJs`.
  // The IIFE form is preserved for the AppleScript fallback path (no
  // __SP_LOCATOR__ available in `do JavaScript` without the extension).
  // This function form is for the extension's __SP_RESOLVE_LOCATOR__
  // sentinel — CSP-immune since it runs without `new Function()`.
  //
  // Drift between this and src/locator.ts is guarded by
  // test/unit/locators/drift-detector.test.ts.

  // Mirrors ROLE_SELECTORS in src/locator.ts (kept in sync — see drift test).
  const ROLE_SELECTORS = {
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
    region: '[role="region"],section[aria-label],section[aria-labelledby]',
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

  function normalizeWhitespace(s) {
    return (s || '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
  }

  function matchText(haystack, needle, isExact) {
    if (isExact) return haystack === needle;
    return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  }

  function getAccessibleName(el) {
    if (typeof el.computedName === 'string') return el.computedName;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      const parts = [];
      for (let j = 0; j < ids.length; j++) {
        const ref = document.getElementById(ids[j]);
        if (ref) parts.push(normalizeWhitespace(ref.innerText || ref.textContent || ''));
      }
      if (parts.length > 0) return parts.join(' ');
    }
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    const title = el.getAttribute('title');
    if (title) return title;
    if (el.labels && el.labels.length > 0) {
      const lblParts = [];
      for (let k = 0; k < el.labels.length; k++) {
        lblParts.push(normalizeWhitespace(el.labels[k].innerText || el.labels[k].textContent || ''));
      }
      return lblParts.join(' ');
    }
    return normalizeWhitespace(el.textContent || '');
  }

  function resolveByXpath(root, xpath) {
    try {
      const xr = document.evaluate(
        xpath,
        root,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const node = xr.singleNodeValue;
      if (node && node.nodeType === 1) return { matched: [node], malformed: null };
      return { matched: [], malformed: null };
    } catch (e) {
      return { matched: [], malformed: (e && e.message) ? e.message : String(e) };
    }
  }

  function resolveByTestId(root, testId) {
    const el = root.querySelector('[data-testid="' + String(testId).replace(/"/g, '\\"') + '"]');
    return el ? [el] : [];
  }

  function resolveByRole(root, role, name, exact) {
    const preFilter = ROLE_SELECTORS[role];
    const selectorStr = preFilter || '[role="' + role + '"]';
    let candidates;
    try {
      candidates = Array.prototype.slice.call(root.querySelectorAll(selectorStr));
    } catch (_e) {
      candidates = [];
    }
    const roleTarget = role;
    candidates = candidates.filter((el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit.toLowerCase() === roleTarget;
      return true;
    });
    if (name === undefined) {
      return { matched: candidates, candidateCount: candidates.length, allNames: null };
    }
    const allNames = [];
    const nameMatched = [];
    for (let i = 0; i < candidates.length; i++) {
      const accName = getAccessibleName(candidates[i]);
      allNames.push(accName);
      if (matchText(accName, name, exact)) nameMatched.push(candidates[i]);
    }
    return { matched: nameMatched, candidateCount: candidates.length, allNames };
  }

  function resolveByLabel(root, label, exact) {
    const labelable = Array.prototype.slice.call(
      root.querySelectorAll('input,select,textarea,button,meter,output,progress'),
    );
    const out = [];
    for (let i = 0; i < labelable.length; i++) {
      const el = labelable[i];
      let labelText = '';
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const ids = labelledBy.split(/\s+/);
        const parts = [];
        for (let j = 0; j < ids.length; j++) {
          const ref = document.getElementById(ids[j]);
          if (ref) parts.push(normalizeWhitespace(ref.innerText || ref.textContent || ''));
        }
        if (parts.length > 0) labelText = parts.join(' ');
      }
      if (!labelText && el.labels && el.labels.length > 0) {
        const lblParts = [];
        for (let k = 0; k < el.labels.length; k++) {
          lblParts.push(normalizeWhitespace(el.labels[k].innerText || el.labels[k].textContent || ''));
        }
        labelText = lblParts.join(' ');
      }
      if (!labelText) {
        const aria = el.getAttribute('aria-label');
        if (aria) labelText = normalizeWhitespace(aria);
      }
      if (labelText && matchText(labelText, label, exact)) out.push(el);
    }
    return out;
  }

  function resolveByPlaceholder(root, placeholder, exact) {
    if (exact) {
      const el = root.querySelector('[placeholder="' + String(placeholder).replace(/"/g, '\\"') + '"]');
      return el ? [el] : [];
    }
    const phEls = Array.prototype.slice.call(root.querySelectorAll('[placeholder]'));
    const out = [];
    for (let i = 0; i < phEls.length; i++) {
      const phVal = phEls[i].getAttribute('placeholder') || '';
      if (matchText(phVal, placeholder, false)) out.push(phEls[i]);
    }
    return out;
  }

  function resolveByText(root, text, exact) {
    const allEls = Array.prototype.slice.call(root.querySelectorAll('*'));
    const skipTags = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
    let matched = [];
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      if (skipTags[el.tagName]) continue;
      let elText = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
      elText = normalizeWhitespace(elText);
      if (matchText(elText, text, exact)) matched.push(el);
    }
    if (matched.length > 1) {
      const filtered = matched.filter((el) => {
        for (let j = 0; j < matched.length; j++) {
          if (matched[j] !== el && el.contains(matched[j])) return false;
        }
        return true;
      });
      if (filtered.length > 0) matched = filtered;
    }
    return matched;
  }

  // Apply a single T77 chain op to the current `matched` array. Returns new array.
  function applyChainOp(matched, cop) {
    if (cop.op === 'first') {
      return matched.length > 0 ? [matched[0]] : [];
    }
    if (cop.op === 'last') {
      return matched.length > 0 ? [matched[matched.length - 1]] : [];
    }
    if (cop.op === 'nth') {
      const idx = cop.n < 0 ? matched.length + cop.n : cop.n;
      return (idx >= 0 && idx < matched.length) ? [matched[idx]] : [];
    }
    if (cop.op === 'filter') {
      return matched.filter((el) => {
        if (typeof cop.hasText === 'string') {
          const t = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
          if (t.toLowerCase().indexOf(cop.hasText.toLowerCase()) === -1) return false;
        }
        if (typeof cop.hasNotText === 'string') {
          const tn = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
          if (tn.toLowerCase().indexOf(cop.hasNotText.toLowerCase()) !== -1) return false;
        }
        if (cop.has && typeof cop.has === 'object') {
          let hasMatch = false;
          const probe = el.querySelectorAll('*');
          for (let pi = 0; pi < probe.length; pi++) {
            if (cop.has.role) {
              const r = probe[pi].getAttribute('role') || '';
              if (r === cop.has.role) { hasMatch = true; break; }
            } else if (typeof cop.has.text === 'string') {
              const pt = (probe[pi].innerText !== undefined ? probe[pi].innerText : probe[pi].textContent) || '';
              if (pt.toLowerCase().indexOf(cop.has.text.toLowerCase()) !== -1) { hasMatch = true; break; }
            } else if (cop.has.testId) {
              const tid = probe[pi].getAttribute('data-testid') || '';
              if (tid === cop.has.testId) { hasMatch = true; break; }
            }
          }
          if (!hasMatch) return false;
        }
        if (cop.hasNot && typeof cop.hasNot === 'object') {
          let hasNotMatch = false;
          const nprobe = el.querySelectorAll('*');
          for (let npi = 0; npi < nprobe.length; npi++) {
            if (cop.hasNot.role) {
              const nr = nprobe[npi].getAttribute('role') || '';
              if (nr === cop.hasNot.role) { hasNotMatch = true; break; }
            } else if (cop.hasNot.testId) {
              const ntid = nprobe[npi].getAttribute('data-testid') || '';
              if (ntid === cop.hasNot.testId) { hasNotMatch = true; break; }
            }
          }
          if (hasNotMatch) return false;
        }
        return true;
      });
    }
    if (cop.op === 'descendant') {
      const next = [];
      for (let mi = 0; mi < matched.length; mi++) {
        const parent = matched[mi];
        const nestedRole = cop.locator && cop.locator.role;
        const nestedName = cop.locator && cop.locator.name;
        const nestedTestId = cop.locator && cop.locator.testId;
        const nestedText = cop.locator && cop.locator.text;
        if (nestedTestId) {
          const byId = parent.querySelectorAll('[data-testid="' + String(nestedTestId).replace(/"/g, '\\"') + '"]');
          for (let bi = 0; bi < byId.length; bi++) next.push(byId[bi]);
        } else if (nestedRole) {
          const sel = '[role="' + nestedRole + '"]';
          const maybe = parent.querySelectorAll(sel);
          for (let ri = 0; ri < maybe.length; ri++) {
            const cand = maybe[ri];
            if (nestedName) {
              const an = (typeof cand.computedName === 'string')
                ? cand.computedName
                : (cand.getAttribute('aria-label') || (cand.textContent || '').trim());
              if (an && an.toLowerCase().indexOf(String(nestedName).toLowerCase()) !== -1) {
                next.push(cand);
              }
            } else {
              next.push(cand);
            }
          }
        } else if (typeof nestedText === 'string') {
          const all = parent.querySelectorAll('*');
          for (let ti = 0; ti < all.length; ti++) {
            const et = (all[ti].innerText !== undefined ? all[ti].innerText : all[ti].textContent) || '';
            if (et.toLowerCase().indexOf(nestedText.toLowerCase()) !== -1) {
              next.push(all[ti]);
            }
          }
        }
      }
      return next;
    }
    if (cop.op === 'or') {
      let orMatches = [];
      if (cop.locator) {
        if (cop.locator.testId) {
          const orSel = '[data-testid="' + String(cop.locator.testId).replace(/"/g, '\\"') + '"]';
          orMatches = Array.prototype.slice.call(document.querySelectorAll(orSel));
        } else if (cop.locator.role) {
          const orRoleSel = '[role="' + cop.locator.role + '"]';
          let orCands = Array.prototype.slice.call(document.querySelectorAll(orRoleSel));
          if (cop.locator.name) {
            orCands = orCands.filter((e) => {
              const n = (typeof e.computedName === 'string') ? e.computedName : (e.getAttribute('aria-label') || (e.textContent || '').trim());
              return n && n.toLowerCase().indexOf(String(cop.locator.name).toLowerCase()) !== -1;
            });
          }
          orMatches = orCands;
        }
      }
      const orSet = matched.slice();
      for (let oi = 0; oi < orMatches.length; oi++) {
        if (orSet.indexOf(orMatches[oi]) === -1) orSet.push(orMatches[oi]);
      }
      return orSet;
    }
    if (cop.op === 'and') {
      let andMatches = [];
      if (cop.locator) {
        if (cop.locator.testId) {
          const andSel = '[data-testid="' + String(cop.locator.testId).replace(/"/g, '\\"') + '"]';
          andMatches = Array.prototype.slice.call(document.querySelectorAll(andSel));
        } else if (cop.locator.role) {
          const andRoleSel = '[role="' + cop.locator.role + '"]';
          let andCands = Array.prototype.slice.call(document.querySelectorAll(andRoleSel));
          if (cop.locator.name) {
            andCands = andCands.filter((e) => {
              const n = (typeof e.computedName === 'string') ? e.computedName : (e.getAttribute('aria-label') || (e.textContent || '').trim());
              return n && n.toLowerCase().indexOf(String(cop.locator.name).toLowerCase()) !== -1;
            });
          }
          andMatches = andCands;
        }
      }
      return matched.filter((e) => andMatches.indexOf(e) !== -1);
    }
    return matched;
  }

  /**
   * Full locator resolution mirroring src/locator.ts generateLocatorJs.
   * Returns: { found, selector?, element?, matchCount?, strictnessSatisfied?, locator?, candidateCount?, hint? }
   */
  function resolveLocator(locatorDesc, options) {
    options = options || {};
    const exact = locatorDesc.exact === true;

    // Scope
    let root;
    if (options.scopeSelector) {
      root = document.querySelector(options.scopeSelector);
      if (!root) {
        return {
          found: false,
          locator: locatorDesc,
          candidateCount: 0,
          hint: 'Scope selector ' + options.scopeSelector + ' not found on page',
        };
      }
    } else {
      root = document;
    }

    // Pick strategy
    let matched = [];
    let locatorType = '';
    let candidateCount = 0;
    let allNames = null;

    if (locatorDesc.xpath !== undefined) {
      locatorType = 'xpath';
      const r = resolveByXpath(root, locatorDesc.xpath);
      if (r.malformed !== null) {
        return {
          found: false,
          locator: locatorDesc,
          candidateCount: 0,
          hint: 'Malformed XPath: ' + r.malformed,
        };
      }
      matched = r.matched;
    } else if (locatorDesc.testId !== undefined) {
      locatorType = 'testId';
      matched = resolveByTestId(root, locatorDesc.testId);
    } else if (locatorDesc.role !== undefined) {
      locatorType = locatorDesc.name !== undefined ? 'role+name' : 'role';
      const r = resolveByRole(root, locatorDesc.role, locatorDesc.name, exact);
      matched = r.matched;
      candidateCount = r.candidateCount;
      allNames = r.allNames;
      if (locatorDesc.name !== undefined && matched.length === 0) {
        return {
          found: false,
          locator: locatorDesc,
          candidateCount,
          hint: 'Found ' + candidateCount + ' ' + locatorDesc.role +
            (candidateCount === 1 ? '' : 's') +
            ' but none matched name ' + JSON.stringify(locatorDesc.name) +
            '. Names found: ' + JSON.stringify((allNames || []).slice(0, 10)),
        };
      }
    } else if (locatorDesc.label !== undefined) {
      locatorType = 'label';
      matched = resolveByLabel(root, locatorDesc.label, exact);
    } else if (locatorDesc.placeholder !== undefined) {
      locatorType = 'placeholder';
      matched = resolveByPlaceholder(root, locatorDesc.placeholder, exact);
    } else if (locatorDesc.text !== undefined) {
      locatorType = 'text';
      matched = resolveByText(root, locatorDesc.text, exact);
    } else {
      return {
        found: false,
        locator: {},
        candidateCount: 0,
        hint: 'No locator key provided (need role, text, label, testId, placeholder, or xpath)',
      };
    }

    // filter.hasText narrowing (BEFORE flat nth, matching src/locator.ts order)
    if (locatorDesc.filter && typeof locatorDesc.filter.hasText === 'string') {
      const needle = locatorDesc.filter.hasText.toLowerCase();
      matched = matched.filter((el) => {
        const t = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
        return t.toLowerCase().indexOf(needle) !== -1;
      });
    }

    if (matched.length === 0) {
      return {
        found: false,
        locator: locatorDesc,
        candidateCount: candidateCount || 0,
        hint: 'No elements matched ' + locatorType + ' locator',
      };
    }

    // Flat nth picker (backward-compat; applies BEFORE chain)
    const flatNth = typeof locatorDesc.nth === 'number' ? locatorDesc.nth : 0;
    if (flatNth !== 0 && matched.length > 0) {
      const idx = flatNth < 0 ? matched.length + flatNth : flatNth;
      if (idx < 0 || idx >= matched.length) {
        return {
          found: false,
          locator: locatorDesc,
          candidateCount: matched.length,
          hint: 'nth=' + flatNth + ' is out of range (matched.length=' + matched.length + ')',
        };
      }
      matched = [matched[idx]];
    }

    // T77 chain ops
    if (locatorDesc.chain && locatorDesc.chain.length > 0) {
      for (let ci = 0; ci < locatorDesc.chain.length; ci++) {
        matched = applyChainOp(matched, locatorDesc.chain[ci]);
        if (matched.length === 0) break;
      }
    }

    if (matched.length === 0) {
      return {
        found: false,
        locator: locatorDesc,
        candidateCount: 0,
        hint: 'No elements matched after chain ops',
      };
    }

    // T80 strictnessSatisfied
    let strictnessSatisfied = matched.length === 1;
    if (!strictnessSatisfied) {
      if (locatorDesc.testId || locatorDesc.xpath) strictnessSatisfied = true;
    }
    if (!strictnessSatisfied && typeof locatorDesc.nth === 'number') strictnessSatisfied = true;
    if (!strictnessSatisfied && locatorDesc.chain && locatorDesc.chain.length > 0) {
      const lastOp = locatorDesc.chain[locatorDesc.chain.length - 1];
      if (lastOp && (lastOp.op === 'first' || lastOp.op === 'last' || lastOp.op === 'nth')) {
        strictnessSatisfied = true;
      }
    }

    const target = matched[0];
    const refId = 'sp-' + Math.random().toString(36).substring(2, 8);
    target.setAttribute('data-sp-ref', refId);

    return {
      found: true,
      selector: '[data-sp-ref="' + refId + '"]',
      element: {
        tagName: target.tagName || '',
        id: target.id || '',
        textContent: normalizeWhitespace((target.textContent || '').substring(0, 200)),
      },
      matchCount: matched.length,
      strictnessSatisfied,
    };
  }

  // Expose on window for content-main.js sentinel intercepts.
  window.__SP_LOCATOR__ = {
    querySelectorWithShadow,
    resolveScrollTargets,
    waitForScrollSettle,
    serializeNode,
    matchSignal,
    findPatternRoot,
    dismissPattern,
    resolveLocator,
  };
})();
