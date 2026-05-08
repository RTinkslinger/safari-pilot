# Checkpoint
*Written: 2026-05-08 17:55*

## Current Task
**v0.1.31 evidence-grounding sprint — 9/24 tasks shipped.** Tool 1 (`safari_scroll_to_element`) fully verified end-to-end. Tool 2 fixture infrastructure (positive + negative + danger) ready. Mid-execution plan corrections + `--skip-notarize` removal + lockstep version bump (Task 22 pulled forward) all landed cleanly. Pre-existing `daemon/Models.swift` integer 0/1 → boolean coercion bug discovered by Task 7 e2e, root-caused, deferred to v0.1.32.

## Progress

### Done (9/24)
- [x] **T1** error codes — TARGET_NOT_FOUND, TARGET_HIDDEN added to ERROR_CODES + ERROR_METADATA (`e8a93e2`)
- [x] **T2** allowlist loader + schema validator + two-signal rule (`0843820`)
- [x] **T3** allowlist content — 4 JSON files, 14 patterns total (`abbdd34`)
- [x] **T4** scroll fixtures — 4 localhost servers (`bf65ffc`)
- [x] **plan correction** — Option A (sentinel host = content-main.js MAIN world, NOT background.js service worker) (`48c8051`)
- [x] **T5+6** atomic scroll pair — locator.js + manifest.json + content-main.js intercept + interaction.ts handler (`cecd587`)
- [x] **lockstep v0.1.30 → v0.1.31** — Task 22 pulled forward to enable real-Safari testing of new sentinels (`36e2a47`)
- [x] **`--skip-notarize` removed** from build-extension.sh + plan + memory (`f548d06`)
- [x] **T7** scroll e2e — 6/6 PASS at p95 ≈ 291ms, real Safari + v0.1.31 extension (`d93c09b`)
- [x] **T8** dismiss positive fixtures — 7 servers including DANGER fixture (`289e698`)
- [x] **T9** per-pattern negative fixtures — 14 files, the safety net (`a75e912`)
- [x] v0.1.31 extension: notarized + stapled + Gatekeeper-accepted + active in user's Safari

### Not done yet (15/24)
- [ ] **T10+11** atomic dismiss pair — extension/locator.js extension (matchSignal/findPatternRoot/dismissPattern) + content-main.js intercept for `__SP_DISMISS_OVERLAYS__:` + src/tools/overlays.ts new OverlayTools class + server.ts registration + IdpiAnnotator EXTRACTION_TOOLS Set extension + sanitization + kill switch + paywall opt-in flag. **HEAVIEST task of sprint.**
- [ ] **T12** dismiss e2e base — 6 assertions (cookie/shadow/registration/paywall-default/no-overlay/danger fixture)
- [ ] **T13** dismiss e2e — kill switch + paywall opt-in + idpi-scan-reaches-dismissed (5 assertions across 3 files)
- [ ] **T14** per-pattern integration tests — 14 positive/negative pairs in `test/e2e/overlays/` (the canonical safety regression network)
- [ ] **T15** 4 new SKILL.md files (evidence-grounded-screenshot procedural; dismiss-overlays-recovery / visible-evidence-grounding / temporal-substitution strategy)
- [ ] **T16** plugin.json registration — register 4 new skills + fix existing 3-skill discrepancy
- [ ] **T17** SessionStart hook update — 3-line stdout JSON emit before final `exit 0`, preserves existing stderr discipline + new unit test
- [ ] **T18** stats CLI — `/safari-pilot:stats` slash command + src/cli/stats.ts + format.ts + commands/stats.md
- [ ] **T19** stats CLI tests — 4 unit + 1 e2e
- [ ] **T20** pre-tag-check.sh additions — allowlist parse-validate + `tests/ci/content-only-patch.sh` proof
- [ ] **T21** CHANGELOG.md v0.1.31 entry
- [ ] **T22** lockstep version bump — **already done in `36e2a47`**; the canonical Task 22 commit serves dual purpose. Remaining at the canonical-T22 slot: only build-number bump (timestamp) on each subsequent extension rebuild.
- [ ] **T23** full notarize build at ship time — already running each rebuild via the always-notarize policy; the canonical Task 23 step is just the FINAL rebuild before tag-push.
- [ ] **T24** pre-tag check + bench gate + merge to main + tag push (depends on Anthropic Max quota refresh for the 175-task v0.1.31 baseline run)

## Key Decisions (not yet persisted)

All decisions persisted via:
- Spec at `docs/upp/specs/2026-05-08-webvoyager-evidence-grounding-design.md` (commit `47fbd61`)
- Plan at `docs/upp/plans/2026-05-08-webvoyager-evidence-grounding.md` (with corrections at `48c8051` + `f548d06`)
- 5 new memory files this session:
  - `feedback-no-skip-notarize` — never add or use `--skip-notarize`
  - `project-v0132-bool-coercion-carryforward` — daemon Models.swift fix planned for v0.1.32
  - (plus pre-existing memories all consulted)

