# Safari Pilot v0.1.35 — Efficiency & Regression Recovery Sprint

*Status: starter spec. Written 2026-05-14 immediately after v0.1.34 deferred decision. Rooted in `bench-runs/webvoyager-v0.1.34-bench-20260514/deep-analysis.md`.*

## 1. Why this sprint exists

v0.1.34 sprint shipped 14 sentinel refactors + 3 ISOLATED capability tools + Layer 3 TT policy + locator port + rollback flag. **Bench gate failed all 3 quality acceptance criteria** even though aggregate is +5 net (133/184 = 72.3% vs 128/184 = 69.6%):

- Failure recovery: 18/46 (need ≥30) — short by 12
- Spot-check regressions: 10 (need 0) — 10 persistent regressions across 7 sites
- Per-site mins: Apple PASS (8/12), Google Flights FAIL (2/11), Google Search FAIL (8/11)

**The 10 persistent regressions** (verified across first bench + retry round 2):
- Google Flights × 3 (--13, --21, --24) → date-picker fumble
- ESPN × 2 (--16, --37) → noisy sports scores, agent shortcuts
- Booking × 1 (--5) → date issues
- Allrecipes--6, Cambridge Dict--26, Coursera--29, Google Search--14 → assorted

**Root cause analysis** in deep-analysis.md surfaced the dominant pattern: v0.1.34's CSP_BLOCKED error UX (`hint.alternative_tools`) inadvertently taught the agent to FEAR `safari_evaluate` even on non-CSP sites. Tool usage shifted dramatically:

- `safari_evaluate`: 2.17 → 1.07 per task (−50%)
- `safari_query_all`: 0.32 → 1.75 per task (+440%)
- `safari_click`: 0.74 → 1.43 per task (+93%)
- `Bash`: 0.79 → 0.15 per task (−80%)

The agent now does `query_all + click` combos (2 calls) where it previously did `safari_evaluate` (1 call). On simple tasks this is fine. On complex multi-step tasks (Google Flights date pickers, Booking filters), it cascades: Google Flights--34 went 28 → 82 turns, $0.62 → $5.12 (+725% cost). Yet on tasks where v0.1.34 helped, it dramatically wins: Booking--1 went 57 → 7 turns, −90% cost.

**Goal:** ship v0.1.34's CSP-bypass gains AND recover the 10 persistent regressions AND meet bench acceptance.

## 2. Bench acceptance (v0.1.35 ship gate)

Same as v0.1.34 spec, restated:

- ≥30 of 46 v0.1.33-baseline failures recover (≥65%)
- 0 spot-check regressions on a stratified spot-check from v0.1.33-passing tasks
- Per-site mins (delta from v0.1.34 latest):
  - Google Flights: ≥6/11 (currently 2/11; need +4)
  - Apple: ≥7/12 (currently 8/12; HOLD)
  - Google Search: ≥9/11 (currently 8/11; need +1)
  - **Add new:** ESPN ≥6/12 (currently 5/12; need +1) — surfaced as v0.1.34 regression site
  - **Add new:** BBC News ≥7/12 (currently 7/12; HOLD; was 9/12 baseline, lost 2 — but retry recovered 1)
- Aggregate `capture_failure_rate` ≤ 5% (currently 0.0%)
- **NEW:** Aggregate cost reduction ≥ 25% vs v0.1.33 baseline (median per-task cost ≤ $0.28 vs current $0.36)
- **NEW:** Median per-task tool calls ≤ 13 (currently 17.7 in v0.1.34, 15.5 in v0.1.33)

## 3. Hypotheses ranked by ROI (from deep-analysis.md)

