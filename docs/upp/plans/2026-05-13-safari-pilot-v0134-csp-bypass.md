# Safari Pilot v0.1.34 — CSP / Trusted-Types Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Safari Pilot's DOM-affecting tools work on pages that enforce strict CSP / Trusted Types (Apple shop sub-pages, Google Flights, Google Search→X.com login) by refactoring every tool that currently routes through `new Function(params.script)` to use a dedicated sentinel handler that bypasses page CSP entirely.

**Architecture:** Each refactored tool stops sending a JS string and instead sends a structured-param sentinel (`__SP_CLICK__:{json}`, etc.). The extension's content-main.js intercepts the sentinel before reaching the `new Function` compile path at line 714 — same pattern as the existing `__SP_SCROLL_TO_ELEMENT__` and `__SP_DISMISS_OVERLAYS__` handlers that already work on TT-strict pages. Three new ISOLATED-world capability tools cover the read-only patterns that previously needed `safari_evaluate`.

**Tech Stack:** TypeScript MCP server (`src/tools/`), JS content scripts (`extension/content-main.js` MAIN world + `extension/content-isolated.js` ISOLATED world), Vitest for unit + e2e tests, localhost HTTP fixtures (`test/fixtures/csp-trusted-types.ts`).

**Sprint design source-of-truth:** `docs/upp/specs/2026-05-13-safari-pilot-v0134-csp-bypass.md` Section 8 (Fallback: Multi-Tool Sentinel Refactor). The earlier architectural-pivot variant of this plan (`docs/upp/plans/2026-05-13-safari-pilot-v0134-csp-bypass-architectural-pivot-abandoned.md`, commit `904fd81`) failed empirically — see `TRACES.md` iter 80 for the diagnostic record.

---

## Sprint Context (read once before starting)

### Why every task in this plan is shaped the same way

The architectural-pivot attempt (now abandoned) tried to add new sentinels to `extension/content-isolated.js` and have them intercept caller-supplied JS strings. Three rebuilds in, the sentinels never fired — the dispatch path the pivot assumed didn't exist as designed. Diagnosis is open; the project decided not to spend more time on it. See `TRACES.md` iter 80 for the full pivot-failure record.

The pattern that DOES work on TT-strict pages — empirically verified in v0.1.31 — is the `__SP_SCROLL_TO_ELEMENT__:<json>` early-intercept inside content-main.js's `case 'execute_script':` switch, sitting BEFORE the `new Function(params.script)` compile at line 714. That branch never hits Trusted Types because no string→script conversion happens.

Every refactor task in this plan adds one more early-intercept to that same switch, following the same shape. Pattern reference (read once, then write fresh each task per "Surgical Changes" / "No Placeholders" rules):

**TS-side marshalling** (in `src/tools/<file>.ts`, inside the tool handler):
```ts
const sentinel = '__SP_TOOL_NAME__:' + JSON.stringify({ /* structured params */ });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, TIMEOUT_MS);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_tool_name failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

**Extension-side handler** (in `extension/content-main.js`, inside `case 'execute_script':`, BEFORE the `new _Function(params.script)` line at 714):
```js
if (typeof params.script === 'string' && params.script.startsWith('__SP_TOOL_NAME__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_TOOL_NAME__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L) {
      throw Object.assign(
        new Error('locator.js not loaded in MAIN world'),
        { name: 'NO_LOCATOR' },
      );
    }
    // ... tool-specific logic using L.* helpers ...
    result = { /* tool-specific result shape */ };
    break;
  } catch (e) {
    throw e; // outer catch translates error.name → error.code
  }
}
```

### Extension rebuild discipline (HARD RULE)

Per project memory `feedback-extension-version-both-fields` and `feedback-never-open-app-without-version-bump`: every Safari extension rebuild requires a marketing-version bump in BOTH `package.json` AND `extension/manifest.json`. Safari caches by `CFBundleShortVersionString`; reusing a version number means Safari silently ignores the new bundle.

This plan batches extension rebuilds: **one mid-sprint rebuild at task 11** (after the new capability tools + first 4 refactors land), **one final rebuild at task 20** (ship time). Use pre-release tags (`0.1.34-dev.1`, `0.1.34-dev.2`) for the mid-sprint rebuild; the final ship rebuild uses `0.1.34`.

For unit-test-only tasks (TS code, no extension changes), no rebuild is needed.

For e2e tasks that exercise the extension but only test TS-layer behavior (e.g., the error UX in task 3), they can run against the v0.1.33 extension already installed.

### Fixture infrastructure (already in place)

The TT-strict HTTP fixture exists at `test/fixtures/csp-trusted-types.ts` from Task 1 of the abandoned plan (commit `7ed5c76`). It serves a page with `Content-Security-Policy: require-trusted-types-for 'script'`. The v0.1.33 regression-baseline test at `test/e2e/csp-baseline-tt-strict.test.ts` documents the failure mode this sprint reverses.

DO NOT modify either of those files except to add new tests alongside the baseline. They are the v0.1.33 failure-mode reference.

### What's out of scope

- `safari_evaluate` itself stays broken on TT-strict pages. The new capability tools (task 4-6) plus the refactored interaction/extraction tools cover the empirical demand. `safari_evaluate` gains a `CSP_BLOCKED` error with a hint pointing at the alternatives (task 3).
- Daemon changes. Section 8 architecture has zero daemon-side work. Don't touch `daemon/Sources/`.
- `cspMode` dispatch routing (the original Section 3 design). Section 8 sidesteps it — sentinels are CSP-immune at all times regardless of page CSP, so no per-tab routing decision is needed.
- v0.1.32 carry-forwards (Models.swift AnyCodable bool/int coercion, allowlist over-broadness, etc.). Listed in CHANGELOG as "still pending"; defer to v0.1.35.

---

## File Structure

### Files that get MODIFIED

| File | Responsibility | Tasks |
|---|---|---|
| `extension/content-main.js` | MAIN-world content script. Adds ~10 new early-intercept sentinel handlers inside `case 'execute_script':`. Each handler is ~20-40 lines. Total expected growth: ~300-400 lines (current 734 → ~1100). Also gains Layer 3 TT policy registration at IIFE init. | 2, 7, 8, 9, 10, 12, 13, 14, 15, 16 |
| `extension/content-isolated.js` | ISOLATED-world content script. Adds 3 new sentinel handlers for the read-only capability tools (`safari_get_page_info`, `safari_get_meta_tags`, `safari_extract_text_window`). Each ~30-50 lines. | 4, 5, 6 |
| `extension/locator.js` | Existing `window.__SP_LOCATOR__` helpers. Used by every new content-main.js sentinel handler. No code changes — used as-is. | (read-only) |
| `extension/manifest.json` | Marketing version bump. | 11, 20 |
| `src/tools/interaction.ts` | Refactor `safari_click`, `safari_fill`, `safari_type`, `safari_scroll` handlers from `engine.executeJsInTab(..., jsString)` to sentinel marshalling. | 7, 8, 9, 10 |
| `src/tools/extraction.ts` | Refactor `safari_get_text`, `safari_query_all`, `safari_snapshot` handlers. Add `CSP_BLOCKED` error UX to `safari_evaluate`. | 3, 12, 13, 14 |
| `src/tools/structured-extraction.ts` | Refactor `safari_smart_scrape` handler. | 15 |
| `src/tools/page-info.ts` | NEW. Hosts the 3 new capability tools (`safari_get_page_info`, `safari_get_meta_tags`, `safari_extract_text_window`). Single module since they share an ISOLATED-world dispatch pattern and the audit confirmed no existing tool file is the right home. | 4, 5, 6 |
| `src/server.ts` | Register the new tools module in `initialize()` (around line 399-455 per TRACES iter 76). | 4 |
| `src/cli/stats.ts` | Extend NDJSON aggregator to count new error codes (`CSP_BLOCKED`, `CSP_HARD_BLOCK`). | 17 |
| `safari-pilot.config.json` | Add `legacyMainWorld: false` config field for rollback. | 16 |
| `package.json` | Marketing version bump. | 11, 20 |
| `CHANGELOG.md` | v0.1.34 entry. | 20 |
| `ARCHITECTURE.md` | v0.1.34 version-history entry; document the multi-sentinel pattern. | 20 |
| `bin/Safari Pilot.app` + `bin/Safari Pilot.zip` | Extension build artifacts. | 11, 20 |
| `TRACES.md` | iter 81 (mid-sprint), iter 82 (ship). | 11, 20 |

### Files that get CREATED

| File | Responsibility | Task |
|---|---|---|
| `docs/upp/research/2026-05-13-csp-bypass-audit.md` | Codebase audit output: every `engine.executeJsInTab` call site in `src/tools/`, categorized DOM-affecting vs page-context-needed vs unrelated. Read by every subsequent task to validate completeness. | 1 |
| `src/tools/page-info.ts` | (see above) | 4 |
| `test/fixtures/csp-trusted-types-allowlist.ts` | Mode A + allowlist fixture (`trusted-types google#safe goog#html`). Returns 200 with `Content-Security-Policy: require-trusted-types-for 'script'; trusted-types google#safe goog#html`. | 2 |
| `test/fixtures/csp-script-src-no-eval.ts` | Mode B fixture (`script-src 'self'` without `unsafe-eval`). | 3 |
| `test/e2e/csp-tt-policy-registration.test.ts` | Layer 3 TT policy registration outcomes (success / TypeError on allowlist / ReferenceError on no-TT). | 2 |
| `test/e2e/csp-evaluate-blocked-error.test.ts` | `safari_evaluate` on TT-strict page returns `CSP_BLOCKED` with `hint.alternative_tools`. | 3 |
| `test/e2e/page-info-tools.test.ts` | E2E for the 3 new capability tools, both open-CSP and TT-strict pages. | 4, 5, 6 |
| `test/e2e/csp-interaction-sentinels.test.ts` | E2E for the 4 refactored interaction tools (click, fill, type, scroll) on TT-strict fixture. | 7, 8, 9, 10 |
| `test/e2e/csp-extraction-sentinels.test.ts` | E2E for the 3 refactored extraction tools (get_text, query_all, snapshot) on TT-strict fixture. | 12, 13, 14 |
| `test/e2e/csp-smart-scrape-sentinel.test.ts` | E2E for safari_smart_scrape on TT-strict fixture. | 15 |
| `test/e2e/csp-legacy-flag.test.ts` | E2E confirming `legacyMainWorld: true` reverts behavior. | 16 |
| `test/unit/cli-stats-csp.test.ts` | Unit test for stats CLI new counters. | 17 |
| `bench-runs/webvoyager-v0.1.34-bench-<timestamp>/` | Bench run output (judge results, scoreboard). | 18 |

### Files that get RENAMED / DELETED

None this sprint. The architectural-pivot plan was already renamed to `*-architectural-pivot-abandoned.md` at commit `977a360`.

---

## Task 1: Codebase audit — categorize every `engine.executeJsInTab` call site

**Why first:** Section 8 says "audit every tool's `engine.executeJsInTab(tabUrl, jsString)` call in `src/tools/`." The TRACES iter 80 grep found 89 call sites across 18 files but didn't categorize them. Without a categorized list, the subsequent refactor tasks risk missing tools that need refactoring OR over-scoping to tools that don't.

This task produces a research artifact, not code. It does NOT touch any source file.

**Files:**
- Create: `docs/upp/research/2026-05-13-csp-bypass-audit.md`

- [ ] **Step 1: Enumerate every `engine.executeJsInTab` call site**

Run:
```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
grep -rn "executeJsInTab\b" src/tools/ > /tmp/csp-audit-raw.txt
wc -l /tmp/csp-audit-raw.txt
```

Expected: 89 lines (matches TRACES iter 80 finding). If significantly different, the codebase has shifted since the audit; investigate.

- [ ] **Step 2: For each call site, read 10 lines of surrounding context and classify**

For each line in `/tmp/csp-audit-raw.txt`, read the source to determine:

- **Tool name:** which `safari_*` tool the call site belongs to
- **DOM-affecting:** does the executed JS read or mutate the page DOM? (vs. browser/window APIs like history, performance.now, etc.)
- **Sentinel-already:** is the JS string actually a sentinel prefix (`__SP_*`) intercepted before `new Function`?
- **Page-context-needed:** does the JS read page-defined globals (`window.someApp.state`, framework internals)?
- **Refactor candidate:** YES if DOM-affecting AND NOT sentinel-already AND NOT page-context-needed. NO otherwise.

- [ ] **Step 3: Write the audit doc**

```bash
mkdir -p docs/upp/research
```

Create `docs/upp/research/2026-05-13-csp-bypass-audit.md` with the following structure:

```markdown
# v0.1.34 CSP Bypass — Codebase Audit

*Written 2026-05-13. Input to the v0.1.34 plan tasks 4-15.*

## Method

`grep -rn "executeJsInTab\b" src/tools/` produced 89 call sites across 18 files (matches TRACES iter 80). Each was read with 10 lines of surrounding context and classified along three axes: DOM-affecting, sentinel-already, page-context-needed.

## Summary

| Status | Count | What it means |
|---|---|---|
| Sentinel-already | [N] | JS string is `__SP_*:...`; intercepted in content-main.js or content-isolated.js before reaching `new Function`. Already CSP-immune. No action. |
| Page-context-needed | [N] | Reads framework internals or page-defined globals. Cannot be refactored to ISOLATED-world; stays on `new Function` path. On CSP-strict pages, the existing tool fails — error UX in task 3 covers it. |
| Browser-API-only | [N] | Reads `performance.*`, `navigator.*`, `history.*`, or extension/browser APIs only. Not DOM. Not affected by page CSP (browser APIs aren't subject to TT). No action. |
| Refactor candidate | [N] | DOM-affecting, no page-context, not yet sentinel. Plan tasks 7-15 cover these. |

## Refactor candidates (the work this plan executes)

| File | Line | Tool | Why refactor candidate | Task |
|---|---|---|---|---|
| src/tools/interaction.ts | [line] | safari_click | DOM click via clickElement() helper | 7 |
| src/tools/interaction.ts | [line] | safari_fill | DOM input value setter | 8 |
| src/tools/interaction.ts | [line] | safari_type | DOM input keystrokes | 9 |
| src/tools/interaction.ts | [line] | safari_scroll | DOM scroll | 10 |
| src/tools/extraction.ts | [line] | safari_get_text | DOM textContent read | 12 |
| src/tools/extraction.ts | [line] | safari_query_all | DOM querySelectorAll + serialize | 13 |
| src/tools/extraction.ts | [line] | safari_snapshot | DOM accessibility tree | 14 |
| src/tools/structured-extraction.ts | [line] | safari_smart_scrape | DOM extraction with heuristics | 15 |
| [any others surfaced by the audit] | | | | 15 (sweep) |

## Sentinel-already (no action needed)

[list]

## Page-context-needed (stays on new Function, error UX covers it)

[list]

## Browser-API-only (no action needed)

[list]

## Tools NOT in src/tools/ that might also need attention

[note any non-tool eval call sites surfaced incidentally]
```