Notable architectural decisions resolved during execution:
- **Option A sentinel host:** sentinels needing `window.__SP_LOCATOR__` MUST live in `extension/content-main.js`'s `case 'execute_script':` early-intercept, NOT in `background.js` (service worker can't reach page DOM). This was a plan defect caught by the Tasks 5+6 implementer; corrected and committed at `48c8051` before re-dispatch.
- **`--skip-notarize` policy reversal:** flag was added in v0.1.30 Task 2 as "dev-loop convenience"; removed in v0.1.31 after explicit user objection. Every rebuild is now full Xcode → sign → notarize → stapler → spctl. Memory `feedback-no-skip-notarize` documents the reasoning.
- **Task 22 pulled forward:** original plan placed lockstep version bump at end. Pulling it forward to between Tasks 6 and 7 was REQUIRED so Safari would actually load the new extension code (per `feedback-extension-version-both-fields`: Safari caches by CFBundleShortVersionString).
- **Bool coercion carry-forward:** `daemon/Models.swift:39-44` `AnyCodable.encode` matches `Bool` before `Int`/`Double`. NSNumber 0/1 silently coerces to false/true. Fix needs scoped v0.1.32 sprint with regression coverage; v0.1.31 ships with `asInt()` normalizer pattern documented in test.

## Next Steps

### Next session resume — resume cleanly from `a75e912` HEAD

**Immediate next task: Tasks 10+11 (atomic-revert pair, dismiss-overlays implementation).** This is the heaviest task of the sprint:
- Extends `extension/locator.js` with `matchSignal`, `findPatternRoot`, `dismissPattern` helpers (open shadow root penetration verified working in Tool 1)
- Adds `__SP_DISMISS_OVERLAYS__:<json>` intercept to `extension/content-main.js` ALONGSIDE the existing `__SP_SCROLL_TO_ELEMENT__:` intercept (place above or below; mutually exclusive prefixes)
- New `src/tools/overlays.ts` with `OverlayTools` class (definitions + handler with config-flag plumbing)
- Modifies `src/server.ts` to register OverlayTools + extends `EXTRACTION_TOOLS` Set at line 1053-1059 to include `safari_dismiss_overlays` (so IdpiAnnotator scans the `content[0].text` summary)
- Modifies `package.json` build script to copy `src/overlays/*.json` into `dist/overlays/`
- Implements id-only sanitization in the handler (drop aria-label/text/free-text fields)
- Implements env-var config flag reading at MCP boot: `SAFARI_PILOT_DISABLE_OVERLAY_DISMISS`, `SAFARI_PILOT_ENABLE_PAYWALL_DISMISS`
- Single atomic commit: `feat(dismiss): safari_dismiss_overlays tool + sentinel + IdpiAnnotator scan extension (v0.1.31 Tasks 10-11, atomic)`
- Mandatory rebuild via `bash scripts/build-extension.sh` (FULL notarize, no shortcut — `--skip-notarize` removed)

**Recommended micro-manifest carry-forwards for the next dispatch:**
- The `__SP_SCROLL_TO_ELEMENT__:` intercept at `content-main.js:552-609` is the canonical reference for the dispatch shape. New `__SP_DISMISS_OVERLAYS__:` intercept must use the same pattern: `result = X; break;` for success (NOT `return`), `throw Object.assign(new Error(msg), { name: 'CODE' })` for errors. The IIFE structure preserves both paths through `respond(true/false, ...)`.
- The bool-coercion bug affects this tool too — `overlaysAtStart`/`overlaysAtEnd` integer 0 will arrive as `false` on the wire. Tests must use the same `asInt()` normalizer pattern.
- Allowlist registry is loaded by Node at boot via `loadAllAllowlists('dist/overlays')` (paths from `src/overlays/index.ts`). Must add a `package.json` build step copying JSON to `dist/overlays/` so the loader finds it.

**Subsequent cadence (Tasks 12-24):**
- T12 + T13 dismiss e2e tests — straightforward TDD
- T14 per-pattern integration tests — 14 positive/negative pairs; could be batch-dispatched (one subagent per category cluster)
- T15-T17 skills + plugin.json + hook — all small content/config tasks; can be inline-executed
- T18-T19 stats CLI — substantive but isolated
- T20 pre-tag-check additions — small infrastructure
- T21 CHANGELOG — write at the end with actual baseline numbers
- T22 (canonical slot) — only build-number bump on final rebuild; no marketing version change
- T23 final full notarize before tag
- T24 bench gate (175-task WebVoyager) — requires Anthropic Max quota refresh window (5h+); takes 6-10 hours wall-clock

