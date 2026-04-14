/**
 * aria.ts — Playwright-compatible accessibility tree snapshots with element refs.
 *
 * Generates self-contained JavaScript strings for injection into Safari pages via
 * `executeJsInTab()`. The injected JS walks the DOM, builds an ARIA tree, assigns
 * monotonic refs (e1, e2, ...) to interactable elements, stamps them as
 * `data-sp-ref` attributes, and serializes the tree to Playwright-compatible YAML.
 *
 * Refs persist on DOM elements between calls, so later tool invocations can
 * resolve them via `resolveRefJs()` / `buildRefSelector()`.
 */

// ── Public Types ─────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  /** CSS selector to scope the snapshot to a subtree. Omit for full page. */
  scopeSelector?: string;
  /** Maximum DOM traversal depth. Default: 15. */
  maxDepth?: number;
  /** Include elements hidden via display:none, visibility:hidden, aria-hidden. */
  includeHidden?: boolean;
  /** Output format. Default: 'yaml'. */
  format?: 'yaml' | 'json';
}

export interface SnapshotResult {
  snapshot: string;
  url: string;
  title: string;
  elementCount: number;
  interactiveCount: number;
  refMap: Record<string, string>;
}

// ── Ref Utilities ────────────────────────────────────────────────────────────

/**
 * Build a CSS selector that targets a ref-stamped element.
 * Safe for use in `querySelector()` or tool parameters.
 */
export function buildRefSelector(ref: string): string {
  return '[data-sp-ref="' + ref + '"]';
}

/**
 * Return a JS string that resolves a ref to its DOM element.
 * Evaluates to `null` if the ref no longer exists on the page.
 */
export function resolveRefJs(ref: string): string {
  // Validate ref format to prevent injection
  if (!/^e\d+$/.test(ref)) {
    throw new Error('Invalid ref format: expected "eN" where N is a positive integer');
  }
  return 'document.querySelector(\'[data-sp-ref="' + ref + '"]\')';
}

// ── Snapshot JS Generator ────────────────────────────────────────────────────

/**
 * Generate a self-contained JavaScript string that, when executed in a browser
 * page, walks the DOM and returns a Playwright-compatible accessibility snapshot.
 *
 * The returned string is an IIFE wrapped for the `executeJsInTab` harness —
 * it uses `return` to hand back the result object.
 *
 * All JS uses `var` (no let/const), no backticks, no arrow functions, for
 * maximum Safari compatibility.
 */
