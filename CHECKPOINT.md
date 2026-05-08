# Checkpoint
*Written: 2026-05-08 03:50*

## Current Task
**v0.1.30 SHIPPED.** `safari_take_screenshot` now captures the Safari WebView via `tabs.captureVisibleTab` instead of the broken whole-screen `screencapture`. Released to npm + GitHub Releases earlier today. Partial dev-sample baseline (67/175 tasks) captured before Anthropic Max quota exhausted; remaining 108 tasks await `--resume` after quota refreshes.

## Progress

### Done
- [x] Spec + plan written and reviewed (brainstorming + engineering-leader + product-leader + adversarial reviews)
- [x] **Tasks 0–15 complete** per `docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md`
- [x] 18 commits on the sprint branch, FF-merged to main, pushed
- [x] `v0.1.30` tag pushed; release.yml ran green in 5m 24s; npm `safari-pilot@0.1.30` live, GitHub Release v0.1.30 with 3 assets
- [x] All 647 unit tests + new e2e suite (`screenshot-webview.test.ts`) green
- [x] Two-tier capture protocol shipped: agent self-capture (Tier 1, 75% of tasks) + post-hoc fallback (Tier 2, 15%) + UNKNOWN (10%, dominated by Amazon bot-wall timeouts)
- [x] Two iterative bug fixes folded in: stale-screenshot detection (commit `ed876ce`) and tab-close→two-tier protocol (commit `f11367d`)
- [x] CHANGELOG.md created with full v0.1.30 entry incl. partial-baseline numbers + rollback path

### Not done yet
- [ ] **Resume the 108 remaining WebVoyager dev-sample tasks** with `--resume` once Max quota refreshes (~5h windows). Will give a complete v0.1.30 ship-gate baseline number.
- [ ] **TRACES.md compaction debt:** Current Work section has accumulated iters 64, 65, 66, 69, 70, 71 (and now 72) without running the every-3-iterations compaction. Pre-existing debt; flag for cleanup but not a blocker.
- [ ] **3 stale Safari tabs** from earlier test runs: `https://stripe.com/in?sp_t59=…` (security-layers test), `https://www.amazon.com/`, `https://www.allrecipes.com/recipe/229156/zesty-quinoa-salad/` — sweep at convenience.
- [ ] **Notion roadmap update:** mark v0.1.30 sprint items Verifying / Shipped (Notion MCP not loaded this session — manual update needed).

## Key Decisions (not yet persisted)

All decisions persisted:
- Spec at `docs/upp/specs/2026-05-08-safari-take-screenshot-webview-design.md`
- Plan at `docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md`
- CHANGELOG.md committed in release commit `5fcd948`
- TRACES.md iteration entry added (iter 72, this session — see below)

Notable architectural decisions documented in spec/CHANGELOG:
- Two-tier capture (Tier 1 agent self-capture, Tier 2 post-hoc) was an emergent design from the first overnight rerun showing ~50% Tier 2 capture failures. NOT in the original plan; documented in `feat(bench): two-tier screenshot capture` commit (`f11367d`).
- `INVALID_PARAMS` rejection of `format='jpeg'` (no silent lying) and `ERROR_METADATA` map (separate from `ERROR_CODES` to keep the existing string-map clean) — both deviated from the initial plan in honest ways.

## Next Steps

### Next session resume (in priority order)

1. **Verify v0.1.30 npm install path works** end-to-end on a clean dir:
   ```bash
   mkdir /tmp/sp-verify && cd /tmp/sp-verify && npm init -y && npm install safari-pilot@0.1.30
   # then: open ~/.../safari-pilot/bin/Safari\ Pilot.app to register
   # then: claude -p "List safari_* tools" should include safari_take_screenshot
   ```
   If verification passes, mark the v0.1.30 Notion roadmap item Shipped.

2. **Resume baseline.** Once Anthropic Max quota refreshes:
   ```bash
   cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
   bash bench/webvoyager/run.sh --variant v0.1.30-baseline --sample dev --runs 1 --concurrency 1 --resume \
     --tasks-file <SAME tmpfile? — actually the run.sh resamples, see below>
   ```
   **CAVEAT:** `bash bench/webvoyager/run.sh` re-samples 175 tasks via `bench/webvoyager/sample-cli.ts` each invocation with seed `v0.1.x-dev-sample`. As long as the seed is unchanged, the same 175 task IDs are produced. The runner's `--resume` flag (in `bench/webvoyager/runner.ts`) skips tasks that already have `*.score.json` files in the out-dir.
   
   Pass `--tasks-file` matching the previous run's sample is safer. Or: pass the SAME `--variant` and `--out-dir` (need to check whether run.sh supports `--out-dir` — it does NOT today; OUT_DIR is auto-generated with timestamp). **Workaround:** copy the previous run's out-dir to a NEW timestamp dir first, then point at it via direct `node --import tsx bench/webvoyager/runner.ts --tasks-file <same-jsonl> --variant v0.1.30-baseline --out-dir <copied-dir> --runs 1 --concurrency 1 --resume`.
   
   Where the previous run stopped: `bench-runs/webvoyager-v0.1.30-baseline-20260508-050932/` (67 tasks scored, last task `Booking--4-r1` with `Credit balance is too low` failure).

