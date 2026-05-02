# Checkpoint
*Written: 2026-05-03 02:35*

## Current Task
Phase 5A · Group A · Chunk 2 item 2 = **5A.1 T41 `safari_file_upload`** — brainstorm + spec + plan COMPLETE; awaiting `upp:executing-plans` handoff. Multi-day work targeting v0.1.22 rebuild.

## Progress

### Phase 5A · Group A — chunk-by-chunk
- [x] **5A.3** right-click + middle-click + modifiers — `6ae37db` (TS-only sub-batch)
- [x] **5A.6** multi-element extraction — `e918ddf` (TS-only sub-batch)
- [x] **5A.4** xpath as first-class locator — `5de6d74` (TS-only sub-batch)
- [x] **5A.5** locator chaining (nth · filter) — `2824d53` (TS-only sub-batch)
- [x] **5A.8** cookies httpOnly via browser.cookies — `979be01` (chunk 1)
- [x] **5A.2** download saveAs post-process — `bb7f4d4` (TS-only standalone)
- [x] **5A.9** HTTP basic auth via DNR — `5104487` (chunk 1)
- [x] **REBUILD CHECKPOINT 1 v0.1.20 + v0.1.21 fix bundle** — `b0b5977`
- [x] **5A.7** HAR record & replay (chunk 2 item 1) — 5 commits ending `597b1b4` + checkpoint `5d1844d`
- [x] **5A.1 brainstorm pipeline** — spec `fd9041c`/`9ebafbc`/`8a670e7` + plan `6a974bf`
- [ ] **5A.1 EXECUTE plan** ← **NEXT** (21 tasks across 9 phases; Phase 0 GATING)
- [ ] → REBUILD CHECKPOINT 2 (v0.1.22) ships at end of Phase 7
- [ ] Phase 5A · Group B (5A.10–5A.14)

## Key Decisions (not yet persisted)

All decisions for the 5A.1 brainstorm pipeline are captured in the committed spec + plan + their commit messages. Specifically:

- **Architecture**: Approach 3 (out-of-band HTTP byte fetch) chosen over Approach 1 (storage bus base64) per engineering CRITICAL — no empirical evidence storage.local handles multi-MB writes in Safari Web Extensions.
- **Phase 0 spike** is a GATING test in v0.1.22 — verifies content-script `fetch('http://127.0.0.1:19475/...')` works AND `File` objects survive ISOLATED→MAIN structured-clone via `window.postMessage`. If either fails, ABORT 5A.1 and re-open design (no v0.1.22 ships).
- **API divergence from Playwright**: empty `paths: []` is rejected (FILE_UPLOAD_EMPTY_PATHS) instead of clearing the input — explicit `clear: true` required. Removes silent-destruction foot-gun for agent-constructed arrays.
- **No path allowlist** (Playwright/Selenium parity). Symlink resolution logged to `server-trace.ndjson` but not blocked.
- **Cap**: 25 MB / file × 4 / call.
- **10 new error codes**, 9-phase plan with 21 tasks total.

TRACES.md NOT updated this session — only documentation artifacts (spec + plan) were committed; no source code changed yet. First source-code iteration starts at executing-plans Phase 1, which is when iteration 50 will be opened.

## Next Steps

### Resume executing-plans (chunk 2 item 2 = 5A.1)

```
Skill tool → upp:executing-plans
args: docs/upp/plans/2026-05-03-safari-file-upload-plan.md
mode: subagent (recommended) | inline
```

The plan is structured for either mode. Subagent mode is the spec's recommendation; the controller dispatches a fresh subagent per task with the three-stage review pipeline (spec compliance, code quality, design — though design gate is N/A here, no DESIGN.md).

### Hard gates encoded in the plan

1. **Phase 0 e2e tests run FIRST in Phase 7 step 7** — architectural gate. Both must pass (content-script fetch + File structured-clone) or 5A.1 ABORTS.
2. **Version bump before rebuild** — `package.json` + `extension/manifest.json` both at 0.1.22 BEFORE `update-daemon.sh` or `build-extension.sh`.
3. **User installs `.app` manually** — agent never invokes system tools (per `feedback-no-system-manipulation`). Tell the user to `open "bin/Safari Pilot.app"`, wait for confirmation.
4. **TDD reviewer gate per task** — `upp:test-reviewer-fast` for ≤3 tests, `upp:test-reviewer` for >3.

