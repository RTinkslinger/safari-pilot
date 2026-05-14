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

  // ── v0.1.35 T10: per-element interactability hints for safari_query_all ───
  //
  // Mirrored as `null` in the AppleScript fallback path (src/locator.ts
  // generateQueryAllJs) — that engine can't compute layered visibility +
  // elementFromPoint coverage without a full DOM. Drift between the two paths
  // (extension returns structured object, AppleScript returns null) is
  // guarded by test/unit/locators/drift-detector.test.ts.
  function buildInteractability(el) {
    if (!(el instanceof Element)) return null;
    const tag = el.tagName.toLowerCase();
    const aria = (n) => el.getAttribute(n);
    const isAriaDisabled = aria('aria-disabled') === 'true';
    const isDisabled = el.hasAttribute('disabled') || isAriaDisabled;
    const role = aria('role') || (tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag === 'a' ? 'link' : null);
    const accessibleName = aria('aria-label') || el.getAttribute('alt') || el.getAttribute('title')
      || ((el.textContent || '').trim().slice(0, 100) || null);
    const rect = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const isVisible = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const isCovered = top != null && top !== el && !el.contains(top);
    return {
      clickable: !isDisabled && (role === 'button' || role === 'link' || tag === 'button' || tag === 'a'),
      fillable: !isDisabled && (role === 'textbox' || tag === 'input' || tag === 'textarea'),
      focusable: !isDisabled && el.tabIndex >= 0,
      role,
      accessibleName,
      isVisible,
      boundingBox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      isCovered,
      isAriaDisabled,
    };
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
   * Shared resolver for resolveLocator + resolveLocatorAll (v0.1.34 T13).
   * Runs the full chain — scope, strategy pick, filter.hasText, flat nth,
   * T77 chain ops — and returns either { matched: HTMLElement[] } on success
   * or { error: {found:false, ...} } on failure. Caller picks first
   * (resolveLocator) or slices to limit (resolveLocatorAll).
   */
  function _resolveMatchedSet(locatorDesc, options) {
    options = options || {};
    const exact = locatorDesc.exact === true;

    // Scope
    let root;
    if (options.scopeSelector) {
      root = document.querySelector(options.scopeSelector);
      if (!root) {
        return { error: {
          found: false,
          locator: locatorDesc,
          candidateCount: 0,
          hint: 'Scope selector ' + options.scopeSelector + ' not found on page',
        } };
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
        return { error: {
          found: false,
          locator: locatorDesc,
          candidateCount: 0,
          hint: 'Malformed XPath: ' + r.malformed,
        } };
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
        return { error: {
          found: false,
          locator: locatorDesc,
          candidateCount,
          hint: 'Found ' + candidateCount + ' ' + locatorDesc.role +
            (candidateCount === 1 ? '' : 's') +
            ' but none matched name ' + JSON.stringify(locatorDesc.name) +
            '. Names found: ' + JSON.stringify((allNames || []).slice(0, 10)),
        } };
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
      return { error: {
        found: false,
        locator: {},
        candidateCount: 0,
        hint: 'No locator key provided (need role, text, label, testId, placeholder, or xpath)',
      } };
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
      return { error: {
        found: false,
        locator: locatorDesc,
        candidateCount: candidateCount || 0,
        hint: 'No elements matched ' + locatorType + ' locator',
      } };
    }

    // Flat nth picker (backward-compat; applies BEFORE chain)
    const flatNth = typeof locatorDesc.nth === 'number' ? locatorDesc.nth : 0;
    if (flatNth !== 0 && matched.length > 0) {
      const idx = flatNth < 0 ? matched.length + flatNth : flatNth;
      if (idx < 0 || idx >= matched.length) {
        return { error: {
          found: false,
          locator: locatorDesc,
          candidateCount: matched.length,
          hint: 'nth=' + flatNth + ' is out of range (matched.length=' + matched.length + ')',
        } };
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
      return { error: {
        found: false,
        locator: locatorDesc,
        candidateCount: 0,
        hint: 'No elements matched after chain ops',
      } };
    }

    return { matched };
  }

  /**
   * Full locator resolution mirroring src/locator.ts generateLocatorJs.
   * Returns: { found, selector?, element?, matchCount?, strictnessSatisfied?, locator?, candidateCount?, hint? }
   */
  function resolveLocator(locatorDesc, options) {
    const r = _resolveMatchedSet(locatorDesc, options);
    if (r.error) return r.error;
    const matched = r.matched;

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

  /**
   * v0.1.34 T13: multi-element locator resolution for safari_query_all.
   * Reuses _resolveMatchedSet for base/filter/nth/chain logic, then maps the
   * full matched array to the same {items, count, limit, truncated} envelope
   * that generateQueryAllJs produced. On failure returns {items:[], count:0,
   * limit, truncated:false} (handler normalizes `found===false` → empty).
   */
  function resolveLocatorAll(locatorDesc, options) {
    options = options || {};
    const limit = (typeof options.limit === 'number' && options.limit > 0) ? options.limit : 100;
    const r = _resolveMatchedSet(locatorDesc, options);
    if (r.error) {
      // Preserve the error envelope so callers can extract `hint` for diagnostics.
      // ExtractionTools.handleQueryAll normalizes `found===false` → empty.
      return Object.assign({}, r.error, { items: [], count: 0, limit, truncated: false });
    }
    const matched = r.matched;
    const truncated = matched.length > limit;
    const slice = matched.slice(0, limit);
    const items = [];
    for (let i = 0; i < slice.length; i++) {
      const el = slice[i];
      const ref = 'sp-' + Math.random().toString(36).substring(2, 8);
      el.setAttribute('data-sp-ref', ref);
      const rect = el.getBoundingClientRect();
      const attrs = {};
      if (el.attributes) {
        for (let ai = 0; ai < el.attributes.length; ai++) {
          const a = el.attributes[ai];
          if (a.name && a.name !== 'data-sp-ref') attrs[a.name] = a.value;
        }
      }
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      items.push({
        ref,
        tagName: el.tagName || '',
        text: normalizeWhitespace((el.innerText !== undefined ? el.innerText : el.textContent) || '').substring(0, 500),
        attrs,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible,
        interactability: buildInteractability(el),
      });
    }
    return { items, count: matched.length, limit, truncated };
  }

  // ── v0.1.34 T14: buildSnapshot — CSP-immune safari_snapshot ─────────────────
  //
  // Mirrors src/aria.ts generateSnapshotJs verbatim — implicit-role map,
  // accessible-name computation, states, interactability, ref stamping,
  // YAML / JSON serialization, refMap. Lifted here so the __SP_SNAPSHOT__
  // sentinel handler in content-main.js can invoke it natively on
  // Trusted-Types-strict pages (no `new Function()` compile).
  const __spImplicitRoleStaticMap = {
    article: 'article',
    aside: 'complementary',
    button: 'button',
    datalist: 'listbox',
    details: 'group',
    dialog: 'dialog',
    fieldset: 'group',
    figure: 'figure',
    footer: 'contentinfo',
    header: 'banner',
    hr: 'separator',
    li: 'listitem',
    main: 'main',
    math: 'math',
    menu: 'list',
    meter: 'meter',
    nav: 'navigation',
    ol: 'list',
    optgroup: 'group',
    option: 'option',
    output: 'status',
    p: 'paragraph',
    pre: 'generic',
    progress: 'progressbar',
    search: 'search',
    table: 'table',
    tbody: 'rowgroup',
    thead: 'rowgroup',
    tfoot: 'rowgroup',
    td: 'cell',
    textarea: 'textbox',
    th: 'columnheader',
    tr: 'row',
    ul: 'list',
  };

  function __spImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = el.getAttribute('role');
    if (role) return role;
    if (tag === 'input') {
      if (el.hasAttribute('list')) return 'combobox';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'email' || type === 'tel' || type === 'text' || type === 'url' || type === '') return 'textbox';
      if (type === 'hidden') return '';
      return 'textbox';
    }
    if (tag === 'select') {
      if (el.hasAttribute('multiple') || (el.hasAttribute('size') && parseInt(el.getAttribute('size'), 10) > 1)) return 'listbox';
      return 'combobox';
    }
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt === '') return 'presentation';
      return 'img';
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    if (tag === 'form') {
      if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return 'form';
      return 'generic';
    }
    if (tag === 'section') {
      if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return 'region';
      return 'generic';
    }
    if (__spImplicitRoleStaticMap[tag]) return __spImplicitRoleStaticMap[tag];
    return 'generic';
  }

  function __spAccessibleName(el) {
    if (typeof el.computedName === 'string' && el.computedName !== '') return el.computedName;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    const title = el.getAttribute('title');
    if (title) return title;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    if (el.labels && el.labels.length > 0) {
      const labelText = el.labels[0].textContent;
      if (labelText) return labelText.trim();
    }
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/);
      let assembled = '';
      for (let li = 0; li < parts.length; li++) {
        const refEl = document.getElementById(parts[li]);
        if (refEl) assembled += (assembled ? ' ' : '') + (refEl.textContent || '').trim();
      }
      if (assembled) return assembled;
    }
    const role = __spImplicitRole(el);
    if (role === 'heading' || role === 'button' || role === 'link' || role === 'tab') {
      const tc = (el.textContent || '').trim();
      if (tc) return tc.length > 80 ? tc.substring(0, 80) : tc;
    }
    return '';
  }

  function __spSkipTag(tag) {
    return tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template';
  }

  function __spIsInteractable(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (tag === 'button') return true;
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() !== 'hidden') return true;
    if (tag === 'select' || tag === 'textarea') return true;
    if (tag === 'summary' || tag === 'details') return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    const role = el.getAttribute('role') || __spImplicitRole(el);
    const interactiveRoles = {
      button: 1, link: 1, checkbox: 1, radio: 1, tab: 1, switch: 1, menuitem: 1,
      menuitemcheckbox: 1, menuitemradio: 1, option: 1, combobox: 1, listbox: 1,
      searchbox: 1, slider: 1, spinbutton: 1, textbox: 1, treeitem: 1,
    };
    if (interactiveRoles[role]) return true;
    if (el.isContentEditable) return true;
    const cs = window.getComputedStyle(el);
    if (cs.pointerEvents === 'none') return false;
    return false;
  }

  function __spStates(el) {
    const states = {};
    if (el.type === 'checkbox' || el.type === 'radio') {
      states.checked = el.checked ? 'true' : 'false';
    } else if (el.getAttribute('aria-checked') !== null) {
      states.checked = el.getAttribute('aria-checked');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') states.disabled = 'true';
    if (el.getAttribute('aria-expanded') !== null) states.expanded = el.getAttribute('aria-expanded');
    if (el.getAttribute('aria-pressed') !== null) states.pressed = el.getAttribute('aria-pressed');
    if (el.selected || el.getAttribute('aria-selected') === 'true') states.selected = 'true';
    const tag = el.tagName.toLowerCase();
    const levelMatch = tag.match(/^h(\d)$/);
    if (levelMatch) {
      states.level = levelMatch[1];
    } else if (el.getAttribute('aria-level') !== null) {
      states.level = el.getAttribute('aria-level');
    }
    if (document.activeElement === el) states.active = 'true';
    if (el.required || el.getAttribute('aria-required') === 'true') states.required = 'true';
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') states.readonly = 'true';
    return states;
  }

  function __spDirectText(el) {
    let text = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) {
        text += el.childNodes[i].nodeValue;
      }
    }
    return text.trim();
  }

  function buildSnapshot(options) {
    options = options || {};
    const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : 15;
    const includeHidden = options.includeHidden === true;
    const format = options.format === 'json' ? 'json' : 'yaml';
    const scopeSelector = options.scopeSelector || '';

    let refCounter = 0;
    const refMap = {};

    function assignRef(el) {
      const existing = el.getAttribute('data-sp-ref');
      if (existing) {
        refMap[existing] = '[data-sp-ref="' + existing + '"]';
        return existing;
      }
      refCounter++;
      const ref = 'e' + refCounter;
      el.setAttribute('data-sp-ref', ref);
      refMap[ref] = '[data-sp-ref="' + ref + '"]';
      return ref;
    }

    function walk(el, depth) {
      if (depth > maxDepth) return null;
      const tag = el.tagName.toLowerCase();
      if (__spSkipTag(tag)) return null;

      const cs = window.getComputedStyle(el);
      const displayContents = cs.display === 'contents';

      if (!includeHidden) {
        if (el.getAttribute('aria-hidden') === 'true') return null;
        if (cs.display === 'none') return null;
      }

      let role;
      if (typeof el.computedRole === 'string' && el.computedRole !== '' && el.computedRole !== 'generic') {
        role = el.computedRole;
      } else {
        role = __spImplicitRole(el);
      }
      const name = __spAccessibleName(el);
      const states = __spStates(el);
      const interactable = __spIsInteractable(el);
      const ref = interactable ? assignRef(el) : null;

      const children = [];
      const childRoot = el.shadowRoot ? el.shadowRoot : el;
      const childEls = childRoot.children;
      if (childEls) {
        for (let ci = 0; ci < childEls.length; ci++) {
          const ch = childEls[ci];
          if (ch.tagName === 'SLOT') {
            const assigned = ch.assignedNodes({ flatten: true });
            for (let ai = 0; ai < assigned.length; ai++) {
              if (assigned[ai].nodeType === 1) {
                const childNode = walk(assigned[ai], depth + 1);
                if (childNode) children.push(childNode);
              }
            }
          } else {
            const childNode = walk(ch, depth + 1);
            if (childNode) children.push(childNode);
          }
        }
      }

      const visHidden = !includeHidden && cs.visibility === 'hidden' && !displayContents;
      if (visHidden) {
        if (children.length === 1) return children[0];
        if (children.length > 1) return { role: 'generic', name: '', states: {}, ref: null, children, interactable: false, tag, el };
        return null;
      }

      if (displayContents && role === 'generic' && !name && !interactable) {
        if (children.length === 1) return children[0];
        if (children.length > 1) return { role: 'generic', name: '', states: {}, ref: null, children, interactable: false, tag, el };
        if (children.length === 0) return null;
      }

      const directText = __spDirectText(el);

      if (role === 'generic' && !name && !interactable && children.length === 1 && children[0].ref) {
        return children[0];
      }

      const hasRole = role && role !== 'generic';
      const hasContent = name || directText || interactable;
      const hasChildren = children.length > 0;

      if (!hasRole && !hasContent && !interactable) {
        if (hasChildren) {
          if (children.length === 1) return children[0];
          return { role: 'generic', name: '', states: {}, ref: null, children, interactable: false, tag, el };
        }
        return null;
      }

      return {
        role: role || 'generic',
        name,
        states,
        ref,
        children,
        interactable,
        tag,
        el,
        directText,
      };
    }

    function serializeYaml(node, depth) {
      if (!node) return '';
      let indent = '';
      for (let i = 0; i < depth; i++) indent += '  ';
      let line = indent + '- ' + node.role;
      if (node.name) {
        const escapedName = node.name.replace(/"/g, '\\"').substring(0, 80);
        line += ' "' + escapedName + '"';
      }
      const stateKeys = Object.keys(node.states || {});
      for (let si = 0; si < stateKeys.length; si++) {
        const sk = stateKeys[si];
        const sv = node.states[sk];
        if (sk === 'level') {
          line += ' [level=' + sv + ']';
        } else if (sv === 'true') {
          line += ' [' + sk + ']';
        } else if (sv !== 'false' && sv !== '') {
          line += ' [' + sk + '=' + sv + ']';
        }
      }
      if (node.ref) line += ' [ref=' + node.ref + ']';
      if (node.tag === 'a' && node.el && node.el.href) {
        try { line += ' /url: "' + new URL(node.el.href).pathname + '"'; } catch (_e) { /* ignore */ }
      }
      if (node.children.length === 0 && node.directText && node.directText !== node.name) {
        line += ': ' + node.directText.substring(0, 80);
      }
      const lines = [line];
      for (let chi = 0; chi < node.children.length; chi++) {
        const childYaml = serializeYaml(node.children[chi], depth + 1);
        if (childYaml) lines.push(childYaml);
      }
      return lines.join('\n');
    }

    function serializeJson(node) {
      if (!node) return null;
      const obj = { role: node.role };
      if (node.name) obj.name = node.name;
      const stateKeys = Object.keys(node.states || {});
      if (stateKeys.length > 0) obj.states = node.states;
      if (node.ref) obj.ref = node.ref;
      if (node.children && node.children.length > 0) {
        obj.children = [];
        for (let ci = 0; ci < node.children.length; ci++) {
          const c = serializeJson(node.children[ci]);
          if (c) obj.children.push(c);
        }
      }
      return obj;
    }

    // Continue ref numbering from the highest existing ref so multi-call
    // snapshots don't collide.
    const existing = document.querySelectorAll('[data-sp-ref]');
    for (let ei = 0; ei < existing.length; ei++) {
      const refVal = existing[ei].getAttribute('data-sp-ref');
      if (refVal && refVal.charAt(0) === 'e') {
        const refNum = parseInt(refVal.substring(1), 10);
        if (!isNaN(refNum) && refNum > refCounter) refCounter = refNum;
      }
    }

    const root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
    if (!root) {
      throw Object.assign(
        new Error('Scope element not found: ' + scopeSelector),
        { name: 'ELEMENT_NOT_FOUND' },
      );
    }

    const tree = walk(root, 0);

    let elementCount = 0;
    let interactiveCount = 0;
    function countNodes(node) {
      if (!node) return;
      elementCount++;
      if (node.interactable) interactiveCount++;
      for (let i = 0; i < node.children.length; i++) countNodes(node.children[i]);
    }
    if (tree) countNodes(tree);

    let snapshot;
    if (format === 'json') {
      snapshot = JSON.stringify(serializeJson(tree), null, 2);
    } else {
      snapshot = tree ? serializeYaml(tree, 0) : '';
    }

    return {
      snapshot,
      url: window.location.href,
      title: document.title,
      elementCount,
      interactiveCount,
      refMap,
    };
  }

  // ── v0.1.34 T15a: smartScrape — CSP-immune safari_smart_scrape ──────────────
  // Ported verbatim from src/tools/structured-extraction.ts handleSmartScrape
  // JS-string body. Five-strategy heuristic per field: label→input, heading→
  // sibling, dt→dd, th→adjacent td, meta tag. Surface preserved verbatim:
  //   { data: { [field]: value | null }, fieldsExtracted: number }
  function smartScrape(opts) {
    const schema = opts && opts.schema ? opts.schema : {};
    const scopeSel = opts && opts.scope ? opts.scope : '';
    const root = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!root) {
      throw Object.assign(new Error('Scope element not found'), { name: 'ELEMENT_NOT_FOUND' });
    }

    function normalise(str) {
      return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function findValueForField(fieldName) {
      const key = normalise(fieldName);

      // 1. label→input pairs
      const labels = root.querySelectorAll('label');
      for (let i = 0; i < labels.length; i++) {
        const lbl = labels[i];
        if (normalise(lbl.textContent) === key || normalise(lbl.textContent).indexOf(key) !== -1) {
          const forId = lbl.getAttribute('for');
          if (forId) {
            const inp = document.getElementById(forId);
            if (inp) return inp.value || inp.textContent || inp.getAttribute('placeholder') || null;
          }
          const nested = lbl.querySelector('input, select, textarea');
          if (nested) return nested.value || null;
        }
      }

      // 2. heading→sibling content pairs
      const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
      for (let h = 0; h < headings.length; h++) {
        const hEl = headings[h];
        if (normalise(hEl.textContent).indexOf(key) !== -1) {
          const next = hEl.nextElementSibling;
          if (next) return (next.innerText || next.textContent || '').trim().slice(0, 500);
        }
      }

      // 3. definition lists (dt→dd)
      const dts = root.querySelectorAll('dt');
      for (let d = 0; d < dts.length; d++) {
        const dt = dts[d];
        if (normalise(dt.textContent).indexOf(key) !== -1) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === 'DD') return (dd.innerText || dd.textContent || '').trim();
        }
      }

      // 4. table headers (th cell) → adjacent td in same row
      const rows = root.querySelectorAll('tr');
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const cells = row.querySelectorAll('th, td');
        for (let c = 0; c < cells.length; c++) {
          if (cells[c].tagName === 'TH' && normalise(cells[c].textContent).indexOf(key) !== -1) {
            const td = cells[c + 1];
            if (td) return (td.innerText || td.textContent || '').trim();
          }
        }
      }

      // 5. meta tags / data attributes
      const metaEl = document.querySelector('meta[name="' + String(fieldName).toLowerCase() + '"]');
      if (metaEl) return metaEl.getAttribute('content');

      return null;
    }

    const result = {};
    const props = schema.properties || schema;
    Object.keys(props).forEach(function (field) {
      result[field] = findValueForField(field);
    });

    return { data: result, fieldsExtracted: Object.keys(result).length };
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
    resolveLocatorAll,
    buildSnapshot,
    smartScrape,
    buildInteractability,
  };
})();