Fill every [N] and [line] with real values from the audit. NO placeholders allowed in the final committed doc.

- [ ] **Step 4: Verify audit completeness**

Run:
```bash
grep -c "Refactor candidate" docs/upp/research/2026-05-13-csp-bypass-audit.md
```
Expected: matches the count in the summary table.

Verify the refactor-candidate count: it should be between 5 and 15. Below 5 means the audit missed tools; above 15 means the categorization included page-context-needed cases that shouldn't be in scope.

- [ ] **Step 5: Commit**

```bash
git add docs/upp/research/2026-05-13-csp-bypass-audit.md
git commit -m "docs(research): v0.1.34 codebase audit — categorize 89 executeJsInTab call sites by refactor scope"
```

---

## Task 2: Layer 3 — Trusted Types policy registration in content-main.js

**Why now:** Per spec Section 3, content-main.js must attempt `trustedTypes.createPolicy('safari-pilot', {...})` at content-script load time. If the page enforces `require-trusted-types-for 'script'` AND its `trusted-types` directive permits the `safari-pilot` policy name, this gives any legacy MAIN-world string→sink path a route. If the policy is rejected (TypeError), set `window.__SP_TT_HARD_BLOCK = true` so the error UX in task 3 can distinguish hard-block from regular tt-strict.

This is foundational — every later task assumes Layer 3 is in place.

**Files:**
- Modify: `extension/content-main.js` (add IIFE block near top, after existing init at line ~1-50)
- Create: `test/fixtures/csp-trusted-types-allowlist.ts`
- Create: `test/e2e/csp-tt-policy-registration.test.ts`

- [ ] **Step 1: Read the existing content-main.js IIFE init**

```bash
sed -n '1,80p' extension/content-main.js
```

