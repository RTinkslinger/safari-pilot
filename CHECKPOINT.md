# Checkpoint
*Written: 2026-05-13 18:00*

## Current Task

v0.1.34 sprint **pivoted** from architectural approach (spec Section 3) → Section 8 fallback (multi-tool sentinel refactor). Original plan `904fd81` is stale and should be discarded. New plan needed.

**Sprint goal unchanged:** recover CSP-blocked bench failures (Google Flights, Apple Shop, X.com) by making DOM-affecting tools work on Trusted-Types-strict pages. Bench acceptance: ≥30 of 47 v0.1.33 failures recover, per-site mins (Google Flights ≥6/11, Apple ≥7/12, Google Search ≥9/11), 0 regressions on 50-task spot-check.

## Progress

### Done (this session)
- [x] v0.1.33 shipped to npm + GitHub (live, version 0.1.33 published)
- [x] 3-agent research on CSP/TT bypass → synthesis at `docs/upp/research/2026-05-13-safari-csp-bypass-synthesis.md` (validator PASS)
- [x] Brainstorming → spec at `docs/upp/specs/2026-05-13-safari-pilot-v0134-csp-bypass.md` (committed `9edd3c4`)
- [x] Writing-plans → plan at `docs/upp/plans/2026-05-13-safari-pilot-v0134-csp-bypass.md` (committed `904fd81`)
- [x] Executing-plans started in subagent mode
- [x] Task 1 (TT-strict fixture + v0.1.33 regression baseline) — committed
- [x] Task 2 architectural-pivot ATTEMPTED, **EMPIRICALLY FAILED**
- [x] Pivot decision committed (`6227230` on `feat/v0134-csp-bypass`)
- [x] TRACES iter 80 written

### Architectural-pivot failure summary
Spec Section 3 hypothesized that adding `__SP_CSP_VERIFY__` and `__SP_EXECUTE_ISOLATED__:` sentinels to content-isolated.js would let arbitrary JS strings execute in the CSP-exempt ISOLATED world. Three rebuilds at 0.1.34, 0.1.34-dev.1, 0.1.34-dev.2 — sentinels never fired. The dispatch path for arbitrary scripts bypasses content-isolated.js's intercept in some way we couldn't pin down (~1h debugging burned). Full detail in TRACES iter 80.

The fallback design (spec Section 8) avoids this problem: every DOM-affecting tool gets a dedicated sentinel handler in content-main.js's switch case — same pattern as existing `__SP_TAKE_SCREENSHOT__` and `__SP_LIST_FRAMES__` which both confirmedly work on TT-strict pages (0% capture failure in v0.1.33 bench across all 15 sites).

### Not done (for next session)

- [ ] **Discard plan `904fd81`** — it's built around the architectural pivot
- [ ] **Write new plan based on spec Section 8** via `upp:writing-plans` skill OR inline. Estimated ~20 tasks:
  - Audit `src/tools/*.ts` for every `engine.executeJsInTab(tabUrl, jsString)` call site. Already partially done (TRACES iter 80 noted ~30+ tools through `new Function`)
  - For each DOM-affecting tool (click, fill, snapshot, type, get_text, query_all, scroll, dismiss_overlays, smart_scrape, etc.), refactor to:
    - Construct structured params (selector, value, etc.) instead of JS string
    - Send via storage bus with a dedicated sentinel like `__SP_CLICK__:<json>`
    - Add a `case '__SP_CLICK__':` handler in content-main.js's switch that uses `__SP_LOCATOR__` and structured params — no `new Function`
  - Add 3 new capability tools (safari_get_page_info, safari_get_meta_tags, safari_extract_text_window) as new sentinels
  - Layer 3 TT policy registration (unchanged from spec)
  - CSP detection probe (unchanged from spec)
  - `CSP_BLOCKED` error UX (unchanged from spec)
  - Bench gate
- [ ] Execute the new plan (subagent mode, two-gate review). ~9-12 days wall-clock.

## Key Decisions (in iter 80, not yet codified elsewhere)

1. **Architectural pivot is unsalvageable without deeper dispatch-path investigation.** The empirical fact is content-isolated.js's sentinel intercepts don't fire for the new sentinels we added, despite being correctly placed in the built bundle. Reasons unknown. Section 8 fallback is reachable in fewer days than continued investigation, so we go there.
2. **safari_evaluate stays broken on TT-strict pages — that's an explicit non-goal.** v0.1.34 makes OTHER tools work (click, fill, get_page_info, etc.). The `test/e2e/csp-baseline-tt-strict.test.ts` documents this as a regression baseline.
3. **No daemon changes needed** for Section 8 — all changes are extension + TS.

## Next Steps

When you resume in a fresh session:

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"

# Verify state
git branch --show-current  # should be feat/v0134-csp-bypass
git log --oneline -5       # 6227230 (HEAD) is the pivot commit
git status --short         # should be empty + 2 daemon/ untracked carry-forwards

