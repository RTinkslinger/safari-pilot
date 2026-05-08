# WebVoyager Evidence-Grounding Sprint (v0.1.31)

**Status:** Approved design, ready for implementation plan
**Author:** Aakash Kumar
**Date:** 2026-05-08
**Branch (TBD at impl start):** `feat/v0131-evidence-grounding`
**Target release:** v0.1.31
**Schedule:** 9-10 days hard floor

---

## 1. Background

v0.1.30 shipped `safari_take_screenshot` WebView capture (Safari `tabs.captureVisibleTab` API). The 67-task partial WebVoyager dev-sample baseline (`bench-runs/webvoyager-v0.1.30-baseline-20260508-050932/`) shows:

- 38/67 SUCCESS (56.7%)
- 22 FAILURE (32.8%)
- 7 UNKNOWN — capture failed (10.4%)

Failure analysis on the partial baseline categorized 22 FAILURE + 7 UNKNOWN into addressable modes:

| Mode | Count | Examples |
|---|---|---|
| **A** Screenshot/answer mismatch — agent extracted correct answer but viewport didn't show evidence | 9 | Apple-12/13/19/25/37/41 (slogans, colors, processor, prices), ArXiv-18, BBC-41 |
| **B** Genuine task incompleteness — agent gave up early on filter/sort | 5 | Amazon-3/8/10, ArXiv-23/26 |
| **C** Hallucination — agent answered from prior, not page DOM | 3 | BBC-28 (discontinued feed), BBC-39 (race count), Booking-18 |
| **D** External overlay / 3rd-party bot wall | 3 | ArXiv-41, BBC-12 (registration wall), Amazon-5 (silent hang) |
| **E** Date-impossible task (resolvable via temporal substitution) | 1+ on full 175 | Apple-9 (Jan 10, 2024 read in 2026) |
| **F** Quota exhaustion mid-task | 1 | Booking-14 (operational, not product) |
| **G** UNKNOWN — capture failed entirely | 7 | Amazon bot wall (3), BBC overlay (3), Booking quota (1) |

This sprint targets four interventions across modes A, C, D, E:

- **I1** Scroll-to-evidence — close capability gap that produces mode A
- **I2** Overlay dismissal — close capability gap that produces mode D and parts of mode G
- **I3** Visible-content grounding — strategy guidance that mitigates mode C
- **I8** Temporal substitution — strategy guidance that mitigates mode E

## 2. Product framing

Safari Pilot is a Claude Code plugin distributed via npm + GitHub plugin marketplace. Real users (anyone running Claude Code with the plugin installed) hit the same capability gaps as the bench harness — they just have lower-stakes recovery (a person can scroll/dismiss themselves). The benchmark is the litmus test for joint-capability lift; it is not the product surface.