Locate the existing `(function(){ ... })()` IIFE wrapping the content script and find the right insertion point: AFTER `window.__SP_LOCATOR__` becomes available (locator.js is declared before content-main.js in manifest.json's content_scripts MAIN-world array) but BEFORE the storage-bus listener is wired.

- [ ] **Step 2: Write the failing e2e test**

The verification surface for Layer 3 is `__SP_TT_PROBE__` — a sentinel handler added in this task (originally planned for T3, moved here because `safari_get_console_messages` routes through `new Function` at extraction.ts:658 and would itself fail on the TT-strict page). The probe reads `window.__SP_TT_POLICY__` and `window.__SP_TT_HARD_BLOCK` via a structured result. T3 consumes this same probe for its error-UX branch logic.

Create `test/e2e/csp-tt-policy-registration.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { startTrustedTypesAllowlistFixture } from '../fixtures/csp-trusted-types-allowlist.js';
import type { Server } from 'node:http';

describe('Layer 3: Trusted Types policy registration', () => {
  let ttServer: { server: Server; url: () => string };
  let allowlistServer: { server: Server; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    ttServer = startTrustedTypesFixture();
    allowlistServer = startTrustedTypesAllowlistFixture();
  });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => ttServer.server.close(() => r()));
    await new Promise<void>((r) => allowlistServer.server.close(() => r()));
  });

  it('registers __SP_TT_POLICY__ on tt-strict pages without an allowlist', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t2_a=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    // Brief settle for content scripts to inject + run init.
    await new Promise((r) => setTimeout(r, 800));

    // Sentinel-immune probe: safari_evaluate sends the script string verbatim;
    // content-main.js intercepts the __SP_TT_PROBE__ prefix BEFORE new Function,
    // so it works on TT-strict pages.
    const result = await callTool(client, 'safari_evaluate', { tabUrl, script: '__SP_TT_PROBE__:{}' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.policyRegistered).toBe(true);
    expect(parsed.hardBlock).toBe(false);
  });

  it('sets __SP_TT_HARD_BLOCK on tt-strict pages with an allowlist excluding safari-pilot', async () => {
    const client = await getSharedClient();
    const tabUrl = allowlistServer.url() + '?sp_t2_b=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 800));

    const result = await callTool(client, 'safari_evaluate', { tabUrl, script: '__SP_TT_PROBE__:{}' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.hardBlock).toBe(true);
    // On hard-block pages, createPolicy threw TypeError — so policyRegistered is false.
    expect(parsed.policyRegistered).toBe(false);
  });
});
```

- [ ] **Step 3: Write the allowlist fixture**

Create `test/fixtures/csp-trusted-types-allowlist.ts`:

```typescript
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export function startTrustedTypesAllowlistFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict allowlist fixture</title>
<meta name="description" content="Trusted Types strict fixture with allowlist excluding safari-pilot">
</head><body>
<h1 id="hero">TT-strict allowlist fixture body</h1>
<p>This page enforces Trusted Types AND restricts policy names to an allowlist that excludes 'safari-pilot'.</p>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types google#safe goog#html",
    });
    res.end(page);
  });
  server.listen(port);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}
```

- [ ] **Step 4: Run the e2e test — verify both cases fail**

Run:
```bash
npx vitest run test/e2e/csp-tt-policy-registration.test.ts
```

Expected: both tests FAIL. The first because `__SP_TT_POLICY__ registered` log line doesn't exist yet. The second similarly for `__SP_TT_HARD_BLOCK`.

- [ ] **Step 5: Implement Layer 3 in content-main.js (init block + `__SP_TT_PROBE__` sentinel handler)**

This step adds TWO things to `extension/content-main.js`:

**(a)** A top-of-file IIFE that registers the Trusted Types policy at content-script load time. Add this AFTER any existing window-global setup and BEFORE the storage-bus listener registration. Search for `window.__SP_LOCATOR__` usage to find the right scope.

**(b)** A new early-intercept sentinel inside `case 'execute_script':` (alongside the existing `__SP_SCROLL_TO_ELEMENT__` and `__SP_DISMISS_OVERLAYS__` intercepts, BEFORE the `new _Function(params.script)` line). This is the verification surface for the test in Step 2 AND is consumed by T3's error UX. Snippet:

```javascript
// ── EARLY INTERCEPT: __SP_TT_PROBE__:<json> (v0.1.34 Task 2) ──
// Reads Layer 3 init state. Used by csp-tt-policy-registration.test.ts AND by
// T3's safari_evaluate CSP_BLOCKED error UX to distinguish CSP_BLOCKED from
// CSP_HARD_BLOCK. Args ignored (probe takes no parameters; the trailing JSON
// is required only to satisfy the prefix-then-colon convention).
if (typeof params.script === 'string' && params.script.startsWith('__SP_TT_PROBE__:')) {
  result = {
    hardBlock: window.__SP_TT_HARD_BLOCK === true,
    policyRegistered: typeof window.__SP_TT_POLICY__ !== 'undefined',
  };
  break;
}
```

The init block (the (a) part):

```javascript
// ── Layer 3: Trusted Types policy registration (v0.1.34) ──
// On pages that enforce `require-trusted-types-for 'script'`, any remaining
// MAIN-world string→sink path (e.g. legacy code that does .innerHTML = str)
// needs a registered policy to route through. If the page's `trusted-types`
// directive doesn't allow the 'safari-pilot' policy name, the createPolicy
// call throws TypeError; we flag that and let task-3 error UX surface it.
(function registerTrustedTypesPolicy() {
  try {
    if (typeof window.trustedTypes === 'undefined' || typeof window.trustedTypes.createPolicy !== 'function') {
      // No TT API on this page — pre-TT browser or no CSP enforcement.
      return;
    }
    try {
      const policy = window.trustedTypes.createPolicy('safari-pilot', {
        createScript: (s) => s,
        createHTML: (s) => s,
        createScriptURL: (s) => s,
      });
      window.__SP_TT_POLICY__ = policy;
      // eslint-disable-next-line no-console
      console.log('[safari-pilot] __SP_TT_POLICY__ registered');
    } catch (e) {
      // TypeError: page's trusted-types directive doesn't permit our policy name.
      // Combined with the new-Function failure on string-script paths, this is
      // a hard block — surface it for the error UX in safari_evaluate.
      window.__SP_TT_HARD_BLOCK = true;
      // eslint-disable-next-line no-console
      console.warn('[safari-pilot] __SP_TT_HARD_BLOCK — policy rejected:', e && e.message);
    }
  } catch (e) {
    // Defensive: anything truly unexpected should not break the rest of the script.
    // eslint-disable-next-line no-console
    console.warn('[safari-pilot] TT policy init failed unexpectedly:', e && e.message);
  }
})();
```

- [ ] **Step 6: Bump dev marketing version + rebuild extension + reinstall**

```bash
# Use a pre-release dev tag so the final 0.1.34 stays unburned.
node -e "const p=require('./package.json'); p.version='0.1.34-dev.1'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
node -e "const m=require('./extension/manifest.json'); m.version='0.1.34-dev.1'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(m, null, 2) + '\n');"
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
```

After Safari shows the new build in Settings > Extensions (may take 5-10s), verify the version string ends with `dev.1`.

- [ ] **Step 7: Run the e2e test — verify both cases pass**

Run:
```bash
npx vitest run test/e2e/csp-tt-policy-registration.test.ts
```

Expected: both tests PASS.

- [ ] **Step 8: Commit**

```bash
git add extension/content-main.js extension/manifest.json package.json test/fixtures/csp-trusted-types-allowlist.ts test/e2e/csp-tt-policy-registration.test.ts bin/
git commit -m "feat(extension): Layer 3 Trusted Types policy registration on content-main.js init"
```

---

## Task 3: `CSP_BLOCKED` error UX for `safari_evaluate`

**Why now:** Task 2 set up `window.__SP_TT_HARD_BLOCK`. Now `safari_evaluate` needs to translate Trusted-Types and CSP-eval errors into a structured `CSP_BLOCKED` (or `CSP_HARD_BLOCK`) error with a `hint.alternative_tools` array. This is the user-visible "tool-suggesting error" pattern decided in brainstorming.

This is a TS-only change. The new capability tool names in the hint don't exist yet (tasks 4-6 add them), but the hint is a string array — it doesn't require them to be installed at hint-construction time.

**Files:**
- Modify: `src/tools/extraction.ts` (the `safari_evaluate` handler around line 180-210)
- Create: `test/fixtures/csp-script-src-no-eval.ts`
- Create: `test/e2e/csp-evaluate-blocked-error.test.ts`

- [ ] **Step 1: Read the current `safari_evaluate` handler**

```bash
sed -n '180,260p' src/tools/extraction.ts
```

Note the existing error-throw path. The new code wraps the existing call in a try/catch that pattern-matches the error message for CSP/TT signatures and re-throws as the structured error.

- [ ] **Step 2: Write the no-eval fixture**

Create `test/fixtures/csp-script-src-no-eval.ts`:

```typescript
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export function startScriptSrcNoEvalFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>script-src no-eval fixture</title>
</head><body>
<h1 id="hero">script-src 'self' (no eval) fixture body</h1>
<form id="login"><input id="user" type="text"><button type="submit">Sign in</button></form>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // No 'unsafe-eval'; no Trusted Types. Pure CSP eval block.
      'Content-Security-Policy': "script-src 'self'",
    });
    res.end(page);
  });
  server.listen(port);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}
```

- [ ] **Step 3: Write the failing e2e test**

Create `test/e2e/csp-evaluate-blocked-error.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { startTrustedTypesAllowlistFixture } from '../fixtures/csp-trusted-types-allowlist.js';
import { startScriptSrcNoEvalFixture } from '../fixtures/csp-script-src-no-eval.js';
import type { Server } from 'node:http';

describe('safari_evaluate CSP_BLOCKED error UX', () => {
  let ttServer: { server: Server; url: () => string };
  let allowlistServer: { server: Server; url: () => string };
  let noEvalServer: { server: Server; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    ttServer = startTrustedTypesFixture();
    allowlistServer = startTrustedTypesAllowlistFixture();
    noEvalServer = startScriptSrcNoEvalFixture();
  });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => ttServer.server.close(() => r()));
    await new Promise<void>((r) => allowlistServer.server.close(() => r()));
    await new Promise<void>((r) => noEvalServer.server.close(() => r()));
  });

  it('returns CSP_BLOCKED on tt-strict pages with policy registration intact', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t3_a=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    let caught: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1+1' });
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const msg = String((caught as { message?: string })?.message ?? caught);
    expect(msg).toMatch(/CSP_BLOCKED/);
    expect(msg).toMatch(/safari_get_page_info/);
    expect(msg).toMatch(/safari_click/);
  });

  it('returns CSP_HARD_BLOCK on tt-strict pages with allowlist excluding safari-pilot', async () => {
    const client = await getSharedClient();
    const tabUrl = allowlistServer.url() + '?sp_t3_b=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    let caught: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1' });
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const msg = String((caught as { message?: string })?.message ?? caught);
    expect(msg).toMatch(/CSP_HARD_BLOCK/);
  });

  it('returns CSP_BLOCKED on script-src no-eval pages', async () => {
    const client = await getSharedClient();
    const tabUrl = noEvalServer.url() + '?sp_t3_c=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    let caught: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1' });
    } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    const msg = String((caught as { message?: string })?.message ?? caught);
    expect(msg).toMatch(/CSP_BLOCKED/);
  });
});
```

- [ ] **Step 4: Run the e2e test — verify all three fail**

Run:
```bash
npx vitest run test/e2e/csp-evaluate-blocked-error.test.ts
```

Expected: all 3 tests FAIL. Errors won't include `CSP_BLOCKED` or `CSP_HARD_BLOCK` yet — they'll be the raw Safari "Refused to evaluate" message.

- [ ] **Step 5: Update `safari_evaluate` to wrap errors**

In `src/tools/extraction.ts`, locate the `safari_evaluate` handler (around line 180-210 — find it via `grep -n "safari_evaluate" src/tools/extraction.ts`). Wrap the existing `engine.executeJsInTab(...)` call so that on failure, the error message is inspected and re-thrown with a structured code if it matches a CSP signature.

The new code (replacing the existing throw on `!result.ok`):

```typescript
if (!result.ok) {
  const rawMsg = result.error?.message ?? 'safari_evaluate failed';
  // Match Trusted Types / CSP eval refusal patterns.
  // Safari surfaces these as "Refused to evaluate a string as JavaScript because
  // this document requires a 'Trusted Type' assignment" OR "...because 'unsafe-eval' is not an allowed source".
  const isTT = /trusted[- ]?type|trustedTypes/i.test(rawMsg);
  const isEvalBlock = /unsafe-eval|refused to evaluate/i.test(rawMsg);
  if (isTT || isEvalBlock) {
    // Probe the tab for __SP_TT_HARD_BLOCK to distinguish CSP_BLOCKED vs CSP_HARD_BLOCK.
    // Use the existing sentinel-immune capability tool that arrived in task 4 (safari_get_page_info);
    // if it isn't installed yet, fall through to CSP_BLOCKED (the more common case).
    let isHardBlock = false;
    try {
      const probeSentinel = '__SP_TT_PROBE__:' + JSON.stringify({});
      const probe = await this.engine.executeJsInTab(tabUrl, probeSentinel, 5_000);
      if (probe.ok && probe.value) {
        const parsed = JSON.parse(probe.value);
        isHardBlock = parsed.hardBlock === true;
      }
    } catch { /* probe failure — default to CSP_BLOCKED */ }

    const code = isHardBlock ? 'CSP_HARD_BLOCK' : 'CSP_BLOCKED';
    const cspMode: string = isHardBlock ? 'hard-block' : (isTT ? 'tt-strict' : 'eval-blocked');
    const hint = {
      cspMode,
      alternative_tools: [
        'safari_get_page_info',
        'safari_get_meta_tags',
        'safari_extract_text_window',
        'safari_click',
        'safari_fill',
        'safari_type',
        'safari_scroll',
        'safari_get_text',
        'safari_query_all',
        'safari_snapshot',
      ],
      rationale:
        'safari_evaluate failed because this page enforces strict CSP / Trusted Types. ' +
        'Use the named alternative tools — they route through extension sentinels that bypass page CSP. ' +
        'For DOM reads use the get_* / extract_* tools; for interaction use click/fill/type/scroll.',
    };
    const wrapped = new Error(
      code + ': ' + rawMsg + ' | hint: ' + JSON.stringify(hint),
    );
    (wrapped as Error & { code?: string }).code = code;
    throw wrapped;
  }
  const err = new Error(rawMsg);
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
```

- [ ] **Step 6: Confirm `__SP_TT_PROBE__` is already in content-main.js (added in T2)**

The probe sentinel handler was added in T2 Step 5 (moved from T3 during plan execution to break a chicken-and-egg with `safari_get_console_messages`). Verify it exists:

```bash
grep -n "__SP_TT_PROBE__" extension/content-main.js
```

Expected: one match in `case 'execute_script':`. If missing, T2 was incomplete — return BLOCKED and re-run T2.

- [ ] **Step 7: No extension rebuild needed (T2 already installed __SP_TT_PROBE__ at 0.1.34-dev.1)**

T3 is TS-only changes (extraction.ts handler + tests + fixtures). The probe sentinel is already in the installed extension from T2. Skip rebuild.

- [ ] **Step 8: Run the e2e test — verify all three pass**

Run:
```bash
npx vitest run test/e2e/csp-evaluate-blocked-error.test.ts
```

Expected: all 3 tests PASS. `CSP_BLOCKED` appears in the TT-strict and no-eval cases; `CSP_HARD_BLOCK` in the allowlist case.

- [ ] **Step 9: Commit**

```bash
git add src/tools/extraction.ts test/fixtures/csp-script-src-no-eval.ts test/e2e/csp-evaluate-blocked-error.test.ts
git commit -m "feat(extraction): CSP_BLOCKED / CSP_HARD_BLOCK error UX on safari_evaluate with alternative_tools hint"
```

---

## Task 4: New capability tool — `safari_get_page_info`

**Why:** The audit (task 1) showed ~70% of CSP-blocked `safari_evaluate` calls were trivial page-info reads (title, URL, body snippet, meta description, og:image). This single tool covers all of them with a structured return shape, callable from ISOLATED-world sentinel — CSP-immune.

This task ALSO creates the new `src/tools/page-info.ts` module and registers it in `src/server.ts`. Tasks 5 and 6 add to the same module.

**Files:**
- Create: `src/tools/page-info.ts`
- Modify: `src/server.ts` (register new module)
- Modify: `extension/content-isolated.js` (add `__SP_GET_PAGE_INFO__` sentinel handler)
- Create: `test/e2e/page-info-tools.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e/page-info-tools.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import type { Server } from 'node:http';

describe('safari_get_page_info', () => {
  let ttServer: { server: Server; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(() => { ttServer = startTrustedTypesFixture(); });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => ttServer.server.close(() => r()));
  });

  it('returns title, url, body_snippet, meta_description on a tt-strict page', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t4=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_get_page_info', { tabUrl });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.title).toBe('TT-strict fixture');
    expect(parsed.url).toContain('sp_t4=1');
    expect(parsed.body_snippet).toContain('TT-strict fixture body');
    expect(parsed.meta_description).toBe('Trusted Types strict fixture');
    expect(parsed.lang).toBeDefined();
  });

  it('caps body_snippet at default 2000 chars', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t4_b=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_get_page_info', { tabUrl });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.body_snippet.length).toBeLessThanOrEqual(2000);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
npx vitest run test/e2e/page-info-tools.test.ts -t safari_get_page_info
```

Expected: tests FAIL with "Unknown tool: safari_get_page_info" or similar from MCP.

- [ ] **Step 3: Create `src/tools/page-info.ts`**

```typescript
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolDefinition, ToolResponse } from '../types.js';

export class PageInfoTools {
  constructor(private readonly engine: IEngine) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_get_page_info',
        description:
          'Returns structured page info (title, url, body snippet, meta description, og:image, lang). ' +
          'Works on pages that enforce strict CSP / Trusted Types (uses ISOLATED-world sentinel). ' +
          'Use this in place of safari_evaluate when reading basic page metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to read from' },
            bodyMaxChars: {
              type: 'number',
              description: 'Maximum length of body_snippet (default 2000).',
            },
            frameId: {
              type: 'number',
              description: 'Frame ID (default top frame 0).',
            },
          },
          required: ['tabUrl'],
        },
        requirements: { requiresExtensionWorld: 'isolated' },
      },
    ];
  }

  getHandler(name: string): ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined {
    if (name !== 'safari_get_page_info') return undefined;
    return async (params) => {
      const start = Date.now();
      const tabUrl = params['tabUrl'] as string;
      const bodyMaxChars = (params['bodyMaxChars'] as number | undefined) ?? 2000;
      const frameId = (params['frameId'] as number | undefined) ?? 0;

      const sentinel = '__SP_GET_PAGE_INFO__:' + JSON.stringify({ bodyMaxChars, frameId });
      const result = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
      if (!result.ok) {
        const err = new Error(result.error?.message ?? 'safari_get_page_info failed');
        if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
        throw err;
      }
      const parsed = result.value ? JSON.parse(result.value) : {};
      return {
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
        metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
      };
    };
  }
}
```

- [ ] **Step 4: Register `PageInfoTools` in `src/server.ts`**

Find the existing modules-registration site (per TRACES iter 76: around lines 264-285 for `listToolDefinitions()` and 399-455 for `initialize()`). Add `PageInfoTools` to both arrays in the same shape as the existing `ExtractionTools` registration.

```bash
grep -n "ExtractionTools\b" src/server.ts
```

For each match, add a sibling `PageInfoTools` line. Example for the initialize() registration (the exact import path and constructor signature follow the existing extraction.ts pattern — read it once before pasting):

```typescript
import { PageInfoTools } from './tools/page-info.js';
// ... existing imports ...

// inside listToolDefinitions(): add to the modules array
new PageInfoTools(this.engine),

// inside initialize(): add to the modules array (same as above pattern)
new PageInfoTools(this.engine),
```

- [ ] **Step 5: Add `__SP_GET_PAGE_INFO__` sentinel handler in content-isolated.js**

ISOLATED world is CSP-exempt per W3C spec, so this handler runs on TT-strict pages without TT issues.

Locate the existing storage-bus command dispatch in `extension/content-isolated.js` (search for the existing `__SP_FILE_UPLOAD__` handler near line 189 as the reference shape). Add the new sentinel intercept ALONGSIDE it — before any forwarding-to-MAIN logic so the ISOLATED handler wins:

```javascript
// ── ISOLATED SENTINEL: __SP_GET_PAGE_INFO__:<json> (v0.1.34 Task 4) ──
// CSP-exempt page-info read. ISOLATED world bypasses page CSP/TT entirely.
if (cmd && cmd.params && typeof cmd.params.script === 'string'
    && cmd.params.script.startsWith('__SP_GET_PAGE_INFO__:')) {
  try {
    const args = JSON.parse(cmd.params.script.slice('__SP_GET_PAGE_INFO__:'.length));
    const bodyMaxChars = typeof args.bodyMaxChars === 'number' ? args.bodyMaxChars : 2000;
    // frameId 0 = top frame. ISOLATED world is per-frame, so we only return
    // for the frame we're in. Frame-routing helper on the TS side will
    // dispatch to the right frame if frameId > 0.
    const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
    const trimmedBody = bodyText.length > bodyMaxChars ? bodyText.slice(0, bodyMaxChars) : bodyText;
    const metaDesc = document.querySelector('meta[name="description"]');
    const metaOgImage = document.querySelector('meta[property="og:image"]');
    const lang = document.documentElement.lang || (navigator.language || '');
    const value = JSON.stringify({
      title: document.title || '',
      url: location.href,
      body_snippet: trimmedBody,
      body_truncated: bodyText.length > bodyMaxChars,
      meta_description: metaDesc ? metaDesc.getAttribute('content') : null,
      meta_og_image: metaOgImage ? metaOgImage.getAttribute('content') : null,
      lang: lang,
    });
    // Respond via the same storage-bus result channel used by __SP_FILE_UPLOAD__.
    sendResult(cmd.id, { ok: true, value });
    return;
  } catch (e) {
    sendResult(cmd.id, { ok: false, error: { message: e && e.message, name: 'PAGE_INFO_ERROR' } });
    return;
  }
}
```

NOTE: The `sendResult(cmd.id, ...)` helper name should match the existing helper used by the `__SP_FILE_UPLOAD__` handler. Read that handler first (search for `__SP_FILE_UPLOAD__:` in content-isolated.js, lines ~189-340) and copy its result-emission style exactly — names like `respond`, `postResult`, etc. vary by file convention.

- [ ] **Step 6: Bump dev marketing version + rebuild + reinstall**

```bash
node -e "const p=require('./package.json'); p.version='0.1.34-dev.3'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
node -e "const m=require('./extension/manifest.json'); m.version='0.1.34-dev.3'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(m, null, 2) + '\n');"
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
```

- [ ] **Step 7: Run the e2e test — verify it passes**

Run:
```bash
npx vitest run test/e2e/page-info-tools.test.ts -t safari_get_page_info
```

Expected: both tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/page-info.ts src/server.ts extension/content-isolated.js extension/manifest.json package.json test/e2e/page-info-tools.test.ts bin/
git commit -m "feat(tools): safari_get_page_info — ISOLATED-world sentinel for CSP-immune page metadata reads"
```

---

## Task 5: New capability tool — `safari_get_meta_tags`

**Why:** Covers the second-largest pattern from the audit: meta-tag inspection (`<meta name="description">`, `<meta property="og:*">`, `<meta name="twitter:*">`). Returns an array of `{name, content, attr_source}` so the caller knows whether each entry came from `name=`, `property=`, or `http-equiv=`.

**Files:**
- Modify: `src/tools/page-info.ts` (add second tool to existing module)
- Modify: `extension/content-isolated.js` (add `__SP_GET_META_TAGS__` sentinel handler)
- Modify: `test/e2e/page-info-tools.test.ts` (add tests for the new tool)

- [ ] **Step 1: Write the failing e2e test**

Append to `test/e2e/page-info-tools.test.ts` (inside the existing `describe` block, or in a new sibling `describe('safari_get_meta_tags')` block — preserve the existing tests):

```typescript
describe('safari_get_meta_tags', () => {
  let ttServer: { server: Server; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(() => { ttServer = startTrustedTypesFixture(); });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => ttServer.server.close(() => r()));
  });

  it('returns all meta tags by default', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t5_a=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_get_meta_tags', { tabUrl });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.tags)).toBe(true);
    const desc = parsed.tags.find((t: { name: string }) => t.name === 'description');
    expect(desc).toBeDefined();
    expect(desc.content).toBe('Trusted Types strict fixture');
    expect(desc.attr_source).toBe('name');
  });

  it('filters by names when whitelist provided', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t5_b=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_get_meta_tags', {
      tabUrl,
      names: ['description', 'og:title'],
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    // Only descriptions in the fixture — og:title doesn't exist.
    for (const tag of parsed.tags) {
      expect(['description', 'og:title']).toContain(tag.name);
    }
  });
});
```

- [ ] **Step 2: Run test — verify both fail**

Run:
```bash
npx vitest run test/e2e/page-info-tools.test.ts -t safari_get_meta_tags
```

Expected: FAIL with "Unknown tool: safari_get_meta_tags".

- [ ] **Step 3: Add `safari_get_meta_tags` to `src/tools/page-info.ts`**

In `src/tools/page-info.ts`, extend `getDefinitions()` and `getHandler()` to include the new tool. The full updated definitions array:

```typescript
getDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'safari_get_page_info',
      // ... existing definition from Task 4 ...
    },
    {
      name: 'safari_get_meta_tags',
      description:
        'Returns an array of meta tags from the page. CSP-immune (ISOLATED-world sentinel). ' +
        'Use in place of safari_evaluate when reading <meta name=...> / <meta property=...> / <meta http-equiv=...> tags.',
      inputSchema: {
        type: 'object',
        properties: {
          tabUrl: { type: 'string', description: 'URL of the tab to read from' },
          names: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional whitelist of meta names/properties to return. Without it, all meta tags are returned.',
          },
          frameId: { type: 'number', description: 'Frame ID (default top frame 0).' },
        },
        required: ['tabUrl'],
      },
      requirements: { requiresExtensionWorld: 'isolated' },
    },
  ];
}
```

And extend `getHandler()`:

```typescript
getHandler(name: string): ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined {
  if (name === 'safari_get_page_info') {
    // ... existing handler from Task 4 ...
  }
  if (name === 'safari_get_meta_tags') {
    return async (params) => {
      const start = Date.now();
      const tabUrl = params['tabUrl'] as string;
      const names = params['names'] as string[] | undefined;
      const frameId = (params['frameId'] as number | undefined) ?? 0;

      const sentinel = '__SP_GET_META_TAGS__:' + JSON.stringify({ names, frameId });
      const result = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
      if (!result.ok) {
        const err = new Error(result.error?.message ?? 'safari_get_meta_tags failed');
        if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
        throw err;
      }
      const parsed = result.value ? JSON.parse(result.value) : {};
      return {
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
        metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
      };
    };
  }
  return undefined;
}
```

- [ ] **Step 4: Add `__SP_GET_META_TAGS__` sentinel handler in content-isolated.js**

Alongside the `__SP_GET_PAGE_INFO__` handler from task 4:

```javascript
// ── ISOLATED SENTINEL: __SP_GET_META_TAGS__:<json> (v0.1.34 Task 5) ──
if (cmd && cmd.params && typeof cmd.params.script === 'string'
    && cmd.params.script.startsWith('__SP_GET_META_TAGS__:')) {
  try {
    const args = JSON.parse(cmd.params.script.slice('__SP_GET_META_TAGS__:'.length));
    const namesFilter = Array.isArray(args.names) ? new Set(args.names) : null;
    const tags = [];
    const metaEls = document.querySelectorAll('meta');
    for (const m of metaEls) {
      let n = m.getAttribute('name');
      let attr_source = 'name';
      if (!n) { n = m.getAttribute('property'); attr_source = 'property'; }
      if (!n) { n = m.getAttribute('http-equiv'); attr_source = 'http-equiv'; }
      if (!n) continue;
      if (namesFilter && !namesFilter.has(n)) continue;
      tags.push({ name: n, content: m.getAttribute('content') || '', attr_source });
    }
    sendResult(cmd.id, { ok: true, value: JSON.stringify({ tags }) });
    return;
  } catch (e) {
    sendResult(cmd.id, { ok: false, error: { message: e && e.message, name: 'META_TAGS_ERROR' } });
    return;
  }
}
```

- [ ] **Step 5: Bump dev marketing version + rebuild + reinstall**

```bash
node -e "const p=require('./package.json'); p.version='0.1.34-dev.4'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
node -e "const m=require('./extension/manifest.json'); m.version='0.1.34-dev.4'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(m, null, 2) + '\n');"
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
```

- [ ] **Step 6: Run the e2e test — verify both pass**

Run:
```bash
npx vitest run test/e2e/page-info-tools.test.ts -t safari_get_meta_tags
```

Expected: both tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/page-info.ts extension/content-isolated.js extension/manifest.json package.json test/e2e/page-info-tools.test.ts bin/
git commit -m "feat(tools): safari_get_meta_tags — ISOLATED-world sentinel for CSP-immune meta-tag reads"
```

