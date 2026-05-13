# Safari Pilot v0.1.34 — CSP / Trusted-Types Bypass Sprint

*Status: design approved, plan pending. Spec written 2026-05-13.*

## 1. Problem & Goal

Safari Pilot v0.1.33 scored 128/175 = 73.1% on the canonical WebVoyager bench (run 2026-05-13). Of the 47 failures, a substantial subset on three sites failed for a single root cause: those sites enforce strict CSP (`require-trusted-types-for 'script'` OR `script-src` lacking `unsafe-eval`/`trusted-types-eval`) and our extension's JS execution path uses `new Function(params.script)` in MAIN world, which page CSP / Trusted Types refuses.

**Affected sites + v0.1.33 scores:**
- Google Flights: 3/11 (27%)
- Apple: 5/12 (42%) — specifically apple.com/shop CSP-blocked sub-pages
- Google Search--15 (X.com login flow): FAILURE

**Goal:** Make Safari Pilot's existing tool surface work on pages that enforce strict CSP / Trusted Types, *without abandoning the Safari Web Extension architecture, the user's real Safari tabs, or the single-runtime distribution model.*

**Bench acceptance criteria (v0.1.34 ship gate):**
- ≥30 of 47 v0.1.33 failing tasks now SUCCESS (≥64% recovery rate)
- 0 regressions on a stratified 50-task spot-check from the 128 v0.1.33 passing tasks (≥40% coverage to reliably detect a 5-task regression)
- Per-site minimums:
  - Google Flights: ≥6/11 (was 3/11, +3)
  - Apple: ≥7/12 (was 5/12, +2)
  - Google Search: ≥9/11 (was 7/11, +2; specifically Google Search--15 X.com login passes)
- Aggregate capture failure rate stays at 0.0% (was 0% in v0.1.33; must not regress)

**Explicit non-goals:**
- Replace `safari_evaluate` (works on 90% of sites, 384 calls in v0.1.33, 90% unique scripts — too large a refactor surface to swap)
- Add an AX (Accessibility) engine (defer to v0.1.35 if bench gate falls short)
- Support Orion, safaridriver, or any non-Safari runtime
- Fork or modify WebKit
- Cover the long tail of unique eval scripts on Booking / Amazon / Google Map (already passing — not the target)

## 2. Root-Cause Synthesis

Per the research synthesis at `docs/upp/research/2026-05-13-safari-csp-bypass-synthesis.md` (FULL synthesis, validator PASS), and the codebase audit performed during brainstorming:

