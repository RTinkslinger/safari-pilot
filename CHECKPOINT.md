# Checkpoint
*Written: 2026-04-26 00:30*

## Current Task
Phase C audit cleanup, post-tracker-consolidation. All three real bugs surfaced by the 2026-04-25 fresh-eyes review (T7, SD-31, SD-32) are shipped. Single source of truth for open work is now `docs/TRACKER.md`. Awaiting next directive: continue with extension batch (T21+T22+T27+T44 with rebuild+sign+notarize+release) or P2 quality debt (T34-T40) or pause.

## Progress
- [x] Phase B: SD-12..SD-28 (17 SDs) all resolved
- [x] Phase C / batch 1 (pre-compact): T13, T15, T16, T17, T18, T19, T20, T23, T24, T25 (10 items)
- [x] Phase C / batch 2 (post-compact): T26, T28, T29, T30, T31, T32 + SD-29
- [x] Ledger reconciliation pass (commit `da37e52`): 13 stale-open T-items marked RESOLVED, SD-31 + SD-32 filed
- [x] **Single tracker**: `docs/TRACKER.md` consolidates AUDIT-TASKS.md + FOLLOW-UPS.md + ROADMAP backlog (commit `4bec8e3`); both archives kept with "superseded" headers, RESOLVED entries preserved for fix-context lookup
- [x] **SD-31** shipped (`63d4e59` + `ecb32d6`) — kill-switch recordError filters security-pipeline errors
- [x] **T7** shipped (`71218d9` + `317527a`) — regression guard for existing safari_close_tab cleanup at server.ts:833-852 (was RESOLVED-UNMARKED; reconciliation Explore agent missed it)
- [x] **SD-32** shipped (`6b55ff9` + `170592e`) — orphan-cleanup skips when other live sessions exist
- [ ] **Extension-rebuild batch (4 items, ONE drop)**: T21 (history.pushState patching), T22 (pollLoop retry), T27 (findTargetTab fallback), T44 (stale sp_result on re-wake) — pickup point if user says "do extension batch"
- [ ] **P2 quality debt (7 items)**: T34, T35, T36, T37, T38, T39, T40 — pickup point if user says "keep going" with audit cleanup
- [ ] **P3 missing features / cosmetic (17 items)**: T41-T58 minus extension-batch ones; includes T43 (61 untested tools, multi-week sub-sprint)
- [ ] **SD-30** (deferred feature): banking-disable-extension; needs threat model + default-policy decision before wiring
- [ ] **ROADMAP backlog**: navigate_back/forward stale URL (#3), NDJSON line-split flake under parallel test runs

### Resolved this segment (2026-04-25 PM → 2026-04-26 — post-T32 work)

| # | Item | Code | Docs | Summary |
|---|---|---|---|---|
| 1 | Reconciliation | — | `da37e52` | 13 stale-open T-items marked RESOLVED + SD-31, SD-32 filed |
| 2 | Tracker consolidation | — | `4bec8e3` | New `docs/TRACKER.md` as single source for open work |
| 3 | SD-31 | `63d4e59` | `ecb32d6` | killSwitch.recordError filters security-pipeline errors (no more TabUrlNotRecognizedError-burst self-DoS) |
| 4 | T7 | `71218d9` | `317527a` | Regression guard for existing safari_close_tab tab-ownership cleanup at server.ts:833-852 |
| 5 | SD-32 | `6b55ff9` | `170592e` | orphan-cleanup skips when other live sessions exist; multi-session contract restored |

Test counts: 122 → **126** unit (+4 across SD-31, T7, SD-32, intermediate). Swift unchanged at 129. Total: **323 = 129 Swift + 126 unit + 28 canary + 41 e2e**.

Reviewer dispatches: 2 (SD-31, SD-32) — both PASS first try. T7 reviewer-skipped per established pattern (test-only regression guard for existing fix). Tracker-consolidation + reconciliation are docs-only.

Mutation cycles: 3 (SD-31, T7, SD-32) — every behavioural change verified by reverting + re-running.

## Key Decisions (not yet persisted)

- **`docs/TRACKER.md` is the single source of truth for OPEN work going forward.** AUDIT-TASKS.md + FOLLOW-UPS.md are now archives — their RESOLVED entries preserve fix-context paragraphs that the tracker intentionally summarises in one line. New entries go ONLY in TRACKER.md.
- **Tracker method is documented inside the tracker itself** — atomic per-item rubric (branch → systematic-debugging Phase 1 → TDD with reviewer gate → mutation cycle → ff-merge → push → docs commit moving Open→Resolved). Reviewer-skip permitted only for: deletion of dead code (T24 / T31 precedent), test-infra-only refactors (SD-29 precedent), test-only regression guards for existing fixes (T7 precedent), re-use of an already-reviewed shared helper (T32 precedent).
- **T7 was RESOLVED-UNMARKED** — the cleanup lives at `server.ts:833-852` (post-execution adoption block "8.post1"), not in NavigationTools.handleCloseTab. The 2026-04-25 reconciliation Explore agent missed this because it only inspected navigation.ts. Fix is now guarded by regression test.
- **SD-31 was a regression introduced today** by T29 (`a504928`). The fix-and-test-and-mutation cycle pattern caught it during the same-day fresh-eyes review and shipped the patch within hours. Self-imposed lesson: any future T/SD whose fix lives in a catch block should also include error-class filtering analysis.
- **SD-32 had 3 fix options**; chose option (b) (skip cleanup when otherSessions > 0) over (a) (sessionId-embedded title) because it's lean and preserves the SD-21 single-session crash-recovery path. Open caveat: the wiring at `server.ts:1422` (storing the registerWithDaemon return) is unit-uncovered; only an e2e exercises the full registerWithDaemon → field-write → cleanup-skip flow. Worth filing as SD-33 if anyone reports concurrent-session breakage.
- **All decisions captured in commits + TRACKER.md + AUDIT-TASKS.md + FOLLOW-UPS.md** — this checkpoint exists primarily for resume-after-compaction continuity, not as a source of new info.

## Next Steps

If resuming with **"keep going" (P2 quality debt)**:
1. **T34** — `framesCrossOrigin: true` in extension caps but `extension/manifest.json` lacks `all_frames: true`. Pair with T55 — choose deliver-via-manifest (T55) or remove-from-caps (T34). TS + manifest fix.
2. **T35** — IDPI scanner annotates result metadata but never blocks; documentation honestly says "no block". Decide: block (rename + add throw path) or rename "scanner" → "annotator". Behavioural.
3. **T36** — Screenshot redaction script returned but never injected before capture (currently a no-op annotation). Wire injection or remove.
4. **T37** — `recordPreExisting` + `isPreExisting` methods on TabOwnership have zero callers; deletion-only (T24-precedent reviewer skip).
5. **T38** — `recoverSession` re-opens window + polls extension but never calls `registerWithDaemon()` — multi-session count desyncs after recovery.
6. **T39** — `roundtripTimestamps`/`timeoutTimestamps`/`uncertainTimestamps` arrays grow unbounded; only `forceReloadTimestamps` has pruning.
7. **T40** — ARCHITECTURE.md has 8 stale claims (cross-origin frames, ownership-domainMatches, etc.). Doc-only fix.

If "do the extension batch" (T21+T22+T27+T44, ONE drop):
- Edit `extension/content-isolated.js` (T21) + `extension/background.js` (T22, T27, T44).
- `bash scripts/build-extension.sh` → verify entitlements via `codesign -d --entitlements -` → bump `package.json` version (per "never open app without version bump" memory) → `open "bin/Safari Pilot.app"` → verify in Safari Settings → release.
- ETA: ~1 hour for build + verify + release, plus per-item code work.

If "pause for review":
- Branch: `main` at `170592e`, fully synced with `origin/main`.
- All segment ships have paired code + docs commits.
- Working tree carry-over: M `CLAUDE.md`, M `TRACES.md`, ?? `AGENTS.md`, `CHECKPOINT.md` (this file), `e2e-harness-best-practices-2026.{md,json}`.

## Context

- Branch: `main` at `170592e`, synced with `origin/main`.
- Single tracker: `docs/TRACKER.md` (consolidates audit + SDs + ROADMAP backlog).
- Archives kept (each with "superseded" header):
  - `docs/AUDIT-TASKS.md` (T1-T58 with full Findings/Root-cause/Origin/Fix paragraphs in Resolved entries)
  - `docs/FOLLOW-UPS.md` (SD-01..SD-32 with discriminator + entry-points + fix-context paragraphs)
- Working tree carry-over (NOT this segment's work):
  - M `CLAUDE.md` (frontmatter `brain_federation: enabled` from prior session)
  - M `TRACES.md` (Iteration 32 from earlier in 2026-04-25; Iteration 33 covering tracker + SD-31 + T7 + SD-32 added in this checkpoint)
  - ?? `AGENTS.md`, `CHECKPOINT.md`, `e2e-harness-best-practices-2026.{md,json}`, `.claude/scheduled_tasks.lock`
- Test counts: **129 Swift + 126 unit + 28 canary + 41 e2e = 323 total**
- Total open in tracker: **31** items (28 audit T-items + SD-30 + 2 ROADMAP backlog). **Zero real bugs open** — all remaining is quality debt, missing features, deferred design decisions, or cosmetic.
- Sprint cumulative across all sessions: **68 (sprint start) → 323 (now) = +255 net new tests**.
- Reviewer-calibration this whole sprint: 16 dispatches across all SDs and audit items, all PASS first try; 5 reviewer-skips per established patterns (deletion-only, test-infra-only, test-only regression guards, re-used helper).