# Read the design source-of-truth
cat docs/upp/specs/2026-05-13-safari-pilot-v0134-csp-bypass.md  # Section 8 is the design
cat TRACES.md | head -100  # iter 80 has the pivot rationale

# Re-plan
# Option A (recommended): re-invoke writing-plans skill with the Section 8 design as input
# Option B: draft the new plan inline if you trust the audit findings from iter 80

# The OLD plan at docs/upp/plans/2026-05-13-safari-pilot-v0134-csp-bypass.md
# is the architectural-pivot version. Either:
# - Delete it and write a new one (clean)
# - Rename it to <filename>-architectural-pivot-abandoned.md and write a new <filename>.md (preserve history)
```

### Sprint shape for the new plan

20-task shape (concrete):

1. **Codebase audit task** — confirm the exact list of tools routing through `new Function`. From TRACES iter 80: extraction.ts (smart_scrape, get_text, query_all), interaction.ts (click, fill, type, scroll), compound.ts (chained ops), clipboard.ts, auth.ts, frames.ts, network.ts. ~10-15 distinct tools.

2-13. **One task per tool refactor** — each follows TDD: write failing e2e against CSP fixture → implement sentinel handler in content-main.js + structured-param marshalling in tool.ts → verify green. Pattern reference: existing `__SP_TAKE_SCREENSHOT__` handler in content-main.js.

14-16. **Three new capability tools** (safari_get_page_info, safari_get_meta_tags, safari_extract_text_window) — as content-main.js sentinels with structured-result returns.

17. **Layer 3 — TT policy registration** in content-main.js (unchanged from spec).

18. **CSP detection probe** — useful for the error-UX hint message even though dispatch routing is no longer needed (since all DOM ops are sentinel-based now and bypass new Function entirely).

19. **CSP_BLOCKED error UX** for the remaining `safari_evaluate` call site.

20. **Bench gate** — rerun 47 failures + 50 spot-check, judge, ship.

### Things explicitly NOT to do on resume

- Do NOT retry the architectural pivot (sentinel-from-content-isolated.js). Empirical evidence says it doesn't dispatch as we thought.
- Do NOT attempt to "fix" the dispatch path to reach content-isolated.js — that's a deeper rabbit hole. Section 8 sidesteps it.
- Do NOT delete `test/e2e/csp-baseline-tt-strict.test.ts` — it's the v0.1.33-failure-mode baseline.
- Do NOT bump package.json or extension/manifest.json — they're already at 0.1.34. Stay there until ship time.
- Do NOT rebuild the extension yet. The first rebuild of the new sprint will be the first content-main.js sentinel addition (combined with all subsequent changes in batches).

## Context

### Repo state at this checkpoint

- **Branch:** `feat/v0134-csp-bypass` at HEAD `6227230`, 4 commits ahead of main
- **Commits this branch (newest→oldest):**
  - `6227230` pivot: v0.1.34 architectural-pivot abandoned, falling back to spec Section 8
  - `2596a48` test(fixtures+e2e): TT-strict CSP fixture + v0.1.33 baseline assertion (Task 1)
  - (... 2 more from earlier sprint setup ...)
- **Working tree:** clean except 2 untracked carry-forwards (`daemon/CLAUDE.md`, `daemon/TRACES.md`) — out of scope
- **package.json + extension/manifest.json:** 0.1.34
- **Extension binary (bin/):** v0.1.33 (last committed state — reset from dev.2 to keep history clean)
- **Daemon:** v0.1.33, PID 76143 alive ~22h
- **Failed dev builds:** v0.1.34-dev.1, v0.1.34-dev.2 — NOT tagged, NOT pushed, only existed locally during the failed pivot attempt

### Cumulative session accounting

- Wall-clock: ~18 hours across multiple resumes (v0.1.33 ship + research + brainstorming + planning + pivot attempt)
- API spend: ~$130 (rough): v0.1.33 bench ~$104, research subagents ~$10, brainstorming/planning ~$15, pivot debug ~$5
- This session's user-visible artifacts: v0.1.33 shipped to npm, synthesis doc, spec, abandoned plan, new TRACES iter 80, regression baseline test

### Available context for the fresh session

- Spec at `docs/upp/specs/2026-05-13-safari-pilot-v0134-csp-bypass.md` (Section 8 is the design)
- Research synthesis at `docs/upp/research/2026-05-13-safari-csp-bypass-synthesis.md`
- Bench data still on disk at `/tmp/wv-inline-runs/` (175 task results from v0.1.33)
- Inline-bench harness at `/tmp/run-one-task.sh` (with the macOS mktemp + perl-alarm cleanup fixes from v0.1.33 — promote to `bench/webvoyager/` during Section 8 work)
- TT-strict fixture at `test/fixtures/csp-trusted-types.ts` (working)
- Existing v0.1.33 regression baseline test at `test/e2e/csp-baseline-tt-strict.test.ts` (working, asserts v0.1.33 failure)