| # | Hypothesis | Expected Impact | Eng days | Risk |
|---|---|---|---|---|
| **H1** | Soften CSP_BLOCKED error UX nudging | −10-15% turns/cost | 0.1 | Low |
| **H2** | New `safari_evaluate_then_act` compound tool | −50% tool calls on multi-step tasks | 1.5 | Medium |
| **H3a** | Google Flights site recipe | +3-4 bench wins, −60% cost on site | 2 | Medium |
| **H3b** | Booking site recipe | +1-2 bench wins, −40% cost on site | 2 | Medium |
| **H3c** | Google Map site recipe | +0-1 bench wins, −30% cost on site | 1.5 | Low |
| **H4** | `safari_query_all` interactivity hints (clickable, fillable, role, accessibleName, isVisible, boundingBox, isCovered) | −50% query_all repeats on Google Flights archetype | 1 | Low |
| **H5** | `extract_text_window` quality_score (detect ad/chrome noise) | Recover 2-3 tasks (BBC News archetype) | 0.5 | Low |
| **H6** | Tiered tool surface (basic 15 vs advanced 76 via tool_search) | −10-15% input tokens/turn | 1.5 | Medium |
| **H7** | Implicit waitForLoadState in navigate/click sentinels | −1 wait_for/task across bench | 0.5 | Low |
| **H8** | Drop `--bare` in harness for non-CI bench runs | +1-2 task quality, +65s/task wall | 0.1 | Low |
| **H9** | BBC News dedicated investigation + possible recipe | +2 tasks (BBC News recovery) | 1 | Low |
| **H10** | 3-run bench protocol | Eliminates flake noise from acceptance signal | 0.5 | Low |

**Total: 11.7 eng days. Cumulative expected bench gain: +8 to +15 tasks (push to 78-82%). Cost reduction: −30 to −40%.**

## 4. Sprint slicing

### Slice 0 — Pre-work (0.5 day)
- Implement H10 (3-run bench protocol). All future bench runs use majority-verdict over 3 runs. Doubles cost per gate but eliminates flake noise.
- Implement H8 (drop `--bare` opt-in for non-CI). Restores agent context (CLAUDE.md, hooks, plugin sync, memory).
- Add v0.1.35 starter telemetry: per-tool latency in stream output, sentinel-result-bytes counter.

### Slice 1 — Quick wins (1.5 days)
- **H1**: rewrite CSP_BLOCKED error UX. Remove "alternative_tools" hint by default. Add it ONLY when probing confirms the page is actually CSP-strict. Soften wording: "this script failed; if the page enforces CSP try [alternatives]" instead of "use these instead".
- **H7**: implicit waitForLoadState in `__SP_CLICK__` and `__SP_SCROLL__` sentinel handlers (200-500ms post-click for navigation tasks).
- **H5**: `extract_text_window` returns `quality_score` field (heuristic: ad-density, length-after-trim, repeated-word ratio).
- **Re-bench (single run, fast feedback) the 10 persistent regressions to validate H1 is moving the needle.**

### Slice 2 — Compound tool (1.5 days)
- **H2**: `safari_evaluate_then_act({tabUrl, script, action: 'click'|'fill'|'extract'})`. Single MCP call. Sentinel-routed. CSP-immune via the same path as `__SP_RESOLVE_LOCATOR__`. Returns the action result.
- E2E: TT-strict fixture with multi-step click flow.
- Bench gate: re-run 5-10 cost-heavy tasks (Google Flights, Booking) to validate cost reduction.

### Slice 3 — query_all interactivity hints (1 day)
- **H4**: `resolveLocatorAll` envelope gains per-element `interactability: {clickable, fillable, focusable, role, accessibleName, isVisible, boundingBox, isCovered, isAriaDisabled}`. Drift-detector extended.
- E2E: interactivity-hints fixture verifies each field.

### Slice 4 — Site recipes (5.5 days)
- **H3a Google Flights** (2 days): plugin skill `google-flights-search`. Detects one-way vs round-trip, opens date picker, picks dates via known DOM patterns, applies filters, returns top results.
- **H3b Booking** (2 days): plugin skill `booking-hotel-search`. Filters + dates + sort.
- **H3c Google Map** (1.5 days): plugin skill `google-maps-route`. A→B → directions → travel mode.
- E2E: each recipe exercises at least 2 representative WebVoyager tasks for that site.