export function generateSnapshotJs(options: SnapshotOptions = {}): string {
  var maxDepth = options.maxDepth ?? 15;
  var includeHidden = options.includeHidden ?? false;
  var format = options.format ?? 'yaml';
  // Escape single quotes in selector for safe embedding
  var scopeSelector = options.scopeSelector
    ? options.scopeSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    : '';

  // The entire JS payload as a single string. No backticks anywhere inside —
  // concatenation with + is intentional for AppleScript safety.
  return (
    'var __spMaxDepth = ' + maxDepth + ';' +
    'var __spInclHidden = ' + includeHidden + ';' +
    'var __spScopeSelector = \'' + scopeSelector + '\';' +
    'var __spFormat = \'' + format + '\';' +
    'var __spRefCounter = 0;' +
    'var __spRefMap = {};' +
    // DQ = double-quote character. Used in YAML serialization to avoid
    // multi-layer escaping issues in the TS→JS→AppleScript→browser chain.
    'var __spDQ = String.fromCharCode(34);' +
    // BS = backslash character.
    'var __spBS = String.fromCharCode(92);' +

    // ── Implicit Role Map (W3C HTML-ARIA + Playwright source) ──────────
    'function __spImplicitRole(el) {' +
      'var tag = el.tagName.toLowerCase();' +
      'var type = (el.getAttribute("type") || "").toLowerCase();' +
      'var role = el.getAttribute("role");' +
      'if (role) return role;' +

      // Input types first (most specific)
      'if (tag === "input") {' +
        'if (el.hasAttribute("list")) return "combobox";' +
        'if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";' +
        'if (type === "checkbox") return "checkbox";' +
        'if (type === "radio") return "radio";' +
        'if (type === "range") return "slider";' +
        'if (type === "number") return "spinbutton";' +
        'if (type === "search") return "searchbox";' +
        'if (type === "email" || type === "tel" || type === "text" || type === "url" || type === "") return "textbox";' +
        'if (type === "hidden") return "";' +
        'return "textbox";' +
      '}' +

      // Select
      'if (tag === "select") {' +
        'if (el.hasAttribute("multiple") || (el.hasAttribute("size") && parseInt(el.getAttribute("size"), 10) > 1)) return "listbox";' +
        'return "combobox";' +
      '}' +

      // Anchors
      'if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";' +

      // Images
      'if (tag === "img") {' +
        'var alt = el.getAttribute("alt");' +
        'if (alt === "") return "presentation";' +
        'return "img";' +
      '}' +

      // Headings
      'if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";' +

      // Form with accessible name → form, otherwise generic
      'if (tag === "form") {' +
        'if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return "form";' +
        'return "generic";' +
      '}' +

      // Section with accessible name → region, otherwise generic
      'if (tag === "section") {' +
        'if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return "region";' +
        'return "generic";' +
      '}' +

      // Static role map
      'var staticMap = {' +
        '"article": "article",' +
        '"aside": "complementary",' +
        '"button": "button",' +
        '"datalist": "listbox",' +
        '"details": "group",' +
        '"dialog": "dialog",' +
        '"fieldset": "group",' +
        '"figure": "figure",' +
        '"footer": "contentinfo",' +
        '"header": "banner",' +
        '"hr": "separator",' +
        '"li": "listitem",' +
        '"main": "main",' +
        '"math": "math",' +
        '"menu": "list",' +
        '"meter": "meter",' +
        '"nav": "navigation",' +
        '"ol": "list",' +
        '"optgroup": "group",' +
        '"option": "option",' +
        '"output": "status",' +
        '"p": "paragraph",' +
        '"pre": "generic",' +
        '"progress": "progressbar",' +
        '"search": "search",' +
        '"table": "table",' +
        '"tbody": "rowgroup",' +
        '"thead": "rowgroup",' +
        '"tfoot": "rowgroup",' +
        '"td": "cell",' +
        '"textarea": "textbox",' +
        '"th": "columnheader",' +
        '"tr": "row",' +
        '"ul": "list"' +
      '};' +
      'if (staticMap[tag]) return staticMap[tag];' +

      // Fallback
      'return "generic";' +
    '}' +

    // ── Accessible Name Computation ──────────────────────────────────────
    // Safari 16.4+ has computedRole/computedName but WebKit bugs mean empty
    // for nested labels. We use computedName with fallback chain.
    'function __spAccessibleName(el) {' +
      // Try native computedName first (Safari 16.4+)
      'if (typeof el.computedName === "string" && el.computedName !== "") return el.computedName;' +
      // Fallback chain for WebKit bugs
      'var ariaLabel = el.getAttribute("aria-label");' +
      'if (ariaLabel) return ariaLabel;' +
      'var alt = el.getAttribute("alt");' +
      'if (alt) return alt;' +
      'var title = el.getAttribute("title");' +
      'if (title) return title;' +
      'var placeholder = el.getAttribute("placeholder");' +
      'if (placeholder) return placeholder;' +
      // Label association
      'if (el.labels && el.labels.length > 0) {' +
        'var labelText = el.labels[0].textContent;' +
        'if (labelText) return labelText.trim();' +
      '}' +
      // aria-labelledby
      'var labelledBy = el.getAttribute("aria-labelledby");' +
      'if (labelledBy) {' +
        'var parts = labelledBy.split(/\\s+/);' +
        'var assembled = "";' +
        'for (var li = 0; li < parts.length; li++) {' +
          'var refEl = document.getElementById(parts[li]);' +
          'if (refEl) assembled += (assembled ? " " : "") + (refEl.textContent || "").trim();' +
        '}' +
        'if (assembled) return assembled;' +
      '}' +
      // For heading/button/link: use direct text content (no deep extraction)
      'var role = __spImplicitRole(el);' +
      'if (role === "heading" || role === "button" || role === "link" || role === "tab") {' +
        'var tc = (el.textContent || "").trim();' +
        'if (tc) return tc.length > 80 ? tc.substring(0, 80) : tc;' +
      '}' +
      'return "";' +
    '}' +

    // ── Should Skip Tag ──────────────────────────────────────────────────
    'function __spSkipTag(tag) {' +
      'return tag === "script" || tag === "style" || tag === "noscript" || tag === "template";' +
    '}' +

    // ── Interactability Check ────────────────────────────────────────────
    'function __spIsInteractable(el) {' +
      'var tag = el.tagName.toLowerCase();' +
      // Natively focusable/clickable elements
      'if (tag === "a" && el.hasAttribute("href")) return true;' +
      'if (tag === "button") return true;' +
      'if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() !== "hidden") return true;' +
      'if (tag === "select" || tag === "textarea") return true;' +
      'if (tag === "summary" || tag === "details") return true;' +
      // tabindex makes anything focusable
      'if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;' +
      // ARIA interactive roles
      'var role = el.getAttribute("role") || __spImplicitRole(el);' +
      'var interactiveRoles = {' +
        '"button":1,"link":1,"checkbox":1,"radio":1,"tab":1,"switch":1,"menuitem":1,' +
        '"menuitemcheckbox":1,"menuitemradio":1,"option":1,"combobox":1,"listbox":1,' +
        '"searchbox":1,"slider":1,"spinbutton":1,"textbox":1,"treeitem":1' +
      '};' +
      'if (interactiveRoles[role]) return true;' +
      // contenteditable
      'if (el.isContentEditable) return true;' +
      // Pointer events check — if pointer-events: none, not interactable
      'var cs = window.getComputedStyle(el);' +
      'if (cs.pointerEvents === "none") return false;' +
      'return false;' +
    '}' +

    // ── Compute States ───────────────────────────────────────────────────
    'function __spStates(el) {' +
      'var states = {};' +
      // checked (checkbox, radio, switch, aria-checked)
      'if (el.type === "checkbox" || el.type === "radio") {' +
        'states.checked = el.checked ? "true" : "false";' +
      '} else if (el.getAttribute("aria-checked") !== null) {' +
        'states.checked = el.getAttribute("aria-checked");' +
      '}' +
      // disabled
      'if (el.disabled || el.getAttribute("aria-disabled") === "true") states.disabled = "true";' +
      // expanded
      'if (el.getAttribute("aria-expanded") !== null) states.expanded = el.getAttribute("aria-expanded");' +
      // pressed
      'if (el.getAttribute("aria-pressed") !== null) states.pressed = el.getAttribute("aria-pressed");' +
      // selected
      'if (el.selected || el.getAttribute("aria-selected") === "true") states.selected = "true";' +
      // level (headings)
      'var tag = el.tagName.toLowerCase();' +
      'var levelMatch = tag.match(/^h(\\d)$/);' +
      'if (levelMatch) {' +
        'states.level = levelMatch[1];' +
      '} else if (el.getAttribute("aria-level") !== null) {' +
        'states.level = el.getAttribute("aria-level");' +
      '}' +
      // active
      'if (document.activeElement === el) states.active = "true";' +
      // required
      'if (el.required || el.getAttribute("aria-required") === "true") states.required = "true";' +
      // readonly
      'if (el.readOnly || el.getAttribute("aria-readonly") === "true") states.readonly = "true";' +
      'return states;' +
    '}' +

    // ── Assign Ref ───────────────────────────────────────────────────────
    'function __spAssignRef(el) {' +
      // Reuse existing ref if already stamped
      'var existing = el.getAttribute("data-sp-ref");' +
      'if (existing) {' +
        '__spRefMap[existing] = \'[data-sp-ref="\' + existing + \'"]\';' +
        'return existing;' +
      '}' +
      '__spRefCounter++;' +
      'var ref = "e" + __spRefCounter;' +
      'el.setAttribute("data-sp-ref", ref);' +
      '__spRefMap[ref] = \'[data-sp-ref="\' + ref + \'"]\';' +
      'return ref;' +
    '}' +

    // ── Get Direct Text (non-child-element text) ─────────────────────────
    'function __spDirectText(el) {' +
      'var text = "";' +
      'for (var i = 0; i < el.childNodes.length; i++) {' +
        'if (el.childNodes[i].nodeType === 3) {' +
          'text += el.childNodes[i].nodeValue;' +
        '}' +
      '}' +
      'return text.trim();' +
    '}' +

    // ── Tree Walk ────────────────────────────────────────────────────────
    'function __spWalk(el, depth) {' +
      'if (depth > __spMaxDepth) return null;' +
      'var tag = el.tagName.toLowerCase();' +
      'if (__spSkipTag(tag)) return null;' +

      'var cs = window.getComputedStyle(el);' +
      'var displayContents = cs.display === "contents";' +

      // Visibility check (display:none hides entirely, aria-hidden hides entirely)
      'if (!__spInclHidden) {' +
        'if (el.getAttribute("aria-hidden") === "true") return null;' +
        'if (cs.display === "none") return null;' +
      '}' +

      // Compute role and name
      'var role;' +
      'if (typeof el.computedRole === "string" && el.computedRole !== "" && el.computedRole !== "generic") {' +
        'role = el.computedRole;' +
      '} else {' +
        'role = __spImplicitRole(el);' +
      '}' +
      'var name = __spAccessibleName(el);' +
      'var states = __spStates(el);' +
      'var interactable = __spIsInteractable(el);' +
      'var ref = interactable ? __spAssignRef(el) : null;' +

      // Walk children — enter shadow roots, resolve <slot> assigned nodes
      'var children = [];' +
      'var childRoot = el.shadowRoot ? el.shadowRoot : el;' +
      'var childEls = childRoot.children;' +
      'if (childEls) {' +
        'for (var ci = 0; ci < childEls.length; ci++) {' +
          'var ch = childEls[ci];' +
          'if (ch.tagName === "SLOT") {' +
            'var assigned = ch.assignedNodes({flatten: true});' +
            'for (var ai = 0; ai < assigned.length; ai++) {' +
              'if (assigned[ai].nodeType === 1) {' +
                'var childNode = __spWalk(assigned[ai], depth + 1);' +
                'if (childNode) children.push(childNode);' +
              '}' +
            '}' +
          '} else {' +
            'var childNode = __spWalk(ch, depth + 1);' +
            'if (childNode) children.push(childNode);' +
          '}' +
        '}' +
      '}' +

      // Determine if this node is visible but has no role contribution
      // Elements with display:contents are transparent wrappers
      'var visHidden = !__spInclHidden && cs.visibility === "hidden" && !displayContents;' +
      'if (visHidden) {' +
        // visibility:hidden elements are skipped but their children walk
        // (children can override visibility). Return children directly.
        'if (children.length === 1) return children[0];' +
        'if (children.length > 1) return { role: "generic", name: "", states: {}, ref: null, children: children, interactable: false, tag: tag, el: el };' +
        'return null;' +
      '}' +

      // For display:contents, act as transparent wrapper
      'if (displayContents && role === "generic" && !name && !interactable) {' +
        'if (children.length === 1) return children[0];' +
        'if (children.length > 1) return { role: "generic", name: "", states: {}, ref: null, children: children, interactable: false, tag: tag, el: el };' +
        'if (children.length === 0) return null;' +
      '}' +

      // Get inline text (non-element children)
      'var directText = __spDirectText(el);' +

      // Skip generic wrappers with no name that have a single child with a ref
      'if (role === "generic" && !name && !interactable && children.length === 1 && children[0].ref) {' +
        'return children[0];' +
      '}' +

      // Determine if this node contributes to the tree
      'var hasRole = role && role !== "generic";' +
      'var hasContent = name || directText || interactable;' +
      'var hasChildren = children.length > 0;' +

      // Skip role-less, name-less, content-less nodes: hoist children
      'if (!hasRole && !hasContent && !interactable) {' +
        'if (hasChildren) {' +
          'if (children.length === 1) return children[0];' +
          'return { role: "generic", name: "", states: {}, ref: null, children: children, interactable: false, tag: tag, el: el };' +
        '}' +
        'return null;' +
      '}' +

      'return {' +
        'role: role || "generic",' +
        'name: name,' +
        'states: states,' +
        'ref: ref,' +
        'children: children,' +
        'interactable: interactable,' +
        'tag: tag,' +
        'el: el,' +
        'directText: directText' +
      '};' +
    '}' +

    // ── YAML Serializer ──────────────────────────────────────────────────
    'function __spSerializeYaml(node, depth) {' +
      'if (!node) return "";' +
      'var indent = "";' +
      'for (var i = 0; i < depth; i++) indent += "  ";' +

      'var line = indent + "- " + node.role;' +
      // Name — escape double quotes inside names for YAML output
      'if (node.name) {' +
        'var escapedName = node.name.replace(new RegExp(__spDQ, "g"), __spBS + __spDQ).substring(0, 80);' +
        'line += " " + __spDQ + escapedName + __spDQ;' +
      '}' +

      // States as attributes
      'var stateKeys = [];' +
      'for (var sk in node.states) {' +
        'if (node.states.hasOwnProperty(sk)) stateKeys.push(sk);' +
      '}' +
      'for (var si = 0; si < stateKeys.length; si++) {' +
        'var sk2 = stateKeys[si];' +
        'var sv = node.states[sk2];' +
        'if (sk2 === "level") {' +
          'line += " [level=" + sv + "]";' +
        '} else if (sv === "true") {' +
          'line += " [" + sk2 + "]";' +
        '} else if (sv !== "false" && sv !== "") {' +
          'line += " [" + sk2 + "=" + sv + "]";' +
        '}' +
      '}' +

      // Ref
      'if (node.ref) line += " [ref=" + node.ref + "]";' +

      // Link URL
      'if (node.tag === "a" && node.el && node.el.href) {' +
        'try { line += " /url: " + __spDQ + new URL(node.el.href).pathname + __spDQ; } catch(e) {}' +
      '}' +

      // If leaf with direct text and no children, inline it
      'if (node.children.length === 0 && node.directText && node.directText !== node.name) {' +
        'var inlineText = node.directText.substring(0, 80);' +
        'line += ": " + inlineText;' +
      '}' +

      'var lines = [line];' +

      // Recurse children
      'for (var chi = 0; chi < node.children.length; chi++) {' +
        'var childYaml = __spSerializeYaml(node.children[chi], depth + 1);' +
        'if (childYaml) lines.push(childYaml);' +
      '}' +

      'return lines.join("\\n");' +
    '}' +

    // ── JSON Serializer ──────────────────────────────────────────────────
    'function __spSerializeJson(node) {' +
      'if (!node) return null;' +
      'var obj = { role: node.role };' +
      'if (node.name) obj.name = node.name;' +
      'var stateKeys = [];' +
      'for (var sk in node.states) {' +
        'if (node.states.hasOwnProperty(sk)) stateKeys.push(sk);' +
      '}' +
      'if (stateKeys.length > 0) obj.states = node.states;' +
      'if (node.ref) obj.ref = node.ref;' +
      'if (node.children && node.children.length > 0) {' +
        'obj.children = [];' +
        'for (var ci = 0; ci < node.children.length; ci++) {' +
          'var c = __spSerializeJson(node.children[ci]);' +
          'if (c) obj.children.push(c);' +
        '}' +
      '}' +
      'return obj;' +
    '}' +

    // ── Main ─────────────────────────────────────────────────────────────
    // Find highest existing ref to continue numbering from there
    'var __spExisting = document.querySelectorAll("[data-sp-ref]");' +
    'for (var ei = 0; ei < __spExisting.length; ei++) {' +
      'var refVal = __spExisting[ei].getAttribute("data-sp-ref");' +
      'var refNum = parseInt(refVal.substring(1), 10);' +
      'if (refNum > __spRefCounter) __spRefCounter = refNum;' +
    '}' +

    'var __spRoot = __spScopeSelector ? document.querySelector(__spScopeSelector) : document.body;' +
    'if (!__spRoot) throw Object.assign(new Error("Scope element not found: " + __spScopeSelector), { name: "ELEMENT_NOT_FOUND" });' +

    'var __spTree = __spWalk(__spRoot, 0);' +

    // Count nodes
    'var __spElementCount = 0;' +
    'var __spInteractiveCount = 0;' +
    'function __spCount(node) {' +
      'if (!node) return;' +
      '__spElementCount++;' +
      'if (node.interactable) __spInteractiveCount++;' +
      'for (var i = 0; i < node.children.length; i++) __spCount(node.children[i]);' +
    '}' +
    'if (__spTree) __spCount(__spTree);' +

    'var __spSnapshot;' +
    'if (__spFormat === "json") {' +
      '__spSnapshot = JSON.stringify(__spSerializeJson(__spTree), null, 2);' +
    '} else {' +
      '__spSnapshot = __spTree ? __spSerializeYaml(__spTree, 0) : "";' +
    '}' +

    'return {' +
      'snapshot: __spSnapshot,' +
      'url: window.location.href,' +
      'title: document.title,' +
      'elementCount: __spElementCount,' +
      'interactiveCount: __spInteractiveCount,' +
      'refMap: __spRefMap' +
    '};'
  );
}