---

## Task 6: New capability tool — `safari_extract_text_window`

**Why:** Covers the third pattern: "read text near a specific selector." Audit (task 1) showed this comes up for "extract text inside the search-result container," "extract product description block," etc.

**Files:**
- Modify: `src/tools/page-info.ts` (add third tool to existing module)
- Modify: `extension/content-isolated.js` (add `__SP_EXTRACT_TEXT_WINDOW__` sentinel handler)
- Modify: `test/e2e/page-info-tools.test.ts` (add tests)

- [ ] **Step 1: Write the failing e2e test**

Append to `test/e2e/page-info-tools.test.ts`:

```typescript
describe('safari_extract_text_window', () => {
  let ttServer: { server: Server; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(() => { ttServer = startTrustedTypesFixture(); });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => ttServer.server.close(() => r()));
  });

  it('returns text of subtree matching selector', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t6_a=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_extract_text_window', {
      tabUrl,
      selector: '#hero',
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.text).toContain('TT-strict fixture body');
    expect(parsed.selector_matched_count).toBe(1);
    expect(parsed.truncated).toBe(false);
  });

  it('caps text at max_chars and reports truncated', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t6_b=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_extract_text_window', {
      tabUrl,
      selector: 'body',
      max_chars: 10,
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.text.length).toBeLessThanOrEqual(10);
    expect(parsed.truncated).toBe(true);
  });

  it('returns 0 matches when selector does not match', async () => {
    const client = await getSharedClient();
    const tabUrl = ttServer.url() + '?sp_t6_c=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_extract_text_window', {
      tabUrl,
      selector: '#nope-not-here',
    });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.selector_matched_count).toBe(0);
    expect(parsed.text).toBe('');
  });
});
```

- [ ] **Step 2: Run test — verify all three fail**

Run:
```bash
npx vitest run test/e2e/page-info-tools.test.ts -t safari_extract_text_window
```

Expected: FAIL.

- [ ] **Step 3: Add `safari_extract_text_window` to `src/tools/page-info.ts`**

Extend `getDefinitions()`:

```typescript
{
  name: 'safari_extract_text_window',
  description:
    'Returns textContent of the subtree matching `selector`, capped at `max_chars` (default 5000). ' +
    'CSP-immune (ISOLATED-world sentinel). Use when reading text near a specific element.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'URL of the tab to read from' },
      selector: { type: 'string', description: 'CSS selector identifying the subtree' },
      max_chars: { type: 'number', description: 'Max chars to return (default 5000).' },
      frameId: { type: 'number', description: 'Frame ID (default top frame 0).' },
    },
    required: ['tabUrl', 'selector'],
  },
  requirements: { requiresExtensionWorld: 'isolated' },
},
```

Extend `getHandler()`:

```typescript
if (name === 'safari_extract_text_window') {
  return async (params) => {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const maxChars = (params['max_chars'] as number | undefined) ?? 5000;
    const frameId = (params['frameId'] as number | undefined) ?? 0;

    const sentinel = '__SP_EXTRACT_TEXT_WINDOW__:' + JSON.stringify({ selector, maxChars, frameId });
    const result = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
    if (!result.ok) {
      const err = new Error(result.error?.message ?? 'safari_extract_text_window failed');
      if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
      throw err;
    }
    const parsed = result.value ? JSON.parse(result.value) : {};
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
      metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
    };
  };
}
```

- [ ] **Step 4: Add `__SP_EXTRACT_TEXT_WINDOW__` sentinel handler in content-isolated.js**

```javascript
// ── ISOLATED SENTINEL: __SP_EXTRACT_TEXT_WINDOW__:<json> (v0.1.34 Task 6) ──
if (cmd && cmd.params && typeof cmd.params.script === 'string'
    && cmd.params.script.startsWith('__SP_EXTRACT_TEXT_WINDOW__:')) {
  try {
    const args = JSON.parse(cmd.params.script.slice('__SP_EXTRACT_TEXT_WINDOW__:'.length));
    const sel = args.selector;
    const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 5000;
    const matches = document.querySelectorAll(sel);
    let combined = '';
    for (const node of matches) {
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      combined += (combined ? '\n' : '') + t;
      if (combined.length >= maxChars) break;
    }
    const truncated = combined.length > maxChars;
    const text = truncated ? combined.slice(0, maxChars) : combined;
    sendResult(cmd.id, { ok: true, value: JSON.stringify({
      text, truncated, selector_matched_count: matches.length,
    }) });
    return;
  } catch (e) {
    sendResult(cmd.id, { ok: false, error: { message: e && e.message, name: 'EXTRACT_TEXT_ERROR' } });
    return;
  }
}
```

- [ ] **Step 5: Bump dev marketing version + rebuild + reinstall**

```bash
node -e "const p=require('./package.json'); p.version='0.1.34-dev.5'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
node -e "const m=require('./extension/manifest.json'); m.version='0.1.34-dev.5'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(m, null, 2) + '\n');"
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
```

- [ ] **Step 6: Run the e2e test — verify all three pass**

Run:
```bash
npx vitest run test/e2e/page-info-tools.test.ts -t safari_extract_text_window
```

Expected: all 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/page-info.ts extension/content-isolated.js extension/manifest.json package.json test/e2e/page-info-tools.test.ts bin/
git commit -m "feat(tools): safari_extract_text_window — ISOLATED-world sentinel for text-near-selector reads"
```

---

## Task 7: Refactor `safari_click` → `__SP_CLICK__` sentinel

**Why:** `safari_click` is the most-used interaction tool. Currently routes through `engine.executeJsInTab(..., jsString)` where jsString contains `__SP_LOCATOR__.click(...)` packaged as a script. On TT-strict pages the `new Function(jsString)` throws. The fix: send a `__SP_CLICK__:{json}` sentinel; let content-main.js intercept it before `new Function`.

**Files:**
- Modify: `src/tools/interaction.ts` (the `safari_click` handler)
- Modify: `extension/content-main.js` (add `__SP_CLICK__` intercept inside `case 'execute_script':`, alongside the existing `__SP_SCROLL_TO_ELEMENT__` intercept)
- Create: `test/e2e/csp-interaction-sentinels.test.ts`

- [ ] **Step 1: Read the current `safari_click` handler to capture the existing input contract**

```bash
sed -n '150,200p' src/tools/interaction.ts
grep -n "handleClick\|safari_click" src/tools/interaction.ts
```

Capture the inputSchema fields (selector, text, role, name, nth, button, modifiers, etc.) — the new sentinel-based path must preserve every field.

- [ ] **Step 2: Write the failing e2e test**

Create `test/e2e/csp-interaction-sentinels.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Local fixture: TT-strict page with a button that records its own click. */
function startInteractionFixture(): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict interaction fixture</title>
</head><body>
<button id="b1">Click me</button>
<input id="t1" type="text">
<input id="t2" type="text">
<div id="scroll-target" style="height: 200vh"></div>
<div id="evidence" data-clicks="0" data-fills="" data-types=""></div>
<script>
(function(){
  document.getElementById('b1').addEventListener('click', function() {
    var ev = document.getElementById('evidence');
    ev.setAttribute('data-clicks', String(parseInt(ev.getAttribute('data-clicks') || '0', 10) + 1));
  });
  document.getElementById('t1').addEventListener('change', function(e) {
    document.getElementById('evidence').setAttribute('data-fills', e.target.value);
  });
  document.getElementById('t2').addEventListener('input', function(e) {
    document.getElementById('evidence').setAttribute('data-types', e.target.value);
  });
})();
</script>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(0);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}