### Slice 5 — Tier surface (1.5 days)
- **H6**: split tool registration. Default surface: 15 most-used tools. Advanced surface (76 specialized) loaded on demand via `safari_tool_search` returning relevant tools' schemas. MCP server sends initial tool list = basic only.
- E2E: verify that `safari_tool_search('extract tables from page')` returns `safari_extract_tables` schema correctly.

### Slice 6 — BBC News recipe (1 day)
- **H9**: investigate the 2 BBC News persistent failures. Likely candidates for `bbc-article-extraction` recipe (readability-mode, ad-stripping).

### Slice 7 — Bench gate (1 day)
- 3-run bench (per H10) on the 10 persistent regressions + the 3 cost-heavy sites' tasks.
- Acceptance computation: majority-verdict per task.
- Decision: ship v0.1.35 OR escalate the persistent gap.

### Slice 8 — Ship (1 day)
- Final extension rebuild at v0.1.35.
- pre-tag-check, tag, push, npm publish, CI watch.

**Total: ~13 eng days estimated.**

## 5. Out of scope

- AX engine (still deferred from v0.1.34 spec Section 7)
- Daemon `Models.swift` AnyCodable bool/int coercion (v0.1.32 carry-forward)
- All v0.1.33 carry-forwards (NIOFcntlFailedError root-cause, etc.)
- Refactoring the 5 secondary interaction tools (`safari_check`, `safari_hover`, `safari_double_click`, `safari_select_option`, `safari_drag`) — they still fail on TT-strict but aren't bench-critical
- Replacing `safari_evaluate` itself

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| H1 makes the agent over-use safari_evaluate again, surfacing CSP errors more often | The Layer 3 TT policy + sentinel infrastructure stays. CSP_BLOCKED error still fires when needed; just less aggressive nudging. |
| H2 compound tool isn't well-understood by the agent → low adoption | Tool description carefully phrased + 2-3 example tasks in the description. Dogfood in 5 hand-picked WebVoyager tasks before bench. |
| H3 site recipes brittle to site DOM changes | Recipes use accessibility-locator-first (role, name, label) over CSS selectors. Fall back to safari_evaluate if recipe step fails. |
| 3-run bench (H10) doubles cost from $80 → $250 per gate | Accept cost. Single-run noise was the v0.1.34 bench-decision quality issue. |
| Tier surface (H6) breaks existing power users who expect all 91 tools immediately | Add config flag `safari-pilot.config.json` `toolSurface: 'all' \| 'tiered'` (default 'all' v0.1.35, 'tiered' v0.1.36). |

## 7. v0.1.35 sprint inputs

- This spec
- `bench-runs/webvoyager-v0.1.34-bench-20260514/deep-analysis.md` (full analysis)
- `bench-runs/webvoyager-v0.1.34-bench-20260514/scoreboard-final.json` (per-task verdicts)
- `bench-runs/webvoyager-v0.1.34-bench-20260514/runner.log` + `retry2.log` (full bench telemetry)
- `/tmp/wv-inline-runs-baseline-v0.1.33/` (preserved baseline, 184 score files)
- `/tmp/wv-inline-runs-v0.1.34/` (v0.1.34 first bench, 106 score files)
- `/tmp/wv-inline-runs-v0.1.34-retry/` (retry round 2, 31 score files)
- `/tmp/wv-inline-runs/` (overlaid + judged, 184 score files = current source-of-truth)
- All v0.1.34 sentinel infrastructure (commits `d1f9e59` through `cf84574` on `feat/v0134-csp-bypass`)

## 8. v0.1.34 disposition

Branch `feat/v0134-csp-bypass` (HEAD `d3fee62`) stays unmerged. v0.1.34 ships nothing externally. The work IS preserved as the foundation for v0.1.35 — the sentinels, the locator port, the rollback flag, the new capability tools all stay in the codebase. v0.1.35 will:
1. Layer the H1-H10 changes on top of the v0.1.34 branch
2. Re-bench with the 3-run protocol
3. Ship as v0.1.35 directly (no v0.1.34 intermediate release)

This compresses two ship cycles into one and avoids shipping a bench-acceptance failure.