**Plugin surfaces this sprint uses:**
- 2 new MCP tools (extension-engine, sentinel-routed)
- 4 new plugin skills (1 procedural + 3 strategy/markdown)
- 1 new slash command (local metrics CLI)
- Existing `SessionStart` hook gets a 2-line addition (today's date injection)
- 0 new hooks (existing 2-hook budget intact)

**Explicitly NOT touched:**
- `bench/webvoyager/adapter.ts buildPrompt` — bench-harness prompt edits would lift the score without changing the product. This is the discipline boundary.
- `daemon/Sources/` Swift code — no IPC schema bump required
- `src/security/` pipeline — no new layers
- Existing tool behavior (`safari_navigate`, `safari_take_screenshot`, etc.)

## 3. Architecture overview

The plugin already has the layered structure to absorb this cleanly. Every new piece is additive and surgical: new methods on existing tool classes, a new tool class peer to existing ones, new sentinel branches in the existing `executeCommand` switch, new skill files registered in the manifest.

```
.claude-plugin/plugin.json
├── components.skills[] — append 4 new entries; FIX existing 3-skill registration discrepancy
├── components.commands — append 1 new (stats)
├── components.mcpServers.safari — unchanged config; new tools registered server-side
└── components.hooks — unchanged; SessionStart script body gets +2 lines

src/
├── types.ts                  — uses existing requiresAsyncJs; no new flag
├── errors.ts                 — +2 metadata-only codes (TARGET_NOT_FOUND, TARGET_HIDDEN)
├── engine-selector.ts        — no change (requiresAsyncJs already routes to ExtensionEngine)
├── overlays/                 — NEW dir
│   ├── index.ts              — allowlist loader + schema validator
│   ├── cookie-consent.json
│   ├── registration-walls.json
│   ├── app-install.json
│   └── paywalls.json
├── tools/
│   ├── interaction.ts        — +safari_scroll_to_element handler + tool def
│   └── overlays.ts           — NEW OverlayTools class
├── server.ts                 — register OverlayTools alongside existing tool classes
└── cli/                      — NEW dir
    ├── stats.ts              — NDJSON aggregator
    └── format.ts             — table-printer

extension/
├── locator.js                — NEW: resolveScrollTargets, querySelectorWithShadow
└── background.js             — +2 sentinel branches (prefix-and-JSON convention)

skills/
├── safari-pilot/SKILL.md     — existing
├── login.SKILL.md            — existing, ALREADY ON DISK BUT UNREGISTERED (fix in scope)
├── paginate-and-scrape.SKILL.md — same
├── robust-form-fill.SKILL.md — same
├── evidence-grounded-screenshot.SKILL.md  — NEW (procedural)
├── dismiss-overlays-recovery.SKILL.md     — NEW (strategy/markdown)
├── visible-evidence-grounding.SKILL.md    — NEW (strategy/markdown)
└── temporal-substitution.SKILL.md         — NEW (strategy/markdown)

commands/
├── start.md, stop.md         — existing
└── stats.md                  — NEW slash-command wrapper

hooks/
└── session-start.sh          — append 2 lines for today's date injection

test/
├── fixtures/                 — +9 new localhost fixture servers
├── unit/                     — +4 new test files
└── e2e/                      — +3 new test files (+ ~14 per-pattern integration tests under e2e/overlays/)
```

**Engine selection:** Both new tools use existing `requiresAsyncJs: true` flag in `ToolRequirements`. `engine-selector.ts requiresExtension()` already enumerates this flag; both tools route to ExtensionEngine. Fail-closed: if extension unavailable, `EngineUnavailableError` thrown. No daemon-AppleScript fallback (can't traverse DOM).

**Security pipeline:** Both new tools pass through all 9 existing layers without special-casing. TabOwnership applies (must call `safari_new_tab` first to register URL). `IdpiAnnotator` is extended (see §5.5) to scan `safari_dismiss_overlays` output as well as extraction results.

**Trace capture:** Both tools' calls land in `~/.safari-pilot/trace.ndjson` via existing `AuditLog`. `safari_dismiss_overlays` writes per-dismissal entries (one per pattern dismissed). Feeds the new `/safari-pilot:stats` CLI.

## 4. Tool 1 — `safari_scroll_to_element`

### 4.1 Contract

```typescript
{
  name: 'safari_scroll_to_element',
  description:
    'Scroll a specific element into the visible viewport. Provide one of '
    + '{selector, text, role+name} — the tool resolves to a DOM node and '
    + 'scrolls it to vertical center. Useful before safari_take_screenshot '
    + 'when the answer-bearing content is off-screen, or to bring a section '
    + 'into focus after navigation. On multi-match, scrolls to first match '
    + 'and returns the full candidate list.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl:   { type: 'string', format: 'uri' },
      selector: { type: 'string', description: 'CSS selector (preferred when known)' },
      text:     { type: 'string', description: 'Visible text substring (case-insensitive, whitespace-normalized). Matches DOM textContent only — does NOT match form values.' },
      role:     { type: 'string', description: 'ARIA role (e.g. "button", "heading")' },
      name:     { type: 'string', description: 'Accessible name for role-based lookup' },
      nth:      { type: 'integer', minimum: 0, description: '0-based index when multiple matches; INVALID_PARAMS if out of range' },
      behavior: { type: 'string', enum: ['instant', 'smooth'], default: 'instant' }
    },
    required: ['tabUrl'],
    additionalProperties: false
  },
  requirements: { requiresAsyncJs: true, idempotent: true }
}
```

Resolution precedence: `selector` > `role+name` > `text`. At least one of `{selector, text, role}` required → `INVALID_PARAMS` otherwise.

### 4.2 Success response

```typescript
metadata: {
  engine: 'extension',
  elapsed_ms: number,
  scrolledTo: {
    strategy: 'selector' | 'role' | 'text',
    matchedNode: {
      tagName: string,
      role?: string,
      text: string,            // first 80 chars only — privacy/leak mitigation per §11
      xpath: string,           // structural only, no text content
      bbox: { x, y, width, height }
    },
    matchCount: number,
    allMatches?: Array<{ tagName, role?, text, xpath }>  // present when matchCount > 1, max 5 entries
  },
  viewport: { scrollX, scrollY, innerWidth, innerHeight },
  scrolledFromY: number
}
```

Scroll uses `element.scrollIntoView({ behavior, block: 'center', inline: 'nearest' })`. `block: 'center'` mitigates sticky-header occlusion.

### 4.3 Error envelope

Two new metadata-only codes added to `src/errors.ts ERROR_CODES` (string-only) + `ERROR_METADATA`. Follows v0.1.30 precedent (`WINDOW_CLOSED`, `CAPTURE_RACE` are data-only, no concrete `SafariPilotError` subclass).

| Code | When | Retryable | Hint |
|---|---|---|---|
| `TARGET_NOT_FOUND` | No element matches `{selector\|text\|role}` (visible or hidden), OR target is in cross-origin iframe | false | "No element matched the provided locator. If target is in a cross-origin iframe, the locator cannot reach it. Try a broader text substring, a different selector, or call safari_get_text to inspect page structure." |
| `TARGET_HIDDEN` | Match exists but `offsetParent === null` or zero bbox | false | "Element exists but is display:none, visibility:hidden, or inside a closed `<details>`. The agent may need to expand a parent element first. Tool does NOT auto-expand (idempotency)." |
| `INVALID_PARAMS` (existing) | None of `{selector, text, role}` provided, or `nth` out of range | false | "Provide at least one of selector, text, or role. nth must be < matchCount." |

Cross-origin frames return `TARGET_NOT_FOUND` with cross-origin hint in the message — no separate error code (`CROSS_ORIGIN_FRAME` was deliberately deleted in SD-22 per `errors.ts:55-58`; spec respects that precedent).

### 4.4 Sentinel implementation

`extension/background.js` gets a new branch in the `executeCommand` switch using the **prefix-and-JSON convention** (consistent with existing `__SP_DNR_*:<json>`, `__SP_FILE_UPLOAD__:<json>`):

```javascript
if (cmd.script.startsWith('__SP_SCROLL_TO_ELEMENT__:')) {
  const args = JSON.parse(cmd.script.slice('__SP_SCROLL_TO_ELEMENT__:'.length));
  const { selector, text, role, name, nth = 0, behavior = 'instant' } = args;
  try {
    const candidates = resolveScrollTargets({ selector, text, role, name });  // helper in extension/locator.js
    if (candidates.length === 0) {
      const hidden = resolveScrollTargets({ selector, text, role, name, includeHidden: true });
      if (hidden.length > 0) {
        return { ok: false, error: { name: 'TARGET_HIDDEN', message: '...' } };
      }
      return { ok: false, error: { name: 'TARGET_NOT_FOUND', message: '...' } };
    }
    if (nth >= candidates.length) {
      return { ok: false, error: { name: 'INVALID_PARAMS', message: 'nth out of range' } };
    }
    const target = candidates[nth];
    const fromY = window.scrollY;
    target.element.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
    await waitForScrollSettle(500);  // RAF + 50ms grace, capped at 500ms
    return { ok: true, value: { /* per §4.2 */ } };
  } catch (e) {
    return { ok: false, error: { name: 'TARGET_NOT_FOUND', message: String(e) } };
  }
}
```

`extension/locator.js` (~250 lines, new file): `resolveScrollTargets()` encodes precedence (selector → role+name → text), visibility filtering (`offsetParent !== null && bbox.height > 0`), and same-origin iframe traversal. Cross-origin iframes are detected and excluded (their candidates count as zero matches → `TARGET_NOT_FOUND`).

### 4.5 Edge cases handled

| Case | Behavior |
|---|---|
| Sticky/fixed headers occluding target | `block: 'center'` puts target at viewport center, generally clears typical 60-80px sticky headers |
| Closed `<details>` ancestor | Tool returns `TARGET_HIDDEN` with hint to expand. **Does NOT auto-expand** (idempotency contract) |
| Virtualized list (target not yet in DOM) | `TARGET_NOT_FOUND` returned. Agent must scroll the container or wait, then retry |
| Text inside `<input value=>` or `<textarea>` | NOT matched. Spec: `text:` matches DOM textContent only |
| Same-origin iframe | Traversed; targets reachable |
| Cross-origin iframe | Excluded; targets count as zero matches → `TARGET_NOT_FOUND` |
| SPA route change after scroll triggers lazy-load | Agent must re-verify `tabUrl`. Subsequent calls may hit `TabUrlNotRecognizedError` from TabOwnership layer — this is correct behavior, not a regression |
| Multi-match (e.g., 4 nodes for "A15 Bionic") | Scroll to first; return `matchCount: 4` and `allMatches[]` (capped at 5 entries). Agent disambiguates with `nth` or specific selector |
| Page still loading | No special handling. Agent should `safari_wait_for` first if needed |

## 5. Tool 2 — `safari_dismiss_overlays`

### 5.1 Contract

```typescript
{
  name: 'safari_dismiss_overlays',
  description:
    'Detect and dismiss known overlay patterns (cookie consent banners, '
    + 'registration walls, app-install prompts, certain paywalls) using a '
    + 'curated allowlist of DOM signatures. Returns a manifest of what was '
    + 'dismissed and what was detected-but-not-dismissed. NEVER dismisses '
    + 'arbitrary modals — only allowlisted patterns. If an overlay is '
    + 'blocking content, call this before extraction or screenshot.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl:     { type: 'string', format: 'uri' },
      categories: {
        type: 'array',
        items: { type: 'string', enum: ['cookie-consent', 'registration-wall', 'app-install', 'paywall'] },
        description: 'Restrict to these categories. Default: all.'
      }
    },
    required: ['tabUrl'],
    additionalProperties: false
  },
  requirements: { requiresAsyncJs: true, requiresShadowDom: true, idempotent: true }
}
```

### 5.2 Success response (does NOT throw on no-match)

```typescript
metadata: {
  engine: 'extension',
  elapsed_ms: number,
  dismissed: Array<{
    category: 'cookie-consent' | 'registration-wall' | 'app-install' | 'paywall',
    id: string,            // pattern ID from allowlist (e.g. 'onetrust-banner')
    selector: string,      // matched root selector (sanitized; see §5.5)
    action: 'click' | 'esc-key' | 'remove-node',
    site: string,          // tabUrl host
    verified: boolean      // overlay confirmed gone after 250ms stability check
  }>,
  skipped: Array<{
    reason: 'allowlist_miss' | 'click_failed' | 'verify_failed_overlay_persists'
          | 'shadow_dom_penetration_failed' | 'two_signal_check_failed',
    candidate?: { selector?: string, category?: string, hint?: string }
  }>,
  overlaysAtStart: number,
  overlaysAtEnd: number
}
```

The `dismissed[]` entries are **id-only sanitized** (no `aria-label`, no extracted text, no `name` field). Page-injected hostile strings cannot reach Claude through the structured response. `IdpiAnnotator` (see §5.5) extends to scan this tool's output as a defense-in-depth measure.

Verify wait: 250ms post-dismiss-action stability check. If overlay re-mounts within that window (common with React effects), `verified: false` and the entry moves to `skipped[]` with `reason: 'verify_failed_overlay_persists'`.

### 5.3 Allowlist structure (patch-releasable JSON sub-files)

```
src/overlays/
├── index.ts                  — loader + schema validator + unified PATTERN_REGISTRY
├── cookie-consent.json
├── registration-walls.json
├── app-install.json
└── paywalls.json
```

Each pattern entry shape — **two-signal rule** required (single-selector patterns rejected at load time):

```json
{
  "version": 1,
  "category": "cookie-consent",
  "patterns": [
    {
      "id": "onetrust-banner",
      "signals": [
        { "type": "selector", "value": "#onetrust-banner-sdk" },
        { "type": "aria-label-substring", "value": "cookie", "caseInsensitive": true }
      ],
      "dismiss": {
        "action": "click",
        "selector": "#onetrust-accept-btn-handler",
        "fallbackAction": "click",
        "fallbackSelector": "#onetrust-reject-all-handler"
      },
      "verify": { "type": "node-removed", "stabilityMs": 250 },
      "notes": "OneTrust GDPR banner; ~30% of GDPR sites use this"
    }
  ]
}
```

A pattern matches IFF all entries in `signals[]` are satisfied. The schema validator at load-time **rejects any pattern with fewer than 2 signals** → fails noisily during `dist/` build, never ships. Mitigates the false-positive class (a copy-pasted `id="onetrust-banner-sdk"` on an unrelated element would no longer match without the second aria-label signal).

### 5.4 v1 allowlist content (~14-15 patterns total)

**`cookie-consent.json`** (≈6 patterns): OneTrust, Cookiebot, Quantcast, TrustArc, Didomi, generic-aria-fallback.

**`registration-walls.json`** (≈3 patterns): generic newsletter modal, Substack-bottom-banner, Medium-meter-prompt.

**`app-install.json`** (≈2 patterns): Smart App Banner (Apple), Twitter "open in app" banner.

**`paywalls.json`** (≈3 patterns): NYT-soft, FT-modal, Bloomberg-overlay. **Each dismisses ONLY the overlay element — never bypasses server-side gating.** Overlay may re-render on subsequent scroll/click; that degradation is acceptable. Inclusion was an explicit product-owner decision; risks (ToS exposure, Apple notarization sensitivity, brand) were evaluated and accepted with the mitigations in §11.

### 5.5 Safety mechanisms (5 mitigations, product-owner-signed-off)

1. **Kill switch.** New config flag `disableOverlayDismiss: true` (read by MCP server at boot, propagated to OverlayTools handler) makes the tool a no-op returning empty `dismissed[]` and a single `skipped[]` entry `{ reason: 'kill_switch_engaged' }`. User can opt out without uninstalling. Documented in README and CHANGELOG.
2. **Two-signal pattern rule.** Schema validator rejects single-signal patterns at allowlist-load time. Mitigates the copy-pasted-id false positive class.
3. **Per-pattern integration tests (~14-15 tests).** One per allowlist entry. Each asserts: (a) dismisses target on positive fixture, (b) does NOT dismiss on same-DOM-shape negative fixture (e.g., a real "subscribe to magazine" form on a publisher's account-settings page must NOT match the registration-wall pattern). The negative fixtures are the safety net.
4. **Per-dismissal audit log.** Every entry in `dismissed[]` writes a record to `~/.safari-pilot/trace.ndjson` via existing `AuditLog`: `{ ts, tool: 'safari_dismiss_overlays', dismissed_pattern: id, dismissed_category: category, page_url, page_host, action, verified }`. Forensic trail for false-positive incident response.
5. **`IdpiAnnotator` extension.** `server.ts` IdpiAnnotator allowlist (currently extraction-tools-only) extends to include `safari_dismiss_overlays` so any page-injected hostile strings reaching the structured response (defense in depth on top of id-only sanitization) get scanned.

**Sanitization of `dismissed[]` entries:** Drop `aria-label`, `name`, free-text fields. Keep `category`, `id`, `selector` (the matched root, which is the allowlist's known signature, not page-controlled), `site` (URL host), `action`, `verified`.

### 5.6 Sentinel implementation

```javascript
if (cmd.script.startsWith('__SP_DISMISS_OVERLAYS__:')) {
  const { categories, allowlist } = JSON.parse(cmd.script.slice('__SP_DISMISS_OVERLAYS__:'.length));
  // ... per §3 design, allowlist travels inline in the sentinel JSON suffix (no daemon schema bump needed)
}
```

Allowlist JSON loaded by Node-side (`src/overlays/index.ts` at MCP server boot) and passed inline in each invocation's sentinel suffix. Daemon stays untouched.

### 5.7 Edge cases handled

| Case | Behavior |
|---|---|
| Overlay re-mounts within 250ms | `verified: false`; entry in `skipped[]` with `reason: 'verify_failed_overlay_persists'` |
| Closed shadow root | Returned in `skipped[]` with `reason: 'shadow_dom_penetration_failed'` |
| Allowlist pattern matches but root selector is wrong element | Two-signal rule + verify-removed check catch this; entry to `skipped[]` |
| Multiple overlays present | All matched; processed in order. Partial success returns mixed `dismissed[]`/`skipped[]` |
| No overlay present (dominant case) | Returns `{ dismissed: [], skipped: [], overlaysAtStart: 0 }`. Does NOT throw |
| Shadow-root-traversal false positive (e.g., `<div id="onetrust-banner-sdk">` inside a video player's shadow DOM) | Mitigated by host-element heuristic: shadow root host must be `<body>` direct/near-direct child OR have `position: fixed` and z-index above threshold. Documented in `extension/locator.js` |

## 6. Plugin skills (4 new)

### 6.1 Skill 1 — `evidence-grounded-screenshot.SKILL.md` (procedural)

```markdown
---
name: evidence-grounded-screenshot
description: Capture a screenshot of specific answer-bearing content on a web page.
  Use when you need visual evidence for an answer you've extracted. The skill
  dismisses overlays, scrolls the target into view, then captures.
triggers:
  - take screenshot of the answer
  - capture evidence of
  - screenshot showing
  - prove visually
inputs:
  - tabUrl
  - target  # object with one of {selector, text, role+name}
  - screenshotPath
allowed-tools:
  - safari_dismiss_overlays
  - safari_scroll_to_element
  - safari_take_screenshot
---

```json
{
  "steps": [
    { "tool": "safari_dismiss_overlays", "args": { "tabUrl": "{{tabUrl}}" } },
    { "tool": "safari_scroll_to_element", "args": { "tabUrl": "{{tabUrl}}", "selector": "{{target.selector}}", "text": "{{target.text}}", "role": "{{target.role}}", "name": "{{target.name}}", "behavior": "instant" } },
    { "tool": "safari_take_screenshot", "args": { "tabUrl": "{{tabUrl}}", "path": "{{screenshotPath}}" } }
  ]
}
```
```

### 6.2 Skill 2 — `dismiss-overlays-recovery.SKILL.md` (strategy/markdown)

```markdown
---
name: dismiss-overlays-recovery
description: Recovery pattern when web extraction fails or returns suspiciously
  short or generic content. Likely an overlay is blocking. Dismisses known
  overlays, then retry the original extraction.
triggers:
  - extraction returned empty
  - sign in to continue
  - verify you're human
  - subscribe to read
  - continue reading
---

If your last extraction call (safari_get_text, safari_evaluate, etc.) returned:
- Fewer than 50 characters
- Tokens like "sign in", "verify", "subscribe", "register", "continue reading"
- Empty string or whitespace-only

The page likely has an overlay blocking content. Recover:

1. Call `safari_dismiss_overlays(tabUrl)`. Inspect the response.
2. If `dismissed[]` is non-empty: retry your original extraction with the same
   args. The content should now be reachable.
3. If `dismissed[]` is empty but `skipped[]` mentions a candidate the allowlist
   doesn't recognize: the page has a non-allowlisted overlay. Use
   `safari_evaluate` to inspect the DOM directly, or escalate to the user.
4. If both arrays are empty AND content is still gated: not an overlay issue —
   re-read the task. You may be on the wrong page or need to authenticate.

Do NOT call safari_dismiss_overlays repeatedly in a loop. One pass is the
contract; if dismissal didn't help, dismiss won't help on retry.
```

### 6.3 Skill 3 — `visible-evidence-grounding.SKILL.md` (strategy/markdown)

```markdown
---
name: visible-evidence-grounding
description: Rules for grounding answers in current visible page content, not
  prior knowledge. Use when answering factual questions about a specific web
  page where the answer must be verifiable from what's currently rendered.
triggers:
  - what does the page say
  - find on the page
  - according to the website
  - extract the answer
  - what's the price
  - what's the latest
---

When answering questions about a web page's contents:

**Ground in what's visible NOW, not prior knowledge.**
- The answer must come from the current DOM or visible viewport.
- If you "know" the answer from training data but the page doesn't show it,
  the page is the truth — your prior is suspect (sites change).
- Discontinued features, removed pages, updated facts: trust the page.

**Before stating a fact, verify with extraction.**
- Use `safari_get_text` or `safari_evaluate` to read the relevant DOM section.
- Quote or paraphrase the extracted content. Don't synthesize from memory.
- If the extraction was empty or generic, invoke dismiss-overlays-recovery.

**Be honest about gaps.**
- If the page doesn't contain the answer, say so. Don't infer from related
  content. Don't make up a plausible answer.
- If the page contradicts your prior, the page wins.
- If extraction failed and recovery didn't help, return UNKNOWN with reason.

**Never paraphrase a fact you didn't extract.**
- Don't claim "Morningstar provides BBC market data" if the page says the feed
  was discontinued. The page is authoritative.
- Don't answer "the latest iPhone has 4 colors" without a safari_get_text
  confirming all four color names are visible on the page.
```

### 6.4 Skill 4 — `temporal-substitution.SKILL.md` (strategy/markdown)

The current date is **NOT** injected via shell `!`-substitution (fragile against `disableSkillShellExecution` policies). Instead, the existing `SessionStart` hook (`hooks/session-start.sh`) is extended to emit `additionalContext: "Current date: <ISO date>"` at session start. The skill body references the session-context-provided date.

```markdown
---
name: temporal-substitution
description: When a task references a past date or relative time phrase
  ("yesterday", "January 10, 2024" read after that date, "last week"),
  substitute the nearest equivalent today and complete the task.
triggers:
  - schedule for
  - book for
  - yesterday
  - last week
  - on January
  - on February
  - in March
  - "2024"
  - "2023"
---

Today's date is provided in your session context (via the SessionStart hook).
If you don't see it, ask the user or treat it as approximately today.

When a task references a date or relative time:

**1. Check whether the referent is in the past.**
- "Yesterday" or "last week" written in 2024, read today: past.
- "January 10, 2024" read after that date: past.
- "Tomorrow" / "this Friday" / "next month": relative to today; usually still
  actionable as-is.

**2. If past: substitute the nearest equivalent today.**
- Specific past date → nearest equivalent ("January 10 next year" if seasonal
  context, OR the nearest available future date if no seasonal anchor).
- Relative past phrase ("yesterday") → today's equivalent ("today's edition").
- Schedule/booking tasks → schedule for nearest available future date that
  satisfies the task's other constraints (room type, hotel rating, etc.).

**3. State the substitution explicitly in your final answer.**
- "The task asked for January 10, 2024 (in the past). I scheduled for the
  nearest available date — January 12, 2027 — and confirmed the booking."
- "The task asked for 'yesterday's news'; today is the closest available, here
  is what's on the homepage right now."

**4. Do NOT refuse the task.**
- "This date is in the past, so I can't complete this" is wrong.
- The substitution rule exists because benchmark tasks created in 2024 are
  aging. Complete the spirit; document the literal deviation.

**5. Honest completion beats stricter literalism.**
- Better: book Feb 14, 2027 (substituted) and screenshot the confirmation.
- Worse: stop at "Feb 14, 2024 is in the past" with no booking attempted.
```

### 6.5 SessionStart hook update (`hooks/session-start.sh`)

Existing script gets a 2-line addition at the end:

```bash
# Inject today's date for temporal-substitution skill (and any other skills that may want it)
TODAY="$(date '+%Y-%m-%d')"
echo "{\"hookSpecificOutput\":{\"additionalContext\":\"Current date: ${TODAY}\"}}"
```

Provides date to **every** Claude Code session — robust to skill-shell-execution policies, no skill-format dependency.

### 6.6 Plugin manifest changes

`.claude-plugin/plugin.json components.skills` — fix the existing 3-skill registration discrepancy AND register the 4 new skills:

```json
{
  "components": {
    "skills": [
      "skills/safari-pilot/SKILL.md",
      "skills/login.SKILL.md",
      "skills/paginate-and-scrape.SKILL.md",
      "skills/robust-form-fill.SKILL.md",
      "skills/evidence-grounded-screenshot.SKILL.md",
      "skills/dismiss-overlays-recovery.SKILL.md",
      "skills/visible-evidence-grounding.SKILL.md",
      "skills/temporal-substitution.SKILL.md"
    ],
    "commands": [
      "commands/start.md",
      "commands/stop.md",
      "commands/stats.md"
    ]
  }
}
```

The 3 pre-existing skills (`login`, `paginate-and-scrape`, `robust-form-fill`) have been on disk but unregistered. v0.1.31 fixes this — they will load for the first time. Risk: their behavior in real sessions hasn't been observed at scale; if any misbehaves, kill-switch via plugin.json edit + `npm publish` patch.

## 7. Local metrics CLI — `/safari-pilot:stats`

Reads `~/.safari-pilot/trace.ndjson`, aggregates per-tool/error/domain summaries. ~120 lines `src/cli/stats.ts` + ~40 lines `src/cli/format.ts`. Wraps via `commands/stats.md` slash command + optional `package.json` bin entry.

Flags: `--since 7d/30d/all`, `--json`, `--by-tool|--by-error|--by-domain`, `--tail`.

Output (text default) shows per-tool count/error-rate/p50/p95 with ⚠ marker on tools with elevated p95, top errors, top domains. Special row for `safari_dismiss_overlays` shows top dismissed pattern IDs (forensic value when investigating false-positive reports).

Test surface: 4 new unit tests (aggregator, time-window, format, NDJSON parse robustness) + 1 lightweight e2e test (synthetic trace file in temp dir, invoke CLI, assert output).

## 8. Test strategy

### 8.1 Pre-merge gates (deterministic, fast — no bench)

**Unit tests** (`test/unit/`, 4 new files):
- `errors-scroll-codes.test.ts` — `TARGET_NOT_FOUND`/`TARGET_HIDDEN` registered with correct `ERROR_METADATA` (retryable: false; hint strings non-empty)
- `overlay-allowlist-loader.test.ts` — JSON sub-files load, schema validates, **two-signal rule enforced** (rejects single-signal patterns at load), unified registry exposes patterns by category
- `stats-cli-aggregator.test.ts` — by-tool / by-error / by-domain aggregations correct on synthetic NDJSON; p50/p95 calc matches expected; malformed lines skipped
- `stats-cli-time-window.test.ts` — `--since` boundary conditions; future timestamps; empty trace

**E2E tests** (`test/e2e/`, 3 new files; spawn real MCP server, real Safari, real daemon, real extension; zero mocks per `e2e-no-mocks.sh` pre-commit hook):

- `scroll-to-element.test.ts` (6 assertions): selector-mode, text-mode, role-mode, multi-match returns matchCount+allMatches, hidden target → `TARGET_HIDDEN`, p95 latency under 200ms threshold over 20 calls
- `dismiss-overlays.test.ts` (6 assertions): cookie-consent OneTrust dismissed (verified node-removed), shadow-DOM cookie-consent dismissed (penetration proof), registration-wall dismissed, paywall dismissed AND article body reveals to subsequent extraction, no-overlay control returns `{dismissed: [], skipped: [], overlaysAtStart: 0}`, **danger fixture (legitimate confirm dialog) NOT dismissed**
- `evidence-grounded-screenshot-skill.test.ts` (3 assertions): skill template parses, when steps execute against real Safari all 3 tool calls fire and produce expected end state (screenshot PNG contains <50% pixels matching cookie-banner color signature → proves dismiss actually happened end-to-end, not workflow-presence-only)

**Per-pattern integration tests** (`test/e2e/overlays/`, ~14-15 new files — **the safety net**): one per allowlist entry. Each asserts (a) dismisses target on positive fixture, (b) does NOT dismiss on same-DOM-shape negative fixture. Examples: `onetrust-banner.test.ts` paired with `onetrust-banner.negative.fixture.ts` (a non-cookie element with the same id). The negative fixtures are bespoke per pattern.

**New test fixtures** (`test/fixtures/`, 9 localhost servers + ~14 negative-pair fixtures):
- `scroll-targets-page.ts`, `multi-match-page.ts`, `iframe-same-origin.ts`, `iframe-cross-origin.ts`
- `cookie-consent-onetrust.ts`, `cookie-consent-shadow.ts`
- `registration-wall-newsletter.ts`, `paywall-nyt-mock.ts`
- `no-overlay-control.ts`
- `legitimate-confirm-dialog.ts` (DANGER: must NOT be dismissed by any allowlist pattern)
- ~14 paired negative fixtures, one per allowlist entry

**Existing pre-commit hooks (no changes):** `e2e-no-mocks.sh`, `e2e-coverage-check.sh`, `pre-publish-verify.sh`.

**Type check:** `npm run lint` must pass with zero errors.

**Pre-tag-check.sh adds one new check:** `dist/overlays/*.json` parses against the loader's expected schema. A syntactically valid but semantically wrong allowlist would otherwise slip past.

### 8.2 Post-merge ship-gate (bench)

After merge to main, before pushing the v0.1.31 tag: full 175-task WebVoyager dev-sample bench run (concurrency 1, deterministic seed `v0.1.x-dev-sample` → same task IDs as v0.1.30 partial baseline). Output dir: `bench-runs/webvoyager-v0.1.31-baseline-<timestamp>/`.

**Per-failure-subset monotonic improvement (replaces aggregate +6 threshold — too close to ±5 noise envelope on 67 binary outcomes):**

| Subset | v0.1.30 baseline (67-task partial) | v0.1.31 acceptance |
|---|---|---|
| Cookie-consent / overlay-occluded failures | BBC-12 (registration), arguably others on full 175 | Must decrease; ≥2 task flips on full 175 |
| Hallucination failures (mode C) | BBC-28, BBC-39, Booking-18 | Must decrease; ≥1 task flip |
| Temporal failures (mode E) | Apple-9; more on full 175 | Must decrease; ≥1 task flip |

**Hard regression gates (block tag if violated):**
- Allrecipes 12/12 must hold
- Any site with ≥80% baseline must not drop more than 1 task
- Overall `capture_failure_rate` ≤ 10.4% (v0.1.30 partial)
- No new error categories appearing >5x in audit log

If gates fail: patch on sprint branch, re-run bench, re-evaluate. Do NOT tag-push v0.1.31 until gates pass.

### 8.3 Bench harness changes — explicitly NONE

`bench/webvoyager/adapter.ts buildPrompt` is **not modified**. The benchmark must observe the natural lift from product changes. The only bench-side change is *output*: post-bench score CLI gains a per-task diff command for v0.1.31-vs-v0.1.30 comparison. Read-only analysis tooling.

## 9. Release shape

### 9.1 Branch & sequencing

Branch `feat/v0131-evidence-grounding` from main (currently `ae37879`). Created at implementation start (writing-plans/executing-plans transition).

Commit sequence — **grouped by atomic-revert unit** (Node-side and extension-side changes that depend on each other are in the same commit; reverting one without the other would leave a tool that throws):

1. `feat(types): add metadata-only TARGET_NOT_FOUND, TARGET_HIDDEN` (`src/types.ts`, `src/errors.ts`)
2. `feat(overlays): allowlist loader + 4 JSON sub-files + schema validator` (`src/overlays/`)
3. `feat(scroll-to-element): tool + sentinel + locator helper` (atomic: `src/tools/interaction.ts` + `extension/background.js` + `extension/locator.js`)
4. `feat(dismiss-overlays): tool + sentinel + IdpiAnnotator extension + kill switch` (atomic: `src/tools/overlays.ts` + `src/server.ts` registration + `extension/background.js`)
5. `test(unit): error codes + allowlist loader + stats CLI` (4 unit test files)
6. `test(fixtures): 9 base fixtures + 14 per-pattern negative-pair fixtures`
7. `test(e2e): scroll-to-element + dismiss-overlays + skill workflow + 14 per-pattern`
8. `feat(skills): 4 new SKILL.md + plugin.json registration fix + new entries`
9. `feat(hook): SessionStart date injection`
10. `feat(stats-cli): src/cli/stats.ts + src/cli/format.ts + commands/stats.md`
11. `chore: pre-tag-check additions for allowlist parse-validate`
12. `docs: CHANGELOG v0.1.31 entry`
13. `chore(release): v0.1.31` — version lockstep bump (`package.json` + `extension/manifest.json` `CFBundleShortVersionString` + `CFBundleVersion`)

### 9.2 Build & sign pipeline (no procedural changes)

Existing pipeline applies unchanged:

```bash
bash scripts/build-extension.sh    # full Xcode → archive → sign → notarize → stapler
npm run build                       # TS → dist/
bash scripts/pre-tag-check.sh       # all canonical checks
```

Per `feedback-extension-build-safeguards`: no manual codesign, version sync verified, entitlements verified, AppleDouble-free zip, ditto with full strip set. All locked into existing `build-extension.sh`. No changes.

### 9.3 Rollback policy

| Bug class | Patch type | Mechanism |
|---|---|---|
| Bad allowlist entry (false positive) | **Content-only patch** (npm patch, NO extension rebuild) | Edit `src/overlays/*.json`, remove or fix entry, `npm version patch` + `npm publish`. New `dist/` ships. Next session of any user picks up new allowlist. Extension `.app` untouched. |
| Bug in allowlist loader (`src/overlays/index.ts`) | **Content-or-logic patch** (npm patch, no extension) | `npm version patch` + publish. Extension untouched. |
| Bug in tool handler (`src/tools/overlays.ts`, `src/tools/interaction.ts`) | **Logic patch** (npm patch, no extension) | Same as above. |
| Bug in sentinel handler or `extension/locator.js` | **Full release** (extension rebuild + notarize + new tag) | `bash scripts/build-extension.sh` + `bash scripts/update-daemon.sh` (if needed) + version bump + tag + GitHub Release |
| Bad behavior in a strategy skill | **Content-only patch** (npm patch, no extension) | Edit `skills/*.SKILL.md`, publish. Extension untouched. |
| Need to disable a tool entirely | **Logic patch** | Add `disabled: true` field check in tool registration; or remove from `server.ts`. |

The "patch-releasable" claim has scope: **JSON allowlist content + Node-side TypeScript code** is patch-releasable. Anything in `extension/` requires full release.

### 9.4 CHANGELOG.md v0.1.31 entry (draft)

```markdown
## v0.1.31 — 2026-MM-DD

### Added
- `safari_scroll_to_element` MCP tool. Scrolls a specific element into the
  visible viewport. Multi-mode input ({selector, text, role+name}). Returns
  matched-node descriptor + viewport state + multi-match candidates.
  Extension-engine only.
- `safari_dismiss_overlays` MCP tool. Detects/dismisses ~14 known overlay
  patterns (cookie-consent, registration-wall, app-install, paywall) using a
  curated allowlist. Two-signal-per-pattern rule enforced. Returns
  {dismissed[], skipped[]} with id-only sanitized entries (page-injected
  hostile strings cannot leak via response). IdpiAnnotator scans this output.
- Four new plugin skills: evidence-grounded-screenshot (procedural workflow:
  dismiss → scroll → screenshot), dismiss-overlays-recovery (strategy: recover
  from blocked extraction), visible-evidence-grounding (strategy: ground
  answers in visible page state), temporal-substitution (strategy: substitute
  past-relative dates).
- /safari-pilot:stats slash command. Local-only metrics summary over
  ~/.safari-pilot/trace.ndjson.
- SessionStart hook injects current date as additionalContext for
  temporal-substitution skill (and others).

### Fixed
- plugin.json now correctly registers login, paginate-and-scrape,
  robust-form-fill skills (previously on disk but unregistered — discovered
  during v0.1.31 design review).

### Internal
- New error codes (data-only): TARGET_NOT_FOUND, TARGET_HIDDEN
- New extension sentinels (prefix-and-JSON convention): __SP_SCROLL_TO_ELEMENT__:
  and __SP_DISMISS_OVERLAYS__:
- Allowlist content lives in src/overlays/*.json — patch-releasable via
  npm publish (no extension rebuild needed for content-only changes)
- Bench harness buildPrompt UNCHANGED — discipline boundary

### Paywall dismissal — residual risk acknowledgment
The dismiss-overlays allowlist includes 3 conservatively-scoped paywall
patterns (NYT-soft, FT-modal, Bloomberg-overlay). Each dismisses ONLY the
overlay element; server-side gating is not bypassed. Overlays may re-render on
subsequent scroll/click. Inclusion was an explicit product-owner decision.
Mitigations: kill switch (disableOverlayDismiss: true), two-signal pattern
rule, per-pattern negative-fixture tests, per-dismissal audit log,
patch-releasable allowlist. Any pattern can be removed in a v0.1.31.x patch
without a feature release.

### Bench-gate baseline
v0.1.31 ship-gate: WebVoyager dev-sample 175-task run.
Per-failure-subset monotonic improvement required:
- Cookie-consent/overlay failures: ≥2 task flips
- Hallucination failures: ≥1 task flip
- Temporal failures: ≥1 task flip
Hard regression gates: Allrecipes 12/12 holds, any site with ≥80% baseline
must not drop more than 1 task, capture_failure_rate ≤10.4%.

### Rollback
- Tag: revert v0.1.31 → users on v0.1.30 unaffected
- Allowlist content patch: npm publish patch (no extension rebuild)
- Tool kill: disableOverlayDismiss: true config flag (per-user opt-out)
```

### 9.5 Notion roadmap entry

Created at sprint start with status transitions: `In Progress` → `Verifying` (on merge) → `Shipped` (after bench gate passes + tag pushed).

```
Item: v0.1.31 — Evidence Grounding Sprint
Status: In Progress
Priority: High
Epic: WebVoyager Capability Lift
Source: Failure analysis of v0.1.30 partial baseline (67 tasks)
Sprint#: <current>
Branch: feat/v0131-evidence-grounding
Technical Notes: 2 new MCP tools, 4 skills, 1 slash command, allowlist with
  two-signal rule + kill switch + per-pattern tests. Extension rebuild +
  notarize required. Lockstep version bump per existing protocol.
Parallel Safety: Single-developer; bench gate post-merge.
```

## 10. Out of scope (explicit)

- Per-site recipes (Apple, Amazon, BBC) — v0.1.32 scope per existing `CHECKPOINT.md` handoff
- Cloud telemetry (opt-in anonymous metric collection) — separate sprint, not coupled to feature ship
- Full benchmark re-run on v0.1.30 (the partial 67-task baseline is the comparison anchor)
- Bench harness `buildPrompt` modifications
- Daemon Swift schema changes
- New security pipeline layers
- Modifications to existing tool behaviors
- New runtime dependencies in `package.json`
- DESIGN.md / frontend (this is backend MCP work)

## 11. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Allowlist false positive dismisses legitimate consent UI on third-party site | **Critical** | 5 mitigations: kill switch, two-signal rule, per-pattern negative-fixture tests (~14), per-dismissal audit log, IdpiAnnotator scan extension. Product-owner-signed-off. Patch-releasable for rapid response. |
| R2 | Paywall dismissal triggers ToS dispute / Apple notarization review / brand incident | **High** | Conservative single-overlay scope (no server-side bypass), patch-releasable removal path, explicit CHANGELOG acknowledgment. Inclusion is an explicit product-owner decision. |
| R3 | `requiresShadowDom` extension on `safari_dismiss_overlays` doesn't actually penetrate cookie-consent shadow roots in the wild | Medium | Per-pattern integration tests cover shadow-DOM penetration explicitly (`cookie-consent-shadow.ts` fixture). Bench gate validates real-world success. |
| R4 | `temporal-substitution` skill produces wrong substitutions on tasks where the date isn't actually past-relative | Medium | Skill body is conservative ("check whether the referent is in the past"); SessionStart-injected date is precise. Bench gate measures temporal-failure subset specifically. |
| R5 | Bench harness changes the score by virtue of new skills triggering, not the underlying tools (skill-as-prompt-engineering) | Medium | Per-failure-subset measurement separates capability lift (I1, I2 tool-driven) from strategy lift (I3, I8 skill-driven). Each is independently observable. |
| R6 | Schedule slips to 12-14 days due to hidden complexity in shadow-DOM penetration / per-pattern test authoring | Medium | 9-10 days hard floor in this spec already absorbs reviewer's correction; budget 12 days realistic on calendar. |
| R7 | `disableSkillShellExecution` policy prevents `temporal-substitution` from working | **Mitigated** | Spec replaced shell `!`date`` with SessionStart-hook-injected `additionalContext`. Robust to policy. |
| R8 | New code paths not covered by existing security layers | Mitigated | Both new tools pass through all 9 existing layers; IdpiAnnotator extended; TabOwnership applies; AuditLog captures; engine selection fail-closed. |

## 12. Schedule

**Hard floor: 9-10 days.** Realistic calendar: 11-12 days with notarize-retry buffer.

| Phase | Days |
|---|---|
| Tool 1 (scroll) + locator.js helper + tests | 1.5 |
| Tool 2 (dismiss) + 4 allowlist files + shadow-DOM penetration + 14 per-pattern tests + danger fixtures | 3.5 |
| 4 skills + plugin.json fix + SessionStart hook update + skill tests | 1.0 |
| /stats CLI + 4 unit tests + 1 e2e | 1.0 |
| Pre-tag-check additions, full notarize cycle (3-retry buffer), bench post-merge | 1.5 |
| Bench analysis + post-mortem if numbers don't move | 1.0 |
| **Total floor** | **9.5** |

## 13. Acceptance & sign-off

- Product owner signed off on safari_dismiss_overlays inclusion (with all 5 mitigations) on 2026-05-08
- Engineering review passed (5 factual errors fixed in spec, 3 critical issues mitigated, 5 coverage gaps closed)
- Architecture surgical/additive; no breaking changes
- Test surface includes the safety regression network (per-pattern positive + negative fixtures)
- Bench gate is per-failure-subset monotonic, not aggregate-noise-floor

Spec is implementation-ready. Next step: `upp:writing-plans` to produce a task-by-task implementation plan against this design.