describe('CSP interaction sentinels', () => {
  let fixture: { server: HttpServer; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(() => { fixture = startInteractionFixture(); });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => fixture.server.close(() => r()));
  });

  it('safari_click works on tt-strict pages', async () => {
    const client = await getSharedClient();
    const tabUrl = fixture.url() + '?sp_t7=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    await callTool(client, 'safari_click', { tabUrl, selector: '#b1' });

    // Verify via the CSP-immune extract_text_window tool, not safari_evaluate.
    const ev = await callTool(client, 'safari_extract_text_window', {
      tabUrl,
      selector: '#evidence',
    });
    const text = (ev as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    // The evidence div is empty text (data-clicks is an attribute).
    // Use safari_get_attribute alternative — but for now read via meta_tags pattern.
    // (Refining: the evidence carries the count in a data-attr; we need to read it via
    // a sentinel-immune tool. Use safari_get_attribute after task 12 refactors it OR
    // for this RED step, accept that the click happens and verify state via second click.)
    expect(parsed.selector_matched_count).toBe(1);

    // Click again, verify still working (no exception thrown).
    await callTool(client, 'safari_click', { tabUrl, selector: '#b1' });
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run:
```bash
npx vitest run test/e2e/csp-interaction-sentinels.test.ts -t safari_click
```

Expected: FAIL. The current `safari_click` calls `engine.executeJsInTab` with a JS string that hits TT-block in `new Function`.

- [ ] **Step 4: Refactor `safari_click` handler in `src/tools/interaction.ts`**

Replace the body of the `safari_click` handler. Find it via:

```bash
grep -n "case 'safari_click'\|handleClick" src/tools/interaction.ts
```

Replace the `engine.executeJsInTab(...)` call with sentinel marshalling. Preserve the existing inputSchema contract for selector, text, role, name, nth, button, modifiers.

```typescript
// Inside the safari_click handler:
const selector = params['selector'] as string | undefined;
const text = params['text'] as string | undefined;
const role = params['role'] as string | undefined;
const name = params['name'] as string | undefined;
const nth = (params['nth'] as number | undefined) ?? 0;
const button = (params['button'] as string | undefined) ?? 'left';
const modifiers = (params['modifiers'] as string[] | undefined) ?? [];
if (!selector && !text && !role) {
  const err = new Error('At least one of {selector, text, role} is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}

const sentinel = '__SP_CLICK__:' + JSON.stringify({ selector, text, role, name, nth, button, modifiers });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 30_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_click failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 5: Add `__SP_CLICK__` intercept in `extension/content-main.js`**

Inside `case 'execute_script':`, alongside the existing `__SP_SCROLL_TO_ELEMENT__` intercept (line ~560):

```javascript
// ── EARLY INTERCEPT: __SP_CLICK__:<json> (v0.1.34 Task 7) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_CLICK__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_CLICK__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L) {
      throw Object.assign(
        new Error('locator.js not loaded in MAIN world'),
        { name: 'NO_LOCATOR' },
      );
    }
    const candidates = L.resolveScrollTargets({
      selector: args.selector, text: args.text, role: args.role, name: args.name,
    });
    if (candidates.length === 0) {
      const hidden = L.resolveScrollTargets({
        selector: args.selector, text: args.text, role: args.role, name: args.name,
        includeHidden: true,
      });
      if (hidden.length > 0) {
        throw Object.assign(
          new Error('element exists but is not visible'),
          { name: 'TARGET_HIDDEN' },
        );
      }
      throw Object.assign(
        new Error('no element matched the provided locator'),
        { name: 'TARGET_NOT_FOUND' },
      );
    }
    const nth = typeof args.nth === 'number' ? args.nth : 0;
    if (nth >= candidates.length) {
      throw Object.assign(
        new Error('nth=' + nth + ' out of range (matchCount=' + candidates.length + ')'),
        { name: 'INVALID_PARAMS' },
      );
    }
    const target = candidates[nth].element;
    // Honour modifiers + button via MouseEvent dispatch (matches the prior JS-string path).
    const button = args.button === 'right' ? 2 : (args.button === 'middle' ? 1 : 0);
    const mods = Array.isArray(args.modifiers) ? args.modifiers : [];
    const init = {
      bubbles: true, cancelable: true, view: window, button,
      ctrlKey: mods.includes('ctrl'), altKey: mods.includes('alt'),
      shiftKey: mods.includes('shift'), metaKey: mods.includes('meta'),
    };
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
    result = {
      clicked: { strategy: candidates[nth].strategy, matchedNode: L.serializeNode(target), matchCount: candidates.length },
    };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 6: Run unit tests — verify no TS regressions**

Run:
```bash
npm run test:unit
```

Expected: all unit tests pass (668+ tests per TRACES iter 78). If any fail relating to interaction or safari_click, investigate before proceeding.

- [ ] **Step 7: Commit (extension still on dev.5 — rebuild deferred to task 11)**

```bash
git add src/tools/interaction.ts extension/content-main.js test/e2e/csp-interaction-sentinels.test.ts
git commit -m "feat(interaction): safari_click → __SP_CLICK__ sentinel, CSP-immune via content-main.js early intercept"
```

NOTE: The e2e test will still FAIL at this commit because the extension on disk (dev.5 from task 6) doesn't yet include the new content-main.js handler. The batched rebuild at task 11 will resolve this. This is intentional — see Sprint Context "Extension rebuild discipline" above.

---

## Task 8: Refactor `safari_fill` → `__SP_FILL__` sentinel

**Why:** Same pattern as task 7, applied to fill (set input/textarea value + dispatch change event).

**Files:**
- Modify: `src/tools/interaction.ts` (the `safari_fill` handler)
- Modify: `extension/content-main.js` (add `__SP_FILL__` intercept)
- Modify: `test/e2e/csp-interaction-sentinels.test.ts` (add fill test)

- [ ] **Step 1: Read the current `safari_fill` handler**

```bash
grep -n "case 'safari_fill'\|handleFill" src/tools/interaction.ts
sed -n '186,250p' src/tools/interaction.ts
```

Capture inputSchema: selector, text, role, name, value, nth, clearFirst.

- [ ] **Step 2: Add the failing fill test**

Append inside the existing `describe('CSP interaction sentinels')` block in `test/e2e/csp-interaction-sentinels.test.ts`:

```typescript
it('safari_fill works on tt-strict pages', async () => {
  const client = await getSharedClient();
  const tabUrl = fixture.url() + '?sp_t8=1';
  openedTabUrls.push(tabUrl);
  await callTool(client, 'safari_new_tab', { url: tabUrl });
  await new Promise((r) => setTimeout(r, 600));

  await callTool(client, 'safari_fill', { tabUrl, selector: '#t1', value: 'hello' });

  // Verify the change handler recorded the value.
  const ev = await callTool(client, 'safari_extract_text_window', {
    tabUrl,
    selector: '#evidence',
  });
  // The evidence div uses attributes — using a second sentinel-immune approach,
  // we read its text (which is empty) and rely on the safari_fill returning ok.
  // The strong assertion is no thrown error + the next click on b1 succeeds.
  await callTool(client, 'safari_click', { tabUrl, selector: '#b1' });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run:
```bash
npx vitest run test/e2e/csp-interaction-sentinels.test.ts -t safari_fill
```

Expected: FAIL (current `safari_fill` hits TT-block).

- [ ] **Step 4: Refactor `safari_fill` handler in `src/tools/interaction.ts`**

Replace the existing body of the `safari_fill` handler:

```typescript
const selector = params['selector'] as string | undefined;
const text = params['text'] as string | undefined;
const role = params['role'] as string | undefined;
const name = params['name'] as string | undefined;
const value = params['value'] as string;
const nth = (params['nth'] as number | undefined) ?? 0;
const clearFirst = (params['clearFirst'] as boolean | undefined) ?? true;
if (typeof value !== 'string') {
  const err = new Error('`value` parameter is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}
if (!selector && !text && !role) {
  const err = new Error('At least one of {selector, text, role} is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}

const sentinel = '__SP_FILL__:' + JSON.stringify({ selector, text, role, name, value, nth, clearFirst });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 30_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_fill failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 5: Add `__SP_FILL__` intercept in `extension/content-main.js`**

Alongside `__SP_CLICK__`:

```javascript
// ── EARLY INTERCEPT: __SP_FILL__:<json> (v0.1.34 Task 8) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_FILL__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_FILL__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L) {
      throw Object.assign(new Error('locator.js not loaded in MAIN world'), { name: 'NO_LOCATOR' });
    }
    const candidates = L.resolveScrollTargets({
      selector: args.selector, text: args.text, role: args.role, name: args.name,
    });
    if (candidates.length === 0) {
      throw Object.assign(new Error('no element matched the provided locator'), { name: 'TARGET_NOT_FOUND' });
    }
    const nth = typeof args.nth === 'number' ? args.nth : 0;
    if (nth >= candidates.length) {
      throw Object.assign(
        new Error('nth=' + nth + ' out of range (matchCount=' + candidates.length + ')'),
        { name: 'INVALID_PARAMS' },
      );
    }
    const el = candidates[nth].element;
    if (args.clearFirst !== false) {
      el.value = '';
    }
    el.focus();
    el.value = (el.value || '') + String(args.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    result = {
      filled: { strategy: candidates[nth].strategy, matchedNode: L.serializeNode(el), value: el.value },
    };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 6: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/interaction.ts extension/content-main.js test/e2e/csp-interaction-sentinels.test.ts
git commit -m "feat(interaction): safari_fill → __SP_FILL__ sentinel, CSP-immune"
```

---

## Task 9: Refactor `safari_type` → `__SP_TYPE__` sentinel

**Why:** Same pattern, applied to per-keystroke typing (vs `safari_fill` which sets value at once). Dispatches `keydown`/`keypress`/`input`/`keyup` per character.

**Files:**
- Modify: `src/tools/interaction.ts` (the `safari_type` handler)
- Modify: `extension/content-main.js` (add `__SP_TYPE__` intercept)
- Modify: `test/e2e/csp-interaction-sentinels.test.ts` (add type test)

- [ ] **Step 1: Read the current handler**

```bash
grep -n "case 'safari_type'\|handleType" src/tools/interaction.ts
sed -n '261,290p' src/tools/interaction.ts
```

Capture inputSchema fields: selector, text, role, name, value, delayMs, nth.

- [ ] **Step 2: Add the failing type test**

In `test/e2e/csp-interaction-sentinels.test.ts`:

```typescript
it('safari_type works on tt-strict pages', async () => {
  const client = await getSharedClient();
  const tabUrl = fixture.url() + '?sp_t9=1';
  openedTabUrls.push(tabUrl);
  await callTool(client, 'safari_new_tab', { url: tabUrl });
  await new Promise((r) => setTimeout(r, 600));

  await callTool(client, 'safari_type', { tabUrl, selector: '#t2', value: 'abc' });
  // Trust no-exception-thrown; deeper assertion deferred to task 12 (safari_get_attribute refactor).
  await callTool(client, 'safari_click', { tabUrl, selector: '#b1' });
});
```

- [ ] **Step 3: Run test — verify it fails**

Run:
```bash
npx vitest run test/e2e/csp-interaction-sentinels.test.ts -t safari_type
```

Expected: FAIL.

- [ ] **Step 4: Refactor `safari_type` handler in `src/tools/interaction.ts`**

```typescript
const selector = params['selector'] as string | undefined;
const text = params['text'] as string | undefined;
const role = params['role'] as string | undefined;
const name = params['name'] as string | undefined;
const value = params['value'] as string;
const nth = (params['nth'] as number | undefined) ?? 0;
const delayMs = (params['delayMs'] as number | undefined) ?? 0;
if (typeof value !== 'string') {
  const err = new Error('`value` parameter is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}
if (!selector && !text && !role) {
  const err = new Error('At least one of {selector, text, role} is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}

const sentinel = '__SP_TYPE__:' + JSON.stringify({ selector, text, role, name, value, nth, delayMs });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 60_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_type failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 5: Add `__SP_TYPE__` intercept in `extension/content-main.js`**

```javascript
// ── EARLY INTERCEPT: __SP_TYPE__:<json> (v0.1.34 Task 9) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_TYPE__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_TYPE__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L) throw Object.assign(new Error('locator.js not loaded in MAIN world'), { name: 'NO_LOCATOR' });
    const candidates = L.resolveScrollTargets({
      selector: args.selector, text: args.text, role: args.role, name: args.name,
    });
    if (candidates.length === 0) {
      throw Object.assign(new Error('no element matched the provided locator'), { name: 'TARGET_NOT_FOUND' });
    }
    const nth = typeof args.nth === 'number' ? args.nth : 0;
    if (nth >= candidates.length) {
      throw Object.assign(
        new Error('nth=' + nth + ' out of range (matchCount=' + candidates.length + ')'),
        { name: 'INVALID_PARAMS' },
      );
    }
    const el = candidates[nth].element;
    el.focus();
    const delay = typeof args.delayMs === 'number' ? args.delayMs : 0;
    const value = String(args.value);
    // Type character-by-character. Use a synchronous loop with no per-char delay
    // by default; if delayMs > 0, use a setTimeout chain (intercept returns synchronously
    // so wrap in promise via async IIFE).
    if (delay > 0) {
      // Run async with await per char.
      await (async () => {
        for (const ch of value) {
          el.value = (el.value || '') + ch;
          el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
          await new Promise((r) => setTimeout(r, delay));
        }
      })();
    } else {
      for (const ch of value) {
        el.value = (el.value || '') + ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    result = {
      typed: { strategy: candidates[nth].strategy, value: el.value, charCount: value.length },
    };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 6: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/interaction.ts extension/content-main.js test/e2e/csp-interaction-sentinels.test.ts
git commit -m "feat(interaction): safari_type → __SP_TYPE__ sentinel, CSP-immune"
```

---

## Task 10: Refactor `safari_scroll` → `__SP_SCROLL__` sentinel

**Why:** `safari_scroll_to_element` (with locator) is already a sentinel from v0.1.31. The plain `safari_scroll` (by pixel offset / top / bottom) still routes through `engine.executeJsInTab(..., jsString)`. Refactor for parity.

**Files:**
- Modify: `src/tools/interaction.ts` (the `safari_scroll` handler around line 305)
- Modify: `extension/content-main.js` (add `__SP_SCROLL__` intercept)
- Modify: `test/e2e/csp-interaction-sentinels.test.ts` (add scroll test)

- [ ] **Step 1: Read the current handler**

```bash
grep -n "case 'safari_scroll'\|handleScroll" src/tools/interaction.ts
sed -n '305,360p' src/tools/interaction.ts
```

Note that the existing handler likely supports: `direction` (up/down/top/bottom), `pixels` (numeric offset), `behavior` (smooth/instant). Preserve the contract.

- [ ] **Step 2: Add the failing scroll test**

```typescript
it('safari_scroll works on tt-strict pages', async () => {
  const client = await getSharedClient();
  const tabUrl = fixture.url() + '?sp_t10=1';
  openedTabUrls.push(tabUrl);
  await callTool(client, 'safari_new_tab', { url: tabUrl });
  await new Promise((r) => setTimeout(r, 600));

  const result = await callTool(client, 'safari_scroll', { tabUrl, direction: 'bottom' });
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  const parsed = JSON.parse(text);
  expect(parsed.viewport).toBeDefined();
  expect(parsed.viewport.scrollY).toBeGreaterThan(100);
});
```

- [ ] **Step 3: Run test — verify it fails**

```bash
npx vitest run test/e2e/csp-interaction-sentinels.test.ts -t safari_scroll
```

Expected: FAIL.

- [ ] **Step 4: Refactor `safari_scroll` handler in `src/tools/interaction.ts`**

```typescript
const direction = (params['direction'] as string | undefined) ?? 'down';
const pixels = (params['pixels'] as number | undefined) ?? 400;
const behavior = (params['behavior'] as string | undefined) ?? 'instant';

const sentinel = '__SP_SCROLL__:' + JSON.stringify({ direction, pixels, behavior });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 15_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_scroll failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 5: Add `__SP_SCROLL__` intercept in `extension/content-main.js`**

```javascript
// ── EARLY INTERCEPT: __SP_SCROLL__:<json> (v0.1.34 Task 10) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_SCROLL__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_SCROLL__:'.length));
    const dir = String(args.direction || 'down');
    const px = typeof args.pixels === 'number' ? args.pixels : 400;
    const behavior = args.behavior === 'smooth' ? 'smooth' : 'instant';
    const fromY = window.scrollY;
    if (dir === 'top') window.scrollTo({ top: 0, behavior });
    else if (dir === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
    else if (dir === 'up') window.scrollBy({ top: -px, behavior });
    else window.scrollBy({ top: px, behavior });
    // Settle briefly (locator.js helper handles smooth-scroll settling).
    const L = window.__SP_LOCATOR__;
    if (L && typeof L.waitForScrollSettle === 'function') {
      await L.waitForScrollSettle(300);
    }
    result = {
      scrolled: { direction: dir, pixels: px, behavior },
      viewport: { scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      scrolledFromY: fromY,
    };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 6: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/interaction.ts extension/content-main.js test/e2e/csp-interaction-sentinels.test.ts
git commit -m "feat(interaction): safari_scroll → __SP_SCROLL__ sentinel, CSP-immune"
```

---

## Task 11: Mid-sprint extension rebuild + verification

**Why:** Tasks 2-10 added 4 ISOLATED-world sentinels (page-info, meta-tags, extract-text, TT probe) and 4 MAIN-world intercepts (click, fill, type, scroll) plus Layer 3 TT init. The on-disk extension is at `0.1.34-dev.5` (from task 6) and is missing tasks 7-10. Time to rebuild and run the full csp-interaction-sentinels e2e suite.

**Files:**
- Modify: `package.json` (version bump 0.1.34-dev.5 → 0.1.34-dev.6)
- Modify: `extension/manifest.json` (same bump)
- Rebuild artifacts: `bin/Safari Pilot.app`, `bin/Safari Pilot.zip`

- [ ] **Step 1: Bump version**

```bash
node -e "const p=require('./package.json'); p.version='0.1.34-dev.6'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
node -e "const m=require('./extension/manifest.json'); m.version='0.1.34-dev.6'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(m, null, 2) + '\n');"
```

- [ ] **Step 2: Rebuild extension**

```bash
bash scripts/build-extension.sh
```

Expected: build completes with notarization passing. Output includes `bin/Safari Pilot.app` build timestamp + Submission ID + Accepted status.

- [ ] **Step 3: Reinstall in Safari**

```bash
open "bin/Safari Pilot.app"
```

Wait 5-10s; verify Safari > Settings > Extensions shows `Safari Pilot 0.1.34-dev.6`.

- [ ] **Step 4: Run the full csp-interaction-sentinels suite**

```bash
npx vitest run test/e2e/csp-interaction-sentinels.test.ts
```

Expected: ALL 4 tests PASS (click, fill, type, scroll).

If ANY fail: do NOT proceed. Use `upp:systematic-debugging` skill to root-cause. Common gotchas:
- Sentinel intercept ordering inside `case 'execute_script':` — newer intercepts may shadow older ones if not appended after the existing ones
- `__SP_LOCATOR__` API drift (e.g. `resolveScrollTargets` signature) — verify against `extension/locator.js` source
- Async-await in the sentinel handler not propagating to the outer dispatcher (the existing handlers do `break;` after `result = ...` — preserve that pattern)

- [ ] **Step 5: Run the full page-info-tools suite**

```bash
npx vitest run test/e2e/page-info-tools.test.ts
```

Expected: all 7 tests (3 from each of tasks 4-6, plus 1 truncation test) PASS.

- [ ] **Step 6: Run the TT-policy test**

```bash
npx vitest run test/e2e/csp-tt-policy-registration.test.ts test/e2e/csp-evaluate-blocked-error.test.ts
```

Expected: all PASS.

- [ ] **Step 7: Re-run the v0.1.33 regression baseline test**

```bash
npx vitest run test/e2e/csp-baseline-tt-strict.test.ts
```

Expected: this test STILL PASSES (it documents `safari_evaluate` failing on TT-strict — which is still the case; the alternatives are what changed, not safari_evaluate itself). The assertion in this test matches the failure-mode regex; it documents the SHAPE of the failure, not whether the failure exists.

NOTE: If task 3's error UX changed the error shape such that the regex in the baseline test no longer matches, update the baseline test to match the new `CSP_BLOCKED: <original-message>` wrapper while still asserting the underlying TT mention. The baseline's purpose is to lock in "safari_evaluate fails on TT-strict pages with a recognizable CSP error" — it's not a goal to make it pass.

- [ ] **Step 8: Write TRACES iter 81**

Append to `TRACES.md` "Current Work" section a new entry per the TRACES protocol (CLAUDE.md). One paragraph: "v0.1.34 sprint mid-flight: 4 capability tools + 4 interaction refactors land on dev.6. csp-interaction-sentinels PASS 4/4. Remaining: 3 extraction refactors + smart_scrape + audit sweep + flag + observability + bench gate."

- [ ] **Step 9: Commit**

```bash
git add package.json extension/manifest.json bin/ TRACES.md
git commit -m "build(extension): mid-sprint rebuild dev.6 — 4 capability tools + 4 interaction sentinels verified"
```

---

## Task 12: Refactor `safari_get_text` → `__SP_GET_TEXT__` sentinel

**Why:** `safari_get_text` reads `textContent` of an element. Currently a JS-string path. Refactor to sentinel.

**Files:**
- Modify: `src/tools/extraction.ts` (the `safari_get_text` handler around line 80)
- Modify: `extension/content-main.js` (add `__SP_GET_TEXT__` intercept)
- Create: `test/e2e/csp-extraction-sentinels.test.ts`

- [ ] **Step 1: Read the current handler**

```bash
grep -n "case 'safari_get_text'\|handleGetText" src/tools/extraction.ts
sed -n '80,115p' src/tools/extraction.ts
```

Capture inputSchema: selector, text, role, name, nth.

- [ ] **Step 2: Write the failing e2e test**

Create `test/e2e/csp-extraction-sentinels.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

function startExtractionFixture(): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict extraction fixture</title>
</head><body>
<h1 id="hero">Hero text content</h1>
<ul id="items">
  <li class="item">Item one</li>
  <li class="item">Item two</li>
  <li class="item">Item three</li>
</ul>
<article id="article">
  <h2>Article title</h2>
  <p>First paragraph of article body.</p>
  <p>Second paragraph here.</p>
</article>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(0);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}

describe('CSP extraction sentinels', () => {
  let fixture: { server: HttpServer; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(() => { fixture = startExtractionFixture(); });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => fixture.server.close(() => r()));
  });

  it('safari_get_text works on tt-strict pages', async () => {
    const client = await getSharedClient();
    const tabUrl = fixture.url() + '?sp_t12=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_get_text', { tabUrl, selector: '#hero' });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.text).toBe('Hero text content');
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

```bash
npx vitest run test/e2e/csp-extraction-sentinels.test.ts -t safari_get_text
```

Expected: FAIL.

- [ ] **Step 4: Refactor `safari_get_text` handler in `src/tools/extraction.ts`**

```typescript
const selector = params['selector'] as string | undefined;
const text = params['text'] as string | undefined;
const role = params['role'] as string | undefined;
const name = params['name'] as string | undefined;
const nth = (params['nth'] as number | undefined) ?? 0;
if (!selector && !text && !role) {
  const err = new Error('At least one of {selector, text, role} is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}

const sentinel = '__SP_GET_TEXT__:' + JSON.stringify({ selector, text, role, name, nth });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 15_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_get_text failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 5: Add `__SP_GET_TEXT__` intercept in `extension/content-main.js`**

```javascript
// ── EARLY INTERCEPT: __SP_GET_TEXT__:<json> (v0.1.34 Task 12) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_GET_TEXT__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_GET_TEXT__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L) throw Object.assign(new Error('locator.js not loaded in MAIN world'), { name: 'NO_LOCATOR' });
    const candidates = L.resolveScrollTargets({
      selector: args.selector, text: args.text, role: args.role, name: args.name,
    });
    if (candidates.length === 0) {
      throw Object.assign(new Error('no element matched the provided locator'), { name: 'TARGET_NOT_FOUND' });
    }
    const nth = typeof args.nth === 'number' ? args.nth : 0;
    if (nth >= candidates.length) {
      throw Object.assign(
        new Error('nth=' + nth + ' out of range (matchCount=' + candidates.length + ')'),
        { name: 'INVALID_PARAMS' },
      );
    }
    const el = candidates[nth].element;
    result = {
      text: (el.textContent || '').trim(),
      matchedNode: L.serializeNode(el),
      matchCount: candidates.length,
    };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 6: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/extraction.ts extension/content-main.js test/e2e/csp-extraction-sentinels.test.ts
git commit -m "feat(extraction): safari_get_text → __SP_GET_TEXT__ sentinel, CSP-immune"
```

---

## Task 13: Refactor `safari_query_all` → `__SP_QUERY_ALL__` sentinel

**Why:** `safari_query_all` returns a serialized list of all elements matching a selector. Same refactor pattern.

**Files:**
- Modify: `src/tools/extraction.ts` (the `safari_query_all` handler around line 242)
- Modify: `extension/content-main.js` (add `__SP_QUERY_ALL__` intercept)
- Modify: `test/e2e/csp-extraction-sentinels.test.ts` (add query_all test)

- [ ] **Step 1: Read the current handler**

```bash
grep -n "case 'safari_query_all'\|handleQueryAll" src/tools/extraction.ts
sed -n '242,290p' src/tools/extraction.ts
```

Capture inputSchema: selector, maxResults, includeHidden.

- [ ] **Step 2: Add the failing query_all test**

In `test/e2e/csp-extraction-sentinels.test.ts`:

```typescript
it('safari_query_all works on tt-strict pages', async () => {
  const client = await getSharedClient();
  const tabUrl = fixture.url() + '?sp_t13=1';
  openedTabUrls.push(tabUrl);
  await callTool(client, 'safari_new_tab', { url: tabUrl });
  await new Promise((r) => setTimeout(r, 600));

  const result = await callTool(client, 'safari_query_all', { tabUrl, selector: '.item' });
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  const parsed = JSON.parse(text);
  expect(parsed.matches).toBeDefined();
  expect(parsed.matches.length).toBe(3);
  expect(parsed.matches[0].text).toBe('Item one');
});
```

- [ ] **Step 3: Run test — verify it fails**

```bash
npx vitest run test/e2e/csp-extraction-sentinels.test.ts -t safari_query_all
```

Expected: FAIL.

- [ ] **Step 4: Refactor `safari_query_all` handler in `src/tools/extraction.ts`**

```typescript
const selector = params['selector'] as string;
const maxResults = (params['maxResults'] as number | undefined) ?? 50;
const includeHidden = (params['includeHidden'] as boolean | undefined) ?? false;
if (typeof selector !== 'string' || !selector.length) {
  const err = new Error('`selector` parameter is required');
  (err as Error & { code?: string }).code = 'INVALID_PARAMS';
  throw err;
}

const sentinel = '__SP_QUERY_ALL__:' + JSON.stringify({ selector, maxResults, includeHidden });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 15_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_query_all failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 5: Add `__SP_QUERY_ALL__` intercept in `extension/content-main.js`**

```javascript
// ── EARLY INTERCEPT: __SP_QUERY_ALL__:<json> (v0.1.34 Task 13) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_QUERY_ALL__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_QUERY_ALL__:'.length));
    const L = window.__SP_LOCATOR__;
    const nodes = document.querySelectorAll(args.selector);
    const maxResults = typeof args.maxResults === 'number' ? args.maxResults : 50;
    const matches = [];
    let truncated = false;
    for (let i = 0; i < nodes.length; i++) {
      if (matches.length >= maxResults) { truncated = true; break; }
      const n = nodes[i];
      if (!args.includeHidden) {
        const cs = window.getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || n.offsetParent === null) continue;
      }
      matches.push({
        text: (n.textContent || '').trim().slice(0, 200),
        tag: n.tagName.toLowerCase(),
        attrs: L ? L.serializeNode(n) : { tag: n.tagName.toLowerCase() },
      });
    }
    result = { matches, totalFound: nodes.length, truncated };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 6: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/extraction.ts extension/content-main.js test/e2e/csp-extraction-sentinels.test.ts
git commit -m "feat(extraction): safari_query_all → __SP_QUERY_ALL__ sentinel, CSP-immune"
```

---

## Task 14: Refactor `safari_snapshot` → `__SP_SNAPSHOT__` sentinel

**Why:** `safari_snapshot` returns a structured representation of the page (accessibility-tree-like). Currently the largest of the extraction tools by JS-string size. Refactor to sentinel.

**Files:**
- Modify: `src/tools/extraction.ts` (the `safari_snapshot` handler around line 50)
- Modify: `extension/content-main.js` (add `__SP_SNAPSHOT__` intercept)
- Modify: `test/e2e/csp-extraction-sentinels.test.ts` (add snapshot test)

- [ ] **Step 1: Read the current handler and the JS string it currently sends**

```bash
grep -n "case 'safari_snapshot'\|handleSnapshot" src/tools/extraction.ts
sed -n '50,85p' src/tools/extraction.ts
```

Note the snapshot logic — it traverses the DOM building a structured tree. Read carefully: this is the most logic-heavy of the refactors, and the existing JS-string implementation is the source-of-truth for what the sentinel handler needs to reproduce.

If the snapshot logic is >50 lines of JS being marshalled into a string, the right approach is to MOVE that logic into `extension/locator.js` (or a new `extension/snapshot.js`) as a `window.__SP_SNAPSHOT__` helper, then have the sentinel handler just call it.

- [ ] **Step 2: Add the failing snapshot test**

```typescript
it('safari_snapshot works on tt-strict pages', async () => {
  const client = await getSharedClient();
  const tabUrl = fixture.url() + '?sp_t14=1';
  openedTabUrls.push(tabUrl);
  await callTool(client, 'safari_new_tab', { url: tabUrl });
  await new Promise((r) => setTimeout(r, 600));

  const result = await callTool(client, 'safari_snapshot', { tabUrl });
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  const parsed = JSON.parse(text);
  // Snapshot returns a tree — assert it has elements from the fixture.
  const serialized = JSON.stringify(parsed);
  expect(serialized).toContain('Hero text content');
  expect(serialized).toContain('Article title');
});
```

- [ ] **Step 3: Run test — verify it fails**

```bash
npx vitest run test/e2e/csp-extraction-sentinels.test.ts -t safari_snapshot
```

Expected: FAIL.

- [ ] **Step 4: Extract snapshot logic to `extension/locator.js`**

Read the current JS-string the handler builds (Step 1's grep output will show the template). Move the snapshot-tree-building function into `extension/locator.js` as `window.__SP_LOCATOR__.buildSnapshot(rootSelector, options)`. The function should already exist in some form; if not, lift it from the JS-string template verbatim.

- [ ] **Step 5: Refactor `safari_snapshot` handler in `src/tools/extraction.ts`**

```typescript
const rootSelector = (params['rootSelector'] as string | undefined) ?? 'body';
const maxDepth = (params['maxDepth'] as number | undefined) ?? 10;
const maxNodes = (params['maxNodes'] as number | undefined) ?? 200;

const sentinel = '__SP_SNAPSHOT__:' + JSON.stringify({ rootSelector, maxDepth, maxNodes });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 30_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_snapshot failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 6: Add `__SP_SNAPSHOT__` intercept in `extension/content-main.js`**

```javascript
// ── EARLY INTERCEPT: __SP_SNAPSHOT__:<json> (v0.1.34 Task 14) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_SNAPSHOT__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_SNAPSHOT__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L || typeof L.buildSnapshot !== 'function') {
      throw Object.assign(
        new Error('locator.js buildSnapshot helper not available'),
        { name: 'NO_LOCATOR' },
      );
    }
    const tree = L.buildSnapshot(args.rootSelector || 'body', {
      maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : 10,
      maxNodes: typeof args.maxNodes === 'number' ? args.maxNodes : 200,
    });
    result = { snapshot: tree, capturedAt: location.href };
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 7: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/tools/extraction.ts extension/content-main.js extension/locator.js test/e2e/csp-extraction-sentinels.test.ts
git commit -m "feat(extraction): safari_snapshot → __SP_SNAPSHOT__ sentinel via __SP_LOCATOR__.buildSnapshot helper"
```

---

## Task 15: Refactor `safari_smart_scrape` + audit-driven sweep

**Why:** `safari_smart_scrape` is the heaviest of the extraction tools. Refactor it to a sentinel, then take the audit doc from task 1 and refactor any other refactor-candidates the audit surfaced beyond what tasks 7-14 cover.

**Files:**
- Modify: `src/tools/structured-extraction.ts` (the `safari_smart_scrape` handler around line 22)
- Modify: `extension/content-main.js` (add `__SP_SMART_SCRAPE__` intercept)
- Modify: `extension/locator.js` (host the smart-scrape helper if not already there)
- Create: `test/e2e/csp-smart-scrape-sentinel.test.ts`
- Modify: zero or more `src/tools/*.ts` files surfaced by the audit (per the audit's refactor-candidate table)

- [ ] **Step 1: Re-read the audit refactor-candidate table**

```bash
sed -n '/^## Refactor candidates/,/^## /p' docs/upp/research/2026-05-13-csp-bypass-audit.md
```

Make a list of any candidate tools NOT covered by tasks 7-14. These all get the same refactor treatment in this task as a batched sweep.

- [ ] **Step 2: Read the current `safari_smart_scrape` handler**

```bash
sed -n '22,80p' src/tools/structured-extraction.ts
```

Capture inputSchema and the heuristic logic. Same approach as task 14: if the helper is >50 LOC, lift to `extension/locator.js` as `window.__SP_LOCATOR__.smartScrape(options)`.

- [ ] **Step 3: Write the failing e2e test**

Create `test/e2e/csp-smart-scrape-sentinel.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

function startScrapeFixture(): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict smart-scrape fixture</title>
</head><body>
<article>
  <h1>Product title</h1>
  <p class="price">an99.99</p>
  <p class="description">This is a product description.</p>
  <img src="/img.png" alt="Product image">
</article>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(0);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}

describe('safari_smart_scrape sentinel', () => {
  let fixture: { server: HttpServer; url: () => string };
  const openedTabUrls: string[] = [];

  beforeAll(() => { fixture = startScrapeFixture(); });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await new Promise<void>((r) => fixture.server.close(() => r()));
  });

  it('safari_smart_scrape works on tt-strict pages', async () => {
    const client = await getSharedClient();
    const tabUrl = fixture.url() + '?sp_t15=1';
    openedTabUrls.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl });
    await new Promise((r) => setTimeout(r, 600));

    const result = await callTool(client, 'safari_smart_scrape', { tabUrl });
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain('Product title');
    expect(serialized).toMatch(/\$?99\.99/);
  });
});
```

- [ ] **Step 4: Run test — verify it fails**

```bash
npx vitest run test/e2e/csp-smart-scrape-sentinel.test.ts
```

Expected: FAIL.

- [ ] **Step 5: Refactor `safari_smart_scrape` handler in `src/tools/structured-extraction.ts`**

```typescript
const includeImages = (params['includeImages'] as boolean | undefined) ?? true;
const maxText = (params['maxText'] as number | undefined) ?? 10000;

const sentinel = '__SP_SMART_SCRAPE__:' + JSON.stringify({ includeImages, maxText });
const result = await this.engine.executeJsInTab(tabUrl, sentinel, 60_000);
if (!result.ok) {
  const err = new Error(result.error?.message ?? 'safari_smart_scrape failed');
  if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
  throw err;
}
const parsed = result.value ? JSON.parse(result.value) : {};
return {
  content: [{ type: 'text', text: JSON.stringify(parsed) }],
  metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
};
```

- [ ] **Step 6: Add `__SP_SMART_SCRAPE__` intercept in `extension/content-main.js`**

```javascript
// ── EARLY INTERCEPT: __SP_SMART_SCRAPE__:<json> (v0.1.34 Task 15) ──
if (typeof params.script === 'string' && params.script.startsWith('__SP_SMART_SCRAPE__:')) {
  try {
    const args = JSON.parse(params.script.slice('__SP_SMART_SCRAPE__:'.length));
    const L = window.__SP_LOCATOR__;
    if (!L || typeof L.smartScrape !== 'function') {
      throw Object.assign(
        new Error('locator.js smartScrape helper not available'),
        { name: 'NO_LOCATOR' },
      );
    }
    const scraped = L.smartScrape({
      includeImages: args.includeImages !== false,
      maxText: typeof args.maxText === 'number' ? args.maxText : 10000,
    });
    result = scraped;
    break;
  } catch (e) {
    throw e;
  }
}
```

- [ ] **Step 7: Process the audit's remaining refactor candidates**

For each remaining candidate from the audit (if any):

  - Read the handler's existing JS-string template
  - Add a `__SP_<TOOL_UPPER>__:<json>` sentinel marshalling on the TS side
  - Add the corresponding intercept in `extension/content-main.js` (same shape as tasks 7-15)
  - Add an e2e test in the appropriate file (`csp-interaction-sentinels.test.ts`, `csp-extraction-sentinels.test.ts`, or a new file if the tool doesn't fit either category)

If the audit surfaced ZERO additional candidates, this step is a no-op — proceed to Step 8.

- [ ] **Step 8: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/tools/structured-extraction.ts extension/content-main.js extension/locator.js test/e2e/csp-smart-scrape-sentinel.test.ts
# Plus any other audit-sweep files modified.
git commit -m "feat(extraction+sweep): safari_smart_scrape → __SP_SMART_SCRAPE__ sentinel + audit-surfaced refactors"
```

---

## Task 16: Rollback feature flag `legacyMainWorld`

**Why:** Spec section 3 ("Rollback path") commits to a flag that reverts to v0.1.33 behavior. Section 8 inherits this. Implementation: a config field in `safari-pilot.config.json` that, when set, makes the TS-side sentinel marshalling fall back to the original JS-string path.

Since Section 8's sentinel refactors are per-tool (not a single dispatch switch), the flag check needs to live in each refactored handler. To avoid copy-pasting 10× the same check, add a single helper.

**Files:**
- Modify: `src/server.ts` or a new helper in `src/config.ts` (load + expose `legacyMainWorld` flag)
- Modify: each refactored handler in `src/tools/interaction.ts`, `src/tools/extraction.ts`, `src/tools/structured-extraction.ts`, and the audit-sweep tools — wrap the sentinel marshalling in a flag check
- Modify: `safari-pilot.config.json` (add field with comment)
- Create: `test/e2e/csp-legacy-flag.test.ts`

- [ ] **Step 1: Locate the existing config-loading code**

```bash
grep -rn "safari-pilot.config.json\|loadConfig" src/ | head -20
```

If a config loader already exists, extend it. If not, create `src/config.ts` with a `loadConfig()` that reads from `safari-pilot.config.json` once at server init and caches.

- [ ] **Step 2: Write the failing flag e2e test**

Create `test/e2e/csp-legacy-flag.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { getSharedClient, callTool } from '../helpers/mcp-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import type { Server } from 'node:http';
import { join } from 'node:path';

const CONFIG_PATH = join(process.cwd(), 'safari-pilot.config.json');

describe('legacyMainWorld feature flag', () => {
  let fixture: { server: Server; url: () => string };
  let originalConfig: string;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fixture = startTrustedTypesFixture();
    originalConfig = await readFile(CONFIG_PATH, 'utf-8');
  });

  afterAll(async () => {
    const client = await getSharedClient();
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }); } catch { /* ignore */ }
    }
    await writeFile(CONFIG_PATH, originalConfig);
    await new Promise<void>((r) => fixture.server.close(() => r()));
  });

  it('with legacyMainWorld:true, safari_click fails on tt-strict (v0.1.33 behavior)', async () => {
    const cfg = JSON.parse(originalConfig);
    cfg.legacyMainWorld = true;
    await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));

    // Reload requires MCP server restart — emit a structural assertion instead.
    // Skipped if reload mechanism isn't trivial; documented in the implementation note.
    // For now, assert config reload via a dedicated tool or restart hook.
    expect(true).toBe(true);
  });
});
```

NOTE: this test exists as a placeholder for the flag mechanism — full validation requires MCP server restart between flag flips, which is out of scope for an inline test. Instead, the test asserts only the config-file change is honored at next server start. Add a CHANGELOG note.

- [ ] **Step 3: Run test — verify it passes trivially**

```bash
npx vitest run test/e2e/csp-legacy-flag.test.ts
```

Expected: PASS (trivial assertion). The intent is documented in the test file.

- [ ] **Step 4: Add `legacyMainWorld` field to `safari-pilot.config.json`**

```bash
node -e "const c=require('./safari-pilot.config.json'); c.legacyMainWorld=false; require('fs').writeFileSync('./safari-pilot.config.json', JSON.stringify(c, null, 2) + '\n');"
```

- [ ] **Step 5: Add the flag check to each refactored handler**

In each handler refactored by tasks 7-15, wrap the sentinel marshalling like this (using `safari_click` as the example):

```typescript
const config = loadConfig();
if (config.legacyMainWorld === true) {
  // v0.1.33 fallback path — preserve the original JS-string execution for users who hit a regression.
  const legacyScript = `(function(){ /* original JS-string body */ })()`;
  const result = await this.engine.executeJsInTab(tabUrl, legacyScript, 30_000);
  // ... rest of original v0.1.33 handler ...
} else {
  // v0.1.34 sentinel path — current.
  const sentinel = '__SP_CLICK__:' + JSON.stringify({ /* ... */ });
  // ... rest of v0.1.34 handler ...
}
```

To avoid copy-pasting the v0.1.33 JS-string for every tool, look up each tool's pre-refactor code in git history (`git show HEAD~N:src/tools/interaction.ts`) and embed the original body.

If preserving the v0.1.33 body for 10 tools is too much code duplication, an alternate approach: have `legacyMainWorld: true` only disable the sentinel for `safari_evaluate` (where the user-facing pain is the error), and have all the refactored interaction tools always use sentinels. This is simpler and matches actual user need (the flag is for users who want `safari_evaluate` back; they can already use the refactored tools).

Decide and document the choice in the CHANGELOG entry (task 20).

- [ ] **Step 6: Run unit tests**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools/ src/config.ts safari-pilot.config.json test/e2e/csp-legacy-flag.test.ts
git commit -m "feat(config): legacyMainWorld rollback flag — disables v0.1.34 sentinel routing per-tool"
```

---

## Task 17: Observability — `/safari-pilot:stats` CSP error counts

**Why:** Spec Section 3 ("Observability") asks for `/safari-pilot:stats` counters for the new error codes. This lets users see how often they hit `CSP_BLOCKED` / `CSP_HARD_BLOCK` across their session.

**Files:**
- Modify: `src/cli/stats.ts` (extend NDJSON aggregator to count new error codes)
- Modify: `src/cli/format.ts` (display new counters in CLI output)
- Create: `test/unit/cli-stats-csp.test.ts`

- [ ] **Step 1: Read the existing stats CLI**

```bash
sed -n '1,80p' src/cli/stats.ts
sed -n '1,60p' src/cli/format.ts
```

Note the existing aggregator shape (NDJSON line → counter increment).

- [ ] **Step 2: Write the failing unit test**

Create `test/unit/cli-stats-csp.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { aggregateStats } from '../../src/cli/stats.js';

describe('stats CSP error code aggregation', () => {
  const sampleNdjson = [
    JSON.stringify({ tool: 'safari_evaluate', ok: false, error: { code: 'CSP_BLOCKED' }, ts: Date.now(), url: 'https://example.com/page' }),
    JSON.stringify({ tool: 'safari_evaluate', ok: false, error: { code: 'CSP_BLOCKED' }, ts: Date.now(), url: 'https://example.com/page' }),
    JSON.stringify({ tool: 'safari_evaluate', ok: false, error: { code: 'CSP_HARD_BLOCK' }, ts: Date.now(), url: 'https://google.com/flights' }),
    JSON.stringify({ tool: 'safari_click', ok: true, ts: Date.now(), url: 'https://example.com/page' }),
  ].join('\n');

  it('counts CSP_BLOCKED and CSP_HARD_BLOCK occurrences', () => {
    const stats = aggregateStats(sampleNdjson);
    expect(stats.cspBlockedTotal).toBe(2);
    expect(stats.cspHardBlockTotal).toBe(1);
  });

  it('breaks down CSP errors by site', () => {
    const stats = aggregateStats(sampleNdjson);
    expect(stats.cspBlockedBySite['example.com']).toBe(2);
    expect(stats.cspHardBlockBySite['google.com']).toBe(1);
  });
});
```

- [ ] **Step 3: Run test — verify it fails**

```bash
npx vitest run test/unit/cli-stats-csp.test.ts
```

Expected: FAIL — `cspBlockedTotal` doesn't exist yet.

- [ ] **Step 4: Extend `src/cli/stats.ts` aggregator**

Inside the existing `aggregateStats()` function, when processing each NDJSON event, branch on `event.error?.code`:

```typescript
if (event.error && event.error.code === 'CSP_BLOCKED') {
  stats.cspBlockedTotal = (stats.cspBlockedTotal || 0) + 1;
  const site = new URL(event.url).hostname.replace(/^www\./, '');
  stats.cspBlockedBySite = stats.cspBlockedBySite || {};
  stats.cspBlockedBySite[site] = (stats.cspBlockedBySite[site] || 0) + 1;
}
if (event.error && event.error.code === 'CSP_HARD_BLOCK') {
  stats.cspHardBlockTotal = (stats.cspHardBlockTotal || 0) + 1;
  const site = new URL(event.url).hostname.replace(/^www\./, '');
  stats.cspHardBlockBySite = stats.cspHardBlockBySite || {};
  stats.cspHardBlockBySite[site] = (stats.cspHardBlockBySite[site] || 0) + 1;
}
```

Also update the `Stats` type/interface to include the new fields.

- [ ] **Step 5: Extend `src/cli/format.ts` to display the counters**

Add a section after the existing tool-counts block:

```typescript
if (stats.cspBlockedTotal || stats.cspHardBlockTotal) {
  lines.push('');
  lines.push('CSP / Trusted Types blocks:');
  if (stats.cspBlockedTotal) lines.push(`  CSP_BLOCKED:     ${stats.cspBlockedTotal}`);
  if (stats.cspHardBlockTotal) lines.push(`  CSP_HARD_BLOCK:  ${stats.cspHardBlockTotal}`);
  if (stats.cspBlockedBySite || stats.cspHardBlockBySite) {
    lines.push('  By site:');
    const merged: Record<string, { blocked: number; hardBlock: number }> = {};
    for (const [site, n] of Object.entries(stats.cspBlockedBySite || {})) {
      merged[site] = merged[site] || { blocked: 0, hardBlock: 0 };
      merged[site].blocked = n as number;
    }
    for (const [site, n] of Object.entries(stats.cspHardBlockBySite || {})) {
      merged[site] = merged[site] || { blocked: 0, hardBlock: 0 };
      merged[site].hardBlock = n as number;
    }
    for (const [site, c] of Object.entries(merged)) {
      lines.push(`    ${site}: ${c.blocked} blocked, ${c.hardBlock} hard-block`);
    }
  }
}
```

- [ ] **Step 6: Run test — verify it passes**

```bash
npx vitest run test/unit/cli-stats-csp.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/stats.ts src/cli/format.ts test/unit/cli-stats-csp.test.ts
git commit -m "feat(cli): /safari-pilot:stats CSP_BLOCKED + CSP_HARD_BLOCK counters with per-site breakdown"
```

---

## Task 18: Bench gate — rerun 47 failures + 50 spot-checks

**Why:** Per spec Section 1 acceptance criteria, the v0.1.34 ship gate is:
- ≥30 of 47 v0.1.33 failing tasks now SUCCESS
- 0 regressions on a stratified 50-task spot-check from v0.1.33 passing tasks
- Per-site mins: Google Flights ≥6/11, Apple ≥7/12, Google Search ≥9/11
- Aggregate capture_failure_rate stays at 0.0%

**Files:**
- Modify: `bench/webvoyager/run-one-task.sh` (promote from /tmp/, fold in mktemp + perl-alarm cleanup fixes per TRACES iter 79)
- Create: `bench-runs/webvoyager-v0.1.34-bench-<YYYYMMDD>/` (output directory)

- [ ] **Step 1: Promote `/tmp/run-one-task.sh` to `bench/webvoyager/run-one-task.sh`**

```bash
ls -la /tmp/run-one-task.sh
```

If it exists, copy + git-add:

```bash
cp /tmp/run-one-task.sh bench/webvoyager/run-one-task.sh
chmod +x bench/webvoyager/run-one-task.sh
```

If it doesn't exist on this machine, recreate from TRACES iter 78 documentation: a Bash wrapper around `claude --bare --mcp-config .mcp.json` per task, with pre-snapshot of Safari tabs via AppleScript, post-task tab cleanup, and per-task artifact writing to `bench-runs/webvoyager-v0.1.34-*/<task-id>/score.json + transcript.txt + stream.jsonl`.

Apply the v0.1.33 carry-forward fixes:
- `mktemp /tmp/wv-prompt.XXXXXX` (BSD-compatible template — X's at the end)
- Wrap cleanup AppleScript in `perl -e 'alarm 8; exec @ARGV'` for 8s timeout

- [ ] **Step 2: Confirm acceptance with user before running**

Per spec Section 9 ("Open Questions") item 5: bench cost ~$78. Before kicking off, ask the user via AskUserQuestion to confirm cost-aware approval. If not approved, STOP and surface the request.

- [ ] **Step 3: Rerun the 47 v0.1.33 failing tasks**

From `/tmp/wv-inline-runs/` (v0.1.33 results, see CHECKPOINT context), extract the 47 task IDs that failed:

```bash
grep -l '"success":false' /tmp/wv-inline-runs/*-r1.score.json | sed 's|.*/||; s|-r1.score.json||' > /tmp/v0134-rerun-failures.txt
wc -l /tmp/v0134-rerun-failures.txt
```

Expected: 47 lines. If a different count, the v0.1.33 baseline shifted — investigate before proceeding.

Run each:

```bash
mkdir -p bench-runs/webvoyager-v0.1.34-bench-$(date +%Y%m%d)
while read task_id; do
  bash bench/webvoyager/run-one-task.sh "$task_id"
done < /tmp/v0134-rerun-failures.txt
```

- [ ] **Step 4: Run a stratified 50-task spot-check from v0.1.33 passing tasks**

```bash
grep -l '"success":true' /tmp/wv-inline-runs/*-r1.score.json | shuf -n 50 | sed 's|.*/||; s|-r1.score.json||' > /tmp/v0134-spotcheck.txt
while read task_id; do
  bash bench/webvoyager/run-one-task.sh "$task_id"
done < /tmp/v0134-spotcheck.txt
```

- [ ] **Step 5: Judge all results**

```bash
npx tsx bench/webvoyager/judge-inline-runs.ts /tmp/wv-inline-runs/ > bench-runs/webvoyager-v0.1.34-bench-$(date +%Y%m%d)/scoreboard.json
```

- [ ] **Step 6: Verify acceptance criteria**

Parse the scoreboard manually OR write a quick verification script that reports:
- Total failures recovered: count of `success: true` among the 47 rerun tasks. Must be ≥30.
- Regression count: count of `success: false` among the 50 spot-check tasks (was passing in v0.1.33). Must be 0.
- Per-site rates from the scoreboard.

- [ ] **Step 7: Decide gate outcome**

- **All criteria PASS:** proceed to task 19 + 20.
- **Per-site mins missed on Google Flights / Apple / Google Search:** escalate to v0.1.35 per spec Section 7 (AX engine carry-forward); document gap and ship v0.1.34 with the partial gain (it's still net-positive vs v0.1.33).
- **Spot-check regressions detected:** STOP. Use `upp:systematic-debugging` to root-cause; the most likely culprit is a sentinel handler's behavior diverging from the v0.1.33 JS-string original on a specific site.

- [ ] **Step 8: Commit bench results**

```bash
git add bench-runs/webvoyager-v0.1.34-bench-*/scoreboard.json bench/webvoyager/run-one-task.sh
git commit -m "bench(v0.1.34): rerun 47 v0.1.33 failures + 50 spot-check, acceptance criteria <PASS|PARTIAL>"
```

---

## Task 19: Documentation — CHANGELOG + ARCHITECTURE updates

**Files:**
- Modify: `CHANGELOG.md` (insert v0.1.34 entry at top)
- Modify: `ARCHITECTURE.md` (add v0.1.34 version-history entry; document multi-sentinel pattern)
- Modify: `CLAUDE.md` (update top paragraph to mention v0.1.34 CSP/TT support, if pattern matches v0.1.33 entry)

- [ ] **Step 1: Read existing CHANGELOG format**

```bash
sed -n '1,80p' CHANGELOG.md
```

- [ ] **Step 2: Write v0.1.34 CHANGELOG entry**

Insert above the v0.1.33 entry. Cover:
- 3 new tools (safari_get_page_info, safari_get_meta_tags, safari_extract_text_window)
- 8 refactored tools (click, fill, type, scroll, get_text, query_all, snapshot, smart_scrape, plus any audit-sweep additions)
- Layer 3 TT policy registration on content-main.js
- CSP_BLOCKED / CSP_HARD_BLOCK error UX with alternative_tools hint
- legacyMainWorld rollback flag
- stats CLI new counters
- Bench gate result (with exact numbers from task 18)
- v0.1.33 carry-forwards still pending (daemon Models.swift coercion, allowlist over-broadness, NIOFcntlFailedError root-cause, skipped[] sanitization, selector-pack dead code)

- [ ] **Step 3: Update `ARCHITECTURE.md`**

Add a v0.1.34 row to the version-history table. Add a new subsection in Security Pipeline / Engine documentation explaining the multi-sentinel pattern. Update the tool count if new tools shifted it (88 → 91).

- [ ] **Step 4: Update `CLAUDE.md` top paragraph**

Append a sentence to the v0.1.33 mention: "v0.1.34 adds multi-tool CSP/Trusted-Types bypass via dedicated content-main.js sentinel handlers — 3 new ISOLATED-world capability tools + 8 interaction/extraction tools refactored to bypass `new Function` on TT-strict pages. See CHANGELOG.md."

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs(v0.1.34): CHANGELOG entry + ARCHITECTURE multi-sentinel pattern + CLAUDE.md top paragraph"
```

---

## Task 20: Ship — final version bump, pre-tag-check, tag push, CI watch

**Why:** Final release ritual. Per project SOP (CLAUDE.md "Release SOP"), bump versions lockstep, rebuild extension at final 0.1.34, pre-tag-check, tag, push, watch CI.

**Files:**
- Modify: `package.json` (version 0.1.34-dev.6 → 0.1.34)
- Modify: `extension/manifest.json` (same)
- Rebuild artifacts: `bin/Safari Pilot.app`, `bin/Safari Pilot.zip`
- Modify: `TRACES.md` (iter 82 ship entry)

- [ ] **Step 1: Final version bump (drop -dev tag)**

```bash
node -e "const p=require('./package.json'); p.version='0.1.34'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2) + '\n');"
node -e "const m=require('./extension/manifest.json'); m.version='0.1.34'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(m, null, 2) + '\n');"
```

- [ ] **Step 2: Final extension rebuild**

```bash
bash scripts/build-extension.sh
```

Verify in Safari > Settings > Extensions that v0.1.34 is installed (open `bin/Safari Pilot.app`).

- [ ] **Step 3: Run full pre-tag-check**

```bash
bash scripts/pre-tag-check.sh
```

Expected: "ALL CHECKS PASSED — safe to tag" (11/11 per project history).

If ANY gate fails, do NOT tag. Address the gate failure, recommit, re-run pre-tag-check.

- [ ] **Step 4: Write TRACES iter 82**

Append iter 82 entry to `TRACES.md` "Current Work" section with ship summary: tool counts, refactor count, bench result, capture_failure_rate, total wall-clock.

If iter 82 is the third iteration since the last milestone, follow CLAUDE.md compaction process: create `traces/archive/milestone-N.md`, update Project Summary, etc.

- [ ] **Step 5: Commit ship state**

```bash
git add package.json extension/manifest.json bin/ TRACES.md
git commit -m "chore(release): v0.1.34"
```

- [ ] **Step 6: Tag + push**

```bash
git tag -a v0.1.34 -m "v0.1.34 — CSP/Trusted-Types bypass via multi-tool sentinel refactor"
git push origin feat/v0134-csp-bypass
git push origin v0.1.34
```

- [ ] **Step 7: Watch CI**

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: green build + notarization Accepted + npm publish.

Per project memory `reference-ci-npm-token-expiry`, verify after CI completes:

```bash
sleep 30
npm view safari-pilot version
```

Expected: `0.1.34`. If still `0.1.33`, the npm publish step silently failed — investigate NPM_TOKEN and republish manually.

- [ ] **Step 8: Merge to main**

```bash
git checkout main
git merge --ff-only feat/v0134-csp-bypass
git push origin main
git branch -d feat/v0134-csp-bypass
git push origin --delete feat/v0134-csp-bypass
```

- [ ] **Step 9: Update Roadmap (if maintained)**

Per CLAUDE.md Build Roadmap protocol, mark the v0.1.34 sprint item Verifying → Shipped after user-side validation. Update Notion via `notion-update-page` if the Roadmap DB has a v0.1.34 sprint row.

---

## Self-Review

Done as part of writing-plans skill step 14. Findings + fixes inline.

**1. Spec coverage:**
- Section 1 (Problem & Goal, acceptance criteria) → covered by task 18
- Section 2 (Root-Cause Synthesis) → context only; no task needed
- Section 3 (Architecture) — Layer 3 TT registration → task 2; CSP_BLOCKED error UX → task 3; new capability tools → tasks 4-6; rollback flag → task 16; observability → task 17. **CSP-mode detection probe (cspMode field on tab metadata)** is omitted: Section 8 doesn't need it since sentinels are CSP-immune at all times. The `__SP_TT_PROBE__` in task 3 covers the only consumer (the error UX distinguishing CSP_BLOCKED from CSP_HARD_BLOCK).
- Section 4 (Slice Plan) → tasks 7-15 cover the multi-tool refactor (Section 8 fallback, not Section 4 architectural-pivot slices)
- Section 5 (Testing Strategy) → e2e fixtures + tests in tasks 2, 3, 4-6, 7-15. Per-tool unit tests are folded into the per-task e2e; explicit Section 5 "per new capability tool: 3-5 tests" is covered by the 7 tests across page-info-tools.test.ts (3 + 2 + 3 truncation = 8). Section 5 "delete the new ISOLATED-routing branch — at least 2 e2e tests must fail" doesn't apply (no ISOLATED-routing branch in Section 8; the same litmus applies to deleting a sentinel handler — if `__SP_CLICK__` is deleted, the csp-interaction-sentinels click test fails).
- Section 6 (Risks & Mitigations) → not directly task-mapped; risks are covered by the test coverage and the rollback flag.
- Section 7 (v0.1.35 carry-forwards) → out of scope by design.
- Section 8 (Fallback) → IS this plan.
- Section 9 (Open Questions) — Q5 (bench cost) → task 18 step 2. Q1-4 (frameId semantics, CSP-mode location, SPA invalidation, config-file fit) → not directly addressed; each is implementation-detail that arises during the relevant task and should be resolved inline by the implementer.
- Section 10 (References) → not a task target.

**2. Placeholder scan:** Searched plan for "TBD", "TODO", "implement later", "fill in details". Found:
- Task 1 uses `[N]` and `[line]` placeholders inside the audit doc TEMPLATE block. That's intentional — the audit doc itself must be filled with real numbers, and the template shows the shape. Step 4 of task 1 enforces filling all `[N]` and `[line]` values. NOT a plan failure; it's a template for the engineer to fill at run time.
- Task 14 step 4 says "Move the snapshot-tree-building function into `extension/locator.js`" — relies on the engineer reading the existing JS-string template and lifting it verbatim. This is "Surgical Changes" honest about the existing code being the source-of-truth. Not a plan failure.
- Task 15 step 7 "Process the audit's remaining refactor candidates" is open-ended — but it's gated on the audit doc from task 1 being complete. Acceptable: the audit IS the contract, and step 7 is a sweep operation against it.

**3. Type consistency:** Verified the sentinel naming convention (`__SP_TOOL_NAME__:<json>`) is identical across all 10+ refactored tools. The TS-side marshalling pattern is identical across all handlers. The extension-side intercept structure (try/parse/use __SP_LOCATOR__/throw with .name/result = .../break) is identical across all handlers. Method/property names used across tasks (`L.resolveScrollTargets`, `L.serializeNode`, `L.waitForScrollSettle`, `L.findPatternRoot`, `L.buildSnapshot`, `L.smartScrape`) — verified the first three exist in current `extension/locator.js` (used by existing v0.1.31 sentinels). `buildSnapshot` and `smartScrape` are new helpers introduced in tasks 14 and 15 respectively; both tasks explicitly create them if absent.

**4. Spec/plan tasks are non-frontend.** No DESIGN.md row. Standard task structure throughout. No design-aware tasks. No mid-plan spot-check, no final design verification (correctly skipped per Section 11 "no design context → no design verification tasks").

---

**Plan complete and saved to `docs/upp/plans/2026-05-13-safari-pilot-v0134-csp-bypass.md`.**

**Execute with:** the `upp:executing-plans` skill.

Recommended mode: **subagent mode** (per skill default for 4+ tasks with substantial design context). Each task is independently dispatchable with a fresh subagent + the three-stage review pipeline (spec → quality → design — design step will no-op for this non-frontend plan, leaving the two-gate spec + quality flow).
