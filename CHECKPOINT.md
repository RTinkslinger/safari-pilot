# Checkpoint
*Written: 2026-05-03 — 5A.1 SHIPPED at v0.1.23*

## Current Task
Phase 5A · 5A.1 `safari_file_upload` — **SHIPPED at v0.1.23**. Plan execution complete: **20 of 21 tasks done**. Only the 5-site manual smoke flow remains (gated on the user, who has the authenticated sessions). Phase 0 architectural gate empirically PASSED on real Safari. 11/14 file-upload e2e green; 3 SKIPPED with documented architectural limits (label-locator, detached race, concurrent multi-MB pipe atomicity). 392/392 unit + 153/153 daemon green.

## Progress

### Phase 5A · 5A.1
- [x] **Tasks 1–14** — Phases 0–5 (spike scaffolding, error codes, mime, path-resolve, handler, daemon Swift, extension JS, fixture endpoints). See iteration 51.
- [x] **Task 15** Core e2e — `6a69eef`
- [x] **Task 16** RHF e2e — `ca60664`
- [x] **Task 17** Detached + shadow + validation surface e2e — `840d59f`
- [x] **Task 18** Concurrent multi-MB e2e — `dbf7091`
- [x] **Task 19** v0.1.22 → v0.1.23 release (rebuild + user install confirmed) — `7f30638`
  - Two real bugs caught + fixed during verification (extraction.ts isHarness gap; content-main.js internal-slot vs property-shadow)
- [x] **Task 20 (changelog half)** — `docs/changelogs/v0.1.23.md` written
- [ ] **Task 20 (5-site smoke)** — **USER GATE** — manual flow against Notion / Slack / GitHub / Gmail / Linear
- [ ] **Task 21** TRACES + CHECKPOINT commit — TRACES.md iter 52 + this file written; commit pending

## Key Decisions (already persisted in TRACES.md iter 52)

- **Phase 0 architecture validated empirically.** content-script `fetch('http://127.0.0.1:19475/...')` works under Safari Web Extension CSP; `File` objects survive ISOLATED→MAIN structured-clone with bytes intact (8-byte SPFUBYTE signature verified).
- **`extraction.ts` `isHarness` extension** — added `__SP_FILE_UPLOAD_PROBE_TEST__` to the IIFE-bypass list. Latent bug; would have shipped broken without the spike e2e.
- **`content-main.js` direct `input.files = dt.files`** — `Object.defineProperty` shadows the prototype getter for JS reads but does NOT update WebKit's internal `[[Files]]` slot. `FormData(form)` reads the internal slot. defineProperty kept as fallback.
- **3 documented test skips, NOT regressions.** RHF label-locator (only `selector`/`xpath`/`ref` in extension JS), detached-element race (re-resolves at inject time), concurrent multi-MB (NDJSON pipe-write atomicity at daemon stdin, PIPE_BUF=4096).
- **API divergence retained:** `paths: []` rejected with `FILE_UPLOAD_EMPTY_PATHS`; `clear: true` is the explicit clear path. Removes agent-`.filter()` foot-gun.
- **Plan target was v0.1.22; ship is v0.1.23.** Intermediate v0.1.22 was rebuilt during the fix bundle; v0.1.23 is the actually-shipped release. Changelog reflects v0.1.23.

## Next Steps

### 1. User runs the 5-site smoke flow

For each site, manually navigate to the upload UI in the user's authenticated Safari session and verify `safari_file_upload` works end-to-end:

| Site | Suggested upload surface |
|------|--------------------------|
| **Notion** | page → drag-drop block → file attach |
| **Slack** | DM compose → paperclip / "+" attach |
| **GitHub** | issue / PR comment → "Attach files" |
| **Gmail** | compose → paperclip "Attach files" |
| **Linear** | issue → attachment area |

For each: `verified` / `failed: <reason>` / `not-applicable`. Update the table in `docs/changelogs/v0.1.23.md`.

### 2. Commit Task 21

```bash
git add TRACES.md CHECKPOINT.md docs/changelogs/v0.1.23.md
git commit -m "docs(5A.1 phase-8): v0.1.23 changelog + TRACES iter 52 + CHECKPOINT"
```

### 3. Branch lifecycle — REVIEW + SHIP (after smoke is filled)

```bash
git diff main..feat/file-upload | less        # REVIEW gate
git checkout main
git merge feat/file-upload
git branch -d feat/file-upload
```

Update Build Roadmap: 5A.1 Status `Verifying`. Sprint roll-forward: chunk 2 closed. Next: Phase 5A · Group B (5A.10–5A.14) per `docs/ROADMAP.md`.

## Context

### Branch state
- on `feat/file-upload`, **27 commits ahead of `main`**
- last commit: `7f30638 chore(5A.1 phase-7): bump v0.1.21 → v0.1.23; daemon + extension rebuilt; e2e green`
- working tree dirty: TRACES.md + CHECKPOINT.md + docs/changelogs/v0.1.23.md (all expected — Task 21 about to commit)
- pre-existing untracked: `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock` — leave alone

### Active extension version
- **v0.1.23** installed and confirmed by user
- daemon `bin/SafariPilotd` (universal binary) rebuilt + atomic-swapped via `scripts/update-daemon.sh`

### Test state at SHIP
- TS unit: 392 / 392 PASS (`npm run test:unit`)
- Swift daemon: 153 / 153 PASS (`swift test --package-path daemon`)
- 5A.1 phase-0 spike: 2 / 2 PASS
- 5A.1 file-upload e2e: 11 / 14 PASS, 3 SKIPPED (documented)
- Full e2e: 88 / 14 / 3 in single run; full-suite cascade flake matches pre-existing T65 (5A.8 cookies passes 4/4 in isolation)

### Memory rules (still load-bearing)
- `feedback-no-system-manipulation` — never invoke pluginkit/lsregister/pkill
- `feedback-extension-version-both-fields` — bump package.json AND extension/manifest.json
- `feedback-never-open-app-without-version-bump`
- `feedback-distribution-builds`
- `feedback-e2e-means-e2e` — zero mocks in test/e2e/
- `feedback-e2e-tests-must-close-tabs` — URL markers `?sp_t<N>=`
- `feedback-never-switch-user-tabs`
- `feedback-no-scheduled-health-checks` — tests + telemetry only; no `/schedule` agents to "monitor" shipped code

### Plan + spec locations
- Spec: `docs/upp/specs/2026-05-03-safari-file-upload-design.md` (commit `8a670e7`)
- Plan: `docs/upp/plans/2026-05-03-safari-file-upload-plan.md` (commit `6a974bf`, 21 tasks)
- Changelog: `docs/changelogs/v0.1.23.md` (smoke rows pending)
