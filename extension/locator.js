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

  // Expose on window for content-main.js sentinel intercepts.
  window.__SP_LOCATOR__ = {
    querySelectorWithShadow,
    resolveScrollTargets,
    waitForScrollSettle,
    serializeNode,
  };
})();