3. **Sweep stale Safari tabs.** Three URLs from prior test runs cluttering the user's Safari. Use `osascript -e 'tell app "Safari" to close (every tab whose URL contains "sp_t59")'` (and similar for amazon.com, zesty-quinoa-salad).

4. **Future v0.1.31 work:** per-host recipes for Amazon bot wall + locale leakage, Apple judge-strictness mitigation, claude-p silent-hang root cause.

## Context

### Repo state at checkpoint time
- **Branch:** `main` (FF-merged from `feat/v0130-webvoyager-and-discovery` which is now obsolete — both at `5fcd948`)
- **Tag:** `v0.1.30` pushed to origin
- **Working tree:** clean except untracked `daemon/CLAUDE.md` and `daemon/TRACES.md` (pre-existing, unrelated to this work)
- **bin/Safari Pilot.app:** v0.1.30, notarized + stapled + Gatekeeper-accepted (`accepted, source=Notarized Developer ID`)
- **Local Safari install:** v0.1.30 enabled and verified
- **CI run:** `gh run view 25535304542` — completed success in 5m 24s

### Partial baseline data (preserved on disk; gitignored)
- **Active partial:** `bench-runs/webvoyager-v0.1.30-baseline-20260508-050932/` — 67 task scores, ~80 transcripts, ~60 PNG screenshots in `/tmp/wv-*.png`
- **Quarantined:**
  - `bench-runs/webvoyager-v0.1.29-baseline-20260507-232457.partial-screenshot-bug/` — 36 tasks from the original session-start halted run (the one where every screenshot was terminal output)
  - `bench-runs/webvoyager-v0.1.30-baseline-20260508-040056.partial-stale-screenshot-bug/` — 14 tasks before the stale-file bug was caught and fixed
  - `bench-runs/webvoyager-v0.1.30-baseline-20260508-045035.partial-tabclose-bug/` — 4 tasks before the tab-close bug was caught and the two-tier capture was implemented

### Two-tier capture distribution (67-task partial)
- Tier 1 (agent self-capture, prompted explicitly): 50 (75%)
- Tier 2 (post-hoc fallback): 10 (15%)
- Tier 3 (UNKNOWN — neither): 7 (10%)

### Per-site partial results
- **Allrecipes: 12/12 SUCCESS (100%).** Best site by far.
- **Amazon: ~5/12 (~42%).** ~5 silent-hang timeouts on the same task IDs that failed in earlier runs (Amazon's bot wall hits `claude -p` init).
- **Apple: 3/12 (25%).** With real screenshots, the GPT-4o judge is much stricter on Apple's marketing pages where the requested fact isn't visually prominent.
- **ArXiv: 7/11 (64%).**
- **BBC News: ~5/9 (~56%).**
- **Booking: 3/5 partial.** Last task `Booking--4` exited with `EXIT=1` and `Credit balance is too low` — Anthropic Max hit its session quota.

### Critical files / line refs
- Tool handler: `src/tools/extraction.ts handleTakeScreenshot` (rewritten)
- Sentinel: `extension/background.js` line ~388, branch `if (cmd.script === '__SP_TAKE_SCREENSHOT__')`
- Bench harness two-tier: `bench/webvoyager/adapter.ts` `runWebVoyagerTask` — agent path, post-hoc path, CAPTURE_SOURCE marker
- Build script flag: `scripts/build-extension.sh --skip-notarize` (also `SKIP_NOTARIZE=1` env var)
- Test gate: `test/e2e/screenshot-webview.test.ts` red-pixel proof + 4 other assertions

### Things explicitly NOT to do without further user direction
- Do NOT publish v0.1.31 / v0.1.30.1 patch releases yet (no known regressions; finish baseline first)
- Do NOT delete the quarantined `.partial-*` directories (may be useful for forensic comparison)
- Do NOT touch `daemon/CLAUDE.md` / `daemon/TRACES.md` (untracked, pre-existing, unrelated)

### Anthropic Max quota status
Hit the per-session limit at task 67 (Booking--4, ~7 hours of `claude -p` runtime in this session including all the smoke / e2e / partial overnight runs). Quota refreshes on a ~5h window. Resume schedule depends on when this checkpoint is read.