The choke point is **one call site**: `extension/content-main.js:714`, where the MAIN-world dispatcher does `const fn = new _Function(params.script);` to execute JS strings passed by any of ~30+ tools (clipboard, compound, extraction, frames, interaction, network — the audit's grep output). `new Function()` invoked from MAIN world is subject to the page's CSP and Trusted Types directives; on strict-CSP pages, it throws.

The W3C Trusted Types specification (cited in research synthesis Section 3, claim C1) and Apple Developer Forums thread 651542 both confirm: **content scripts running in ISOLATED world are exempt from the page's CSP, including Trusted Types.** This applies to Safari's Web Extension implementation per Apple Frameworks Engineer.

**Therefore:** the `new Function(params.script)` dispatcher gets **duplicated** into content-isolated.js (not moved — duplicated). `cspMode === 'open'` keeps the v0.1.33 MAIN path unchanged; `cspMode !== 'open'` routes through the ISOLATED-world copy. Same string-eval surface succeeds on strict-CSP pages — without changing any individual tool's code, and without touching the MAIN-world hot path for the 12/15 sites where it already works.

This is the design pivot revealed in brainstorming's engineering-leader review. The original Layer-1 design was a multi-tool refactor (~6-9 days); the audit revealed a single-call-site duplication (~1-2 days) with the same functional outcome.

**Verification gate:** Slice 1 begins with empirically testing this assumption on a localhost TT-strict fixture. If verification fails, the spec includes an explicit fallback to the original multi-tool refactor (Section 8 of this spec). Bench acceptance criteria do not change.

## 3. Architecture

### Current state (v0.1.33)

```
Agent → MCP server → TS tool (e.g. safari_click)
  ↓ JS string crafted ('clickElement("#submit-btn")', etc.)
  ↓ engine.executeJsInTab(tabUrl, js)
  ↓ daemon HTTP /poll → background.js
  ↓ browser.storage.local set sp_cmd_<id>
  ↓ content-isolated.js storage.onChanged → window.postMessage
  ↓ content-main.js (MAIN world) receives, dispatches via switch case
  ↓ case 'execute_script': new Function(params.script)()    ← CHOKE POINT
```

### New state (v0.1.34)

```
Agent → MCP server → TS tool
  ↓ JS string crafted (UNCHANGED)
  ↓ engine.executeJsInTab(tabUrl, js)
  ↓ daemon HTTP /poll → background.js (UNCHANGED)
  ↓ browser.storage.local set sp_cmd_<id>
  ↓ content-isolated.js storage.onChanged
  ↓ NEW: if tab.cspMode === 'open': forward to MAIN as today
  ↓      else: execute via new Function() IN ISOLATED WORLD
```

### CSP-mode detection

A new field `cspMode` lives on each tab's metadata. Values:
- `'open'` (default): page CSP is permissive or unset; MAIN-world execution works. Behavior identical to v0.1.33.
- `'tt-strict'`: page sets `require-trusted-types-for 'script'`. ISOLATED-world routing engaged.
- `'eval-blocked'`: page's `script-src` lacks `unsafe-eval` and `trusted-types-eval`. ISOLATED-world routing engaged.
- `'hard-block'`: page sets a `trusted-types <allowlist>` directive that excludes our policy name. Layer 3 fallback throws; `safari_evaluate` returns `CSP_HARD_BLOCK` error.

Detection happens once per tab navigation, post-`document_idle`. Implemented as a probe sent from background.js to content-isolated.js on `webNavigation.onCompleted`. The probe attempts (a) `eval('1')`, (b) `new Function('return 1')()`, (c) `trustedTypes.createPolicy('safari-pilot', {...})` — each wrapped in try/catch. Results determine `cspMode`.

### Layer 3 — Trusted Types policy registration

In content-main.js at load time, attempt `trustedTypes.createPolicy('safari-pilot', { createScript: s => s, createHTML: s => s, createScriptURL: s => s })`. Three outcomes:

1. Success — store policy reference at `window.__SP_TT_POLICY__`. Any remaining MAIN-world string→sink path (legacy code) can route through it.
2. ReferenceError — Trusted Types API not present on this page (no TT enforcement). No action needed.
3. TypeError — page's `trusted-types` directive doesn't permit the `safari-pilot` policy name. Flag `window.__SP_TT_HARD_BLOCK = true`. Combined with `cspMode === 'tt-strict'`, this escalates to `'hard-block'`.

### New capability tools (Layer 1.5)

Three new TS tools in `src/tools/`. Implemented as ISOLATED-world sentinels (no `new Function` involved):

- **`safari_get_page_info(tabUrl, options?)`** → `{title, url, body_snippet, meta_description, meta_og_image, lang}`. Covers ~70% of the 19 CSP-blocked eval calls. `body_snippet` defaults to first 2000 chars; option to extend.
- **`safari_get_meta_tags(tabUrl, names?)`** → `Array<{name, content, attr_source}>`. `names` is optional whitelist (`['description', 'og:title', 'og:image', 'twitter:card']`); without it returns all `<meta>` tags. Covers the meta-tag inspection pattern.
- **`safari_extract_text_window(tabUrl, selector, max_chars?)`** → `{text, truncated, selector_matched_count}`. Reads `textContent` of selector subtree, capped at `max_chars` (default 5000). Covers the "read text near a specific selector" pattern.

All three accept `frameId?: number` for iframe targeting (default top frame). On `cspMode === 'hard-block'`, they still work — they're ISOLATED-world sentinels, so they bypass any page CSP.

### Error UX: `CSP_BLOCKED`

When `safari_evaluate` is called on a tab with `cspMode !== 'open'` and ISOLATED-world execution also fails (rare: page-context global access), return a structured error:

```ts
{
  error: 'CSP_BLOCKED' | 'CSP_HARD_BLOCK',
  message: string,
  hint: {
    cspMode: 'tt-strict' | 'eval-blocked' | 'hard-block',
    alternative_tools: ['safari_get_page_info', 'safari_get_meta_tags', 'safari_extract_text_window', 'safari_click', 'safari_fill', 'safari_snapshot'],
    rationale: 'safari_evaluate executes in ISOLATED world on CSP-strict tabs (CSP-exempt by W3C spec) BUT cannot read page-context globals (window.someApp.state, etc.). Use the named alternative tools for DOM reads and DOM interaction.',
  },
}
```

### Rollback path (engineering-review S5)

A feature flag `SAFARI_PILOT_LEGACY_MAIN_WORLD=1` (env var, read by daemon at startup OR a config field in `safari-pilot.config.json`) reverts the ISOLATED routing. If set, content-isolated.js skips the new branch and forwards to MAIN as in v0.1.33. Users who hit a regression can roll back without downgrading the extension.

### Observability (engineering-review S4)

The `/safari-pilot:stats` CLI is extended to count new error codes:
- `CSP_BLOCKED` failures by site
- `CSP_HARD_BLOCK` failures by site
- `cspMode` distribution across observed tabs

These flow through the existing `tool-calls.jsonl` traces (no schema change — the error codes are new but the structure isn't).

## 4. Slice Plan

### Slice 1 — Apple--41 (~2 days)

**RED step (first activity in the sprint):** Stand up a localhost HTTP fixture at `test/fixtures/csp-trusted-types.ts` that returns a page with `Content-Security-Policy: require-trusted-types-for 'script'`. Write an e2e test that:
1. Opens the fixture in a Safari tab via `safari_new_tab`.
2. Calls `safari_evaluate(tabUrl, 'return 42')`.
3. **Asserts the call SUCCEEDS** (validates the W3C-citation claim that ISOLATED `new Function` works on TT-strict pages).

If the assertion fails: STOP the sprint. Fall back to the multi-tool sentinel refactor in Section 8 of this spec.

If the assertion passes: Proceed.

**GREEN step:** Implement the minimum to make a second test pass:
- A second e2e for `Apple--41`-style: open `apple.com/shop`-mimicking fixture (or actual apple.com/shop if local fixture is insufficient), click an element, extract page info, no CSP errors.
- Duplicate the `new Function(params.script)` dispatcher from content-main.js:714 into content-isolated.js. Route based on `cspMode`: MAIN for `'open'`, ISOLATED otherwise.
- Implement `cspMode` detection probe.
- Implement `safari_get_page_info` (stub the other two new tools — return "not implemented yet" — so error hints reference real tool names).
- Implement `CSP_BLOCKED` error UX.

**Commit boundary:** Slice 1 ends with one passing bench-style task and the verification test, both committed.

### Slice 2 — Google Flights--34 (~2 days)

**RED:** Add `test/fixtures/csp-trusted-types-allowlist.ts` returning a page with `Content-Security-Policy: require-trusted-types-for 'script'; trusted-types google#safe goog#html`. Write an e2e asserting the policy-name allowlist case triggers `cspMode === 'hard-block'` and `safari_evaluate` returns `CSP_HARD_BLOCK` (not silent retry).

Write a second e2e for the Google Flights--34-style task: search Google Flights for a route, extract result. Currently fails; should pass after this slice.

**GREEN:**
- Layer 3: TT policy registration in content-main.js at load.
- Complete the remaining new capability tools (`safari_get_meta_tags`, `safari_extract_text_window`).
- Finalize CSP-mode detection probe (all three sub-tests: eval / new Function / TT createPolicy).

### Slice 3 — Google Search--15 (~1-2 days)

**RED:** Add `test/fixtures/csp-script-src-no-eval.ts` (Mode B: `script-src 'self'` without `unsafe-eval`). E2e: simulate X.com login (text-input field, button click) on the fixture; assert SUCCESS.

**GREEN:**
- Verify Mode B is correctly classified as `'eval-blocked'` (not `'tt-strict'`).
- Verify ISOLATED routing handles Mode B identically to Mode A.
- Add observability: `/safari-pilot:stats` counts for new error codes.
- Add rollback feature flag `SAFARI_PILOT_LEGACY_MAIN_WORLD`.

### Slice 4 — Bench gate (~1-2 days)

- Rerun the 47 v0.1.33 failing tasks via the existing inline-bench harness (`/tmp/run-one-task.sh`, now committed to `bench/webvoyager/run-one-task.sh` with the mktemp + cleanup-timeout fixes from v0.1.33 carry-forwards).
- Rerun a stratified 50-task spot-check from the 128 v0.1.33 passing tasks (10 sites × 5 tasks each, randomized within site).
- Run `bench/webvoyager/judge-inline-runs.ts` over all results.
- Compare aggregate + per-site rates against v0.1.33.
- If acceptance criteria met → write TRACES iter 80, bump version to 0.1.34 in `package.json` + `extension/manifest.json`, run `bash scripts/pre-tag-check.sh`, tag + push + watch CI.
- If acceptance NOT met on any specific site → escalate to v0.1.35 with the AX engine deferred direction surfaced in synthesis.

### Total estimate

6-8 days wall-clock (Slice 1: ~2, Slice 2: ~2, Slice 3: 1-2, Slice 4: 1-2). Engineering-review surfaced items folded in. Lower bound assumes the W3C-citation verification passes in Slice 1 RED and each slice's GREEN converges without unexpected debug. Upper bound assumes some iteration per slice and the bench gate surfaces a partial-acceptance case requiring re-run. If Slice 1 RED fails → fallback path in Section 8 → 9-12 days.

## 5. Testing Strategy

**Unit tests** (`test/unit/`):
- Per new capability tool: 3-5 tests covering happy path, empty content, multi-frame fallback, malformed selector.
- CSP-mode classification: per failure mode (TT-strict, eval-blocked, hard-block, open), unit test that the classifier returns the right enum.
- Per project policy: no mocks of internal modules. Node-boundary mocks (`fs`, `child_process`) only where needed.

**E2E tests** (`test/e2e/`):
- The 3 slice RED tests are the primary CSP coverage.
- Add 1 negative test asserting `CSP_BLOCKED` error structure and `alternative_tools` field shape.
- Per project rule "e2e means architecture": delete the new ISOLATED-routing branch — at least 2 e2e tests must fail. Otherwise the suite isn't testing the routing.

**Fixture infrastructure** (`test/fixtures/`):
- New: `csp-trusted-types.ts` (Mode A)
- New: `csp-trusted-types-allowlist.ts` (Mode A + policy allowlist)
- New: `csp-script-src-no-eval.ts` (Mode B)
- Reuse existing fixture server infra (`test/helpers/fixture-server.ts`).

**Bench:** per project memory "benchmarks-are-sacred", no modification of tasks, judge prompt, or eval criteria.

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ISOLATED-world `new Function` empirically blocked on Safari despite W3C citation | Slice 1 RED test fires first; if it fails, fall back to Section 8 multi-tool refactor (~9-12 day sprint) |
| Page-context globals (`window.someApp.state`) unreachable from ISOLATED | Error UX flags this in `CSP_BLOCKED` hint; agents adapt by reading DOM directly |
| `__SP_LOCATOR__` (MAIN-world) needed by ISOLATED handlers | Re-implement the ~30-LOC shadow-DOM helpers in ISOLATED, OR call into MAIN via postMessage where strictly needed (rare) |
| New capability tools don't cover all 19 CSP-blocked eval shapes | The 19 calls are trivial reads (`document.title`, `body.innerText.slice`, `meta[*]`); 3 new tools cover them. Long-tail unique scripts on OTHER sites already pass — not in scope. |
| Booking/Amazon/Google Map (eval-heavy, currently passing) regresses on the ISOLATED routing because their eval scripts USE page-context globals | `cspMode === 'open'` keeps them on the MAIN path (v0.1.33 behavior). Only CSP-detected tabs route to ISOLATED. The 50-task spot-check is stratified to include these sites for explicit regression detection. |
| Daemon version coupling (CSP detection probe is a new HTTP route) | Daemon bump from v0.1.33 → v0.1.34 (Swift recompile + universal + notarize). Standard release ritual, ~30 min added to CI. |
| Layer 3 TT policy registration breaks on sites with unusual TT directives | Three-outcome handling (success / ReferenceError / TypeError) covers known cases. Unknown sites — fall through to `cspMode === 'hard-block'`. |

## 7. v0.1.35 Carry-Forwards (out of scope, surfaced)

If bench gate falls short on any specific site after v0.1.34:
- **AX engine** (per synthesis): daemon-side Accessibility API engine for click/type/read. Gated behind `--enable-ax-engine` config. Used as last-resort for cases where ISOLATED routing + capability tools don't cover.
- **Page-context globals via postMessage tunnel**: agents that genuinely need `window.someAppState` on CSP-strict sites could request via a new `safari_get_page_context(path: string)` tool that postMessages to MAIN, reads the path, returns. Adds latency but covers the gap.
- **NIOFcntlFailedError SwiftNIO root cause** (carryforward from v0.1.33).
- **v0.1.32 carry-forwards still pending:** daemon Models.swift AnyCodable bool/int coercion, allowlist over-broadness, skipped[] sanitization, selector-pack dead code.

## 8. Fallback: Multi-Tool Sentinel Refactor

If Slice 1 RED test fails (ISOLATED `new Function` blocked in Safari), abandon the architectural pivot and revert to the brainstormed multi-tool refactor:

1. Audit every tool's `engine.executeJsInTab(tabUrl, jsString)` call in `src/tools/`. Categorize: which need page-context, which only need DOM access.
2. For DOM-only tools (click, fill, snapshot, type, get_text, query_all, scroll, dismiss_overlays, etc.), refactor each to use a dedicated sentinel handler in content-isolated.js. ~15-20 tools to refactor.
3. The 3 new capability tools (safari_get_page_info, etc.) stay as designed.
4. Layer 3 TT policy + CSP detection + error UX stay as designed.
5. Sprint estimate inflates to 9-12 days.

This fallback is explicit and well-understood — it's the synthesis Layer 1 + 1.5 + 3 design from `docs/upp/research/2026-05-13-safari-csp-bypass-synthesis.md`. We hold both paths in mind until Slice 1's first hour of work resolves which we're on.

## 9. Open Questions (for plan phase)

1. Exact `frameId` semantics for the new capability tools — does `frameId: 0` mean "any frame" or "top frame only"? Look at existing `_frame-routing-helper.ts` for convention parity.
2. Where does CSP-mode detection live in the tab-ownership registry? `src/security/tab-ownership.ts` or a new `src/security/csp-mode.ts`?
3. Does `cspMode` invalidate on SPA navigation? Twitter/X.com is an SPA with hash-routing — does the CSP header re-apply on route changes? If yes, we need a re-probe on `webNavigation.onHistoryStateUpdated`.
4. The `safari-pilot.config.json` file currently exists. Verify the feature flag `SAFARI_PILOT_LEGACY_MAIN_WORLD` can sit there cleanly, or whether a new config section is needed.
5. Bench gate cost: 47 reruns + 50 spot-checks ≈ 97 tasks × ~$0.60 = ~$58 Anthropic + ~$20 OpenAI judge = ~$78. Acceptable; flag for cost-aware approval before Slice 4 starts.

## 10. References

- Research synthesis: `docs/upp/research/2026-05-13-safari-csp-bypass-synthesis.md`
- v0.1.33 bench results: `bench-runs/webvoyager-v0.1.33-inline-bench-20260513/scoreboard.json` + `/tmp/wv-inline-runs/`
- Trace analysis: 384 safari_evaluate calls, 90% unique, p50 252 chars — recorded in TRACES iter 79
- Codebase choke point: `extension/content-main.js:714`
- W3C citation: [Effects of Trusted Types on browser extension developers](https://github.com/w3c/trusted-types/wiki/Effects-of-deploying-Trusted-Types-on-browser-extension-developers)
- Apple Developer Forums: [thread 651542 — page CSP and Safari Web Extension content scripts](https://developer.apple.com/forums/thread/651542)
- Apple Developer Forums: [thread 728849 — Safari `world: "MAIN"` support](https://developer.apple.com/forums/thread/728849)
- WebKit Trusted Types stable: [commit 971b9ba](https://github.com/WebKit/WebKit/commit/971b9ba19d62aad183c5e3e47e2c1eff7c92f7c6)