### Things explicitly NOT to do without further user direction
- Do NOT re-introduce `--skip-notarize` in any form. Memory `feedback-no-skip-notarize` documents the reasoning.
- Do NOT run `osascript 'quit'` or `pkill Safari` (CLAUDE.md hard rule #6).
- Do NOT push the v0.1.31 tag until the bench gate (T24) acceptance criteria are met (Allrecipes 12/12 holds, any site ≥80% baseline doesn't drop more than 1 task, capture_failure_rate ≤ 10.4%, per-failure-subset monotonic improvement).
- Do NOT touch the bool-coercion bug in v0.1.31 — defer the AnyCodable encode fix to v0.1.32 with proper regression coverage.

## Context

### Repo state at checkpoint time
- **Branch:** `feat/v0131-evidence-grounding`, 11 commits ahead of `main` (which is at `ae37879`)
- **HEAD:** `a75e912` (Task 9)
- **Working tree:** clean except untracked `daemon/CLAUDE.md` and `daemon/TRACES.md` (pre-existing carry-forward from v0.1.30, see prior CHECKPOINT.md)
- **Active extension:** v0.1.31 (notarized + stapled, marketing version 0.1.31, build 202605081720) — confirmed enabled in user's Safari, all 5 health checks PASS (safari_running, js_apple_events, screen_recording, daemon, extension)
- **Tests:** 656/656 unit + 6/6 new e2e green; lint clean

### Bug discoveries logged
- **`daemon/Models.swift:39-44` AnyCodable.encode bool/int coercion** — pre-existing, surfaced by Task 7 e2e, root-caused, fix planned for v0.1.32. Memory: `project-v0132-bool-coercion-carryforward.md`. Trace evidence: `test-results/traces/2026-05-08_12-07-21/tool-calls.jsonl`.
- **Pattern definition over-broadness flagged for v0.1.32 hardening:** `generic-newsletter-modal` (signals can match user's own newsletter management UI), `generic-aria-cookie` (primary selector embeds aria-label test, weakening the two-signal rule), `smart-app-banner` (pattern is two-selector with no aria/role test). Documented in Task 9 implementer report and per-fixture comment headers.
- **Pre-existing `FRAME_NOT_FOUND` inconsistency:** `errors.ts:55-58` SD-22 deletion comment lists FRAME_NOT_FOUND as deleted, but a live class for it exists at line 465. Out of scope for v0.1.31; flag for future cleanup.

### Files touched this session (cumulative)

```
src/errors.ts                              (+17, T1)
src/overlays/types.ts                      (NEW, T2)
src/overlays/index.ts                      (NEW, T2)
src/overlays/cookie-consent.json           (NEW, T3, 6 patterns)
src/overlays/registration-walls.json       (NEW, T3, 3 patterns)
src/overlays/app-install.json              (NEW, T3, 2 patterns)
src/overlays/paywalls.json                 (NEW, T3, 3 patterns)
src/tools/interaction.ts                   (+63, T6 — handleScrollToElement)
extension/locator.js                       (NEW, T5, 201 lines)
extension/content-main.js                  (+58, T5 — sentinel intercept @ lines 552-609)
extension/manifest.json                    (+1, T5 + version bump)
package.json                               (version 0.1.30 → 0.1.31)
scripts/build-extension.sh                 (--skip-notarize removed)
docs/upp/plans/2026-05-08-webvoyager-evidence-grounding.md  (Option A correction + skip-notarize cleanup)
test/unit/errors-scroll-codes.test.ts      (NEW, T1)
test/unit/overlay-allowlist-loader.test.ts (NEW, T2)
test/fixtures/allowlist/valid.json         (NEW, T2)
test/fixtures/allowlist/single-signal-invalid.json  (NEW, T2)
test/fixtures/scroll-targets-page.ts       (NEW, T4)
test/fixtures/multi-match-page.ts          (NEW, T4)
test/fixtures/iframe-same-origin.ts        (NEW, T4)
test/fixtures/iframe-cross-origin.ts       (NEW, T4)
test/fixtures/cookie-consent-onetrust.ts   (NEW, T8)
test/fixtures/cookie-consent-shadow.ts     (NEW, T8)
test/fixtures/registration-wall-newsletter.ts (NEW, T8)
test/fixtures/app-install-banner.ts        (NEW, T8)
test/fixtures/paywall-nyt-mock.ts          (NEW, T8)
test/fixtures/no-overlay-control.ts        (NEW, T8)
test/fixtures/legitimate-confirm-dialog.ts (NEW, T8 — DANGER fixture)
test/fixtures/overlays-negative/*.ts       (NEW, T9 — 14 files, 518 lines)
test/e2e/scroll-to-element.test.ts         (NEW, T7 — 283 lines, 6/6 PASS)
bin/Safari Pilot.app                       (rebuilt v0.1.31 fully notarized)
~/.claude/projects/.../memory/feedback-no-skip-notarize.md     (NEW)
~/.claude/projects/.../memory/project-v0132-bool-coercion-carryforward.md  (NEW)
~/.claude/projects/.../memory/MEMORY.md    (+2 entries indexed)
```

### Anthropic Max quota status
Health check confirmed extension active. No `claude -p` benchmark runs this session. Quota fresh for the next agent dispatches in subsequent sessions.

### Next-session SessionStart hook will pick up this CHECKPOINT.md automatically. After absorbing it, that session can delete CHECKPOINT.md per the project protocol.
