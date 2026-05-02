# Checkpoint
*Written: 2026-05-03 03:55*

## Current Task
Phase 5A · 5A.1 `safari_file_upload` — `upp:executing-plans` IN PROGRESS on `feat/file-upload` branch. **14 of 21 tasks complete**: Phases 0–5 fully shipped (spike + TS foundation + TS handler + daemon Swift + extension JS + fixture endpoints). Next is **Task 15** (Phase 6 e2e — first real-Safari test, RED until v0.1.22 ships).

## Progress

### Phase 5A · 5A.1
- [x] **Task 1** Phase 0 spike scaffolding (extension JS) — `9e67332` + `cad67de`
- [x] **Task 2** Phase 0 spike e2e tests — `8ff3153` + `e6eb3fd`
- [x] **Task 3** 10 FileUpload error codes + subclasses — `a234937`
- [x] **Task 4** `src/tools/mime.ts` (8 tests) — `8a9776f`
- [x] **Task 5** `src/path-resolve.ts` + `findClosestSibling` (13 tests) — `df79f90` + `e736399`
- [x] **Task 6** `src/tools/file-upload.ts` handler + server registration (18 tests) — `0a0662b` + `90aa71f`
- [x] **Task 7** Swift `FileStagingStore` actor + 6 Swift tests — `b8fb398`
- [x] **Task 8** `stage_file` NDJSON command on CommandDispatcher (3 tests) — `aac7d56`
- [x] **Task 9** `GET/DELETE /file-bytes/<token>` Hummingbird routes (1 test) — `b7b1932`
- [x] **Task 10** TTL cleanup in main.swift — `17b8455` + `a132875` (macOS 12 compat fix)
- [x] **Task 11** `__SP_FILE_UPLOAD_PROBE__` + `__SP_FILE_UPLOAD__` background.js sentinels — `6d3f2f1`
- [x] **Task 12** content-isolated.js: probe + byte fetch + DELETE — `a5aacf7`
- [x] **Task 13** content-main.js: DataTransfer + defineProperty + events + validation probe — `11b7055`
- [x] **Task 14** `/upload-fixture` + `/upload-validate` + `/upload-form` fixture routes — `be3d217`
- [ ] **Task 15** Core e2e ← **NEXT** (RED until v0.1.22)
- [ ] **Tasks 16–18** RHF e2e + edge-case e2e + concurrency e2e
- [ ] **Task 19** v0.1.22 release (USER GATE — manual `open "bin/Safari Pilot.app"`)
- [ ] **Tasks 20–21** Smoke + docs

## Key Decisions (already persisted in TRACES.md iter 51)

This session shipped Tasks 7-14 — all the daemon Swift, extension JS, and fixture work. Notable fixes:

- **Task 6 architectural fix** (`90aa71f`): `FileUploadTools` now takes `(engine, daemon)` constructor; staging uses `daemon.command('stage_file', {...})` via existing `DaemonEngine.command()`. Plan's `engine.execute(NDJSON_object)` was wrong — IEngine takes only string and routes to JS-eval-in-tab.
- **Task 10 macOS 12 fix** (`a132875`): `Task.sleep(for: .seconds(30))` requires macOS 13+; switched to `Task.sleep(nanoseconds: 30_000_000_000)`.
- **Task 11/12/13 plan-bug pattern**: like Task 1, plan snippets used wrong storage-bus shape and `cmd.commandId` (it's `cmd.id`). Implementers correctly mirrored the existing Phase 0 spike pattern with full storage-bus shape.
- **Task 12/13 inline locator**: plan's `SP.findElement` / `SPMain.findElement` don't exist. Both tasks ship inline minimal locators (selector / xpath / ref) — same coverage in both content-isolated and content-main worlds. Other locator types (role/text/label/placeholder) require shared helper not yet wired into extension JS; defer to follow-up if Task 15 e2e flags missing types.

## Next Steps

### Resume at Task 15 (Phase 6 e2e)

The plan section is at line 2535 of `docs/upp/plans/2026-05-03-safari-file-upload-plan.md`. Tasks 15-18 are all e2e tests against real Safari. They WILL be RED against current v0.1.21 install — Phase 7 (Task 19) is what ships v0.1.22 with the actual feature.

Per Task 2's pattern, write the e2e tests + verify they fail RED + commit. The tests run GREEN only after Task 19's manual install.

```
Skill tool → upp:executing-plans
args: docs/upp/plans/2026-05-03-safari-file-upload-plan.md (subagent mode)
```

When resuming:
1. Verify branch state: `git status` clean on `feat/file-upload`, ~22 commits ahead of main
2. TaskList: Tasks 71-77 still pending (Task 15 = #71, etc.). Tasks 57-70 marked completed.
3. Continue from Task 15.

### Critical for Task 19 (USER GATE)

Per `feedback-no-system-manipulation`: NEVER invoke `pluginkit`, `lsregister`, `pkill`, `open bin/Safari Pilot.app`. Tell the user to manually `open "bin/Safari Pilot.app"` after the rebuild and wait for confirmation before proceeding to Phase 7 step 7 (the spike gate).

Per `feedback-extension-version-both-fields`: BEFORE rebuild, bump BOTH `package.json` and `extension/manifest.json` to 0.1.22.

Per the plan's GATING rule: Phase 7 step 7 runs `test/e2e/5A1-phase0-spike.test.ts` SEPARATELY first. If both spike assumptions pass, continue to other 5A.1 e2e. If either fails, ABORT — do NOT ship v0.1.22.

### Task 17/18 expected coverage gaps

The minimal locator in content-isolated.js + content-main.js supports `selector`, `xpath`, `ref`. If Task 17 e2e tests use `role`/`label`/`placeholder`/`text` locators, those will fail. Either:
- Task 17 narrows to `selector` only for v1, OR
- Defer Task 17 e2e cases that use other locators, OR
- Build a shared locator helper in `extension/lib/` and inline-import in both content scripts (deferred to v2 per the existing IIFE pattern).

### Task 21 cleanup (deferred from Tasks 3, 4, 6)

Fold these into the Task 21 final-polish commit:
1. Export `FILE_UPLOAD_SIZE_CAP = 26_214_400` and `FILE_UPLOAD_MAX_FILES = 4` from `src/errors.ts`. Update `src/tools/file-upload.ts:24` to import them instead of inline `25 * 1024 * 1024`.
2. `src/tools/mime.ts`: `text/rust` → `text/x-rust` for table consistency.
3. Add `mp3` to mime test suite.
4. `FileUploadPathNotReadableError.hints` and `FileUploadInvalidParamsError.hints` — currently empty arrays. Add agent-actionable hints.
5. Optional retryability sweep test in `test/unit/errors-file-upload.test.ts`.

### Hard gates encoded in the plan (still apply)

1. **Phase 0 e2e tests run FIRST in Phase 7 step 7** — architectural gate.
2. **Version bump before rebuild** — `package.json` + `extension/manifest.json` both at 0.1.22.
3. **User installs `.app` manually** — agent never invokes system tools.
4. **TDD reviewer gate per task** — test-reviewer-fast for ≤3 tests, test-reviewer for >3.

## Context

### Branch state
- on `feat/file-upload`, ~22 commits ahead of main
- last commit: `be3d217 feat(5A.1 phase-5): /upload-fixture (multipart sha256 echo) + /upload-validate + /upload-form routes`
- working tree clean
- pre-existing untracked files (leave alone): `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock`

### Test state going into Task 15
- **TS unit tests**: 408+8+13+18 = ~447 unit tests passing
- **Swift daemon tests**: 153/153 passing (149 baseline + 6 FileStagingStore + 3 stage_file dispatch + 1 file-bytes route)
- **TS e2e tests**: 27 baseline + 2 spike (RED by design until v0.1.22)
- All non-spike tests still GREEN against v0.1.21

### Build state
- `npm run lint` clean (TS)
- `swift build --package-path daemon` clean
- `swift run SafariPilotdTests` 153/153 PASS

### Active extension version
- **v0.1.21** installed and verified
- Will bump to **v0.1.22** at Phase 7 (Task 19)

### 5A.1 spec + plan locations
- Spec: `docs/upp/specs/2026-05-03-safari-file-upload-design.md` (commit `8a670e7`)
- Plan: `docs/upp/plans/2026-05-03-safari-file-upload-plan.md` (commit `6a974bf`, 21 tasks, 3273 lines)

### Memory rules (load-bearing for Task 19)
- `feedback-no-system-manipulation`: NEVER invoke pluginkit/lsregister/pkill
- `feedback-extension-version-both-fields`: bump package.json AND extension/manifest.json before rebuild
- `feedback-never-open-app-without-version-bump`
- `feedback-distribution-builds`: source changes → rebuild + sign + notarize
- `feedback-e2e-means-e2e`: zero mocks in test/e2e/
- `feedback-e2e-tests-must-close-tabs`: URL markers `?sp_t<N>=`
- `feedback-never-switch-user-tabs`

### Architectural risk to track
The Phase 0 spike is genuinely uncertain (~70% confidence). If Phase 7 reveals it fails after v0.1.22 install:
1. Move File construction to MAIN with bytes via fragmented postMessage
2. Abandon Approach 3 → smaller cap with Approach 1 storage bus (~5 MB)
3. AX-driven NSOpenPanel automation in daemon (multi-week)

If Phase 0 fails, stop — do not workaround inline. Open follow-up design pass.