### Phase 0 spike must run BEFORE 5A.1 e2e

Vitest's alphabetical default already orders `test/e2e/5A1-phase0-spike.test.ts` before `test/e2e/5A1-file-upload.test.ts` — no special wiring needed. But the runner in Phase 7 step 7 must be invoked separately to assert the gate before continuing to step 8.

## Context

### Branch state
- on `main`, all commits pushed up to `6a974bf`
- 14 unpushed commits ahead of origin/main since last push
- Pre-existing untracked files (leave alone): `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock`
- Stale stashes from 2026-04-16 `feat/file-download-handling` branch — DO NOT `git stash pop` in any composed `&&` command

### Test state (going into Phase 0 implementation)
- **402 unit tests passing** (after 5A.7 add of +52)
- **27 e2e tests passing** (4 right-click + 4 multi-extract + 4 xpath + 5 locator-chaining + 4 cookies + 3 auth + 3 HAR record/replay)
- Phase 0 implementation will add: 2 new e2e tests (RED until v0.1.22 install)
- Full implementation will add: ~42 unit tests + 13 e2e tests

### Active extension version
- **v0.1.21** installed and verified
- Will bump to **v0.1.22** at Phase 7 of the plan
- v0.1.22 ships ALL of Phase 0 + Phase 1–6 + Phase 8 work in one rebuild

### 5A.1 spec + plan locations
- Spec: `docs/upp/specs/2026-05-03-safari-file-upload-design.md` (final commit `8a670e7`)
- Plan: `docs/upp/plans/2026-05-03-safari-file-upload-plan.md` (commit `6a974bf`, 21 tasks, 3273 lines)

### Memory rules to remember (load-bearing for execution)
- `feedback-debugging-discipline`: Use `upp:systematic-debugging` for any bug, never ad-hoc.
- `feedback-no-system-manipulation`: NEVER invoke system tools to manipulate extension state — only the user's manual `open "bin/Safari Pilot.app"` flow.
- `reference-extension-enablement-workaround`: Develop > Allow Unsigned Extensions toggle for first-install enable if Safari blocks with click-interference error.
- `feedback-extension-version-both-fields`: Bump package.json AND extension/manifest.json BEFORE any extension rebuild.
- `feedback-never-open-app-without-version-bump`: Never `open bin/Safari Pilot.app` after rebuild without bumping first.
- `feedback-distribution-builds`: Source changes to `extension/*.js` or `daemon/Sources/**/*.swift` must be followed by rebuild + sign + notarize.
- `feedback-e2e-means-e2e`: e2e tests use real processes/protocols/Safari; zero mocks.
- `feedback-e2e-tests-must-close-tabs`: Every test that opens a tab MUST close it in afterAll. URL markers `?sp_t<N>=`.
- `feedback-never-switch-user-tabs`: Never activate Safari, switch, or navigate user tabs.

### Architectural risk to track during execution
The Phase 0 spike is genuinely uncertain. Best estimate: 70% chance both assumptions pass (Safari WebExtensions follow Chromium-like CSP behavior on content scripts; structured clone of File is universal across browsers). Worst case is Approach 3 dies and we either:

1. Move File construction to MAIN world with bytes shipped via fragmented postMessage (workable but adds complexity)
2. Abandon Approach 3 and accept a smaller cap with Approach 1 storage bus (~5 MB single-file)
3. Abandon page-side injection entirely and pursue AX-driven NSOpenPanel automation in the daemon (multi-week scope)

If Phase 0 fails, stop the plan; do not attempt a workaround inline. Open a follow-up design pass.

### Brainstorm pipeline summary (for narrative continuity)
- Discovery: 6 AskUserQuestion rounds across 5 lenses
- 3 architecture approaches presented; user picked Approach 3 after engineering review forced switch from Approach 1
- 2 design-pass reviews (eng + product) → spec v1
- 2 spec-pass reviews on v1 → spec v2 (architecture switch + 13 fixes)
- 2 spec-pass reviews on v2 → spec v3 (5 small clarifications)
- 2 spec-pass reviews on v3 → spec v4 final (10 small clarifications)
- All review verdicts: PASS / SHIP after final round
- Plan derived from final spec; self-review pass; 21 tasks committed
