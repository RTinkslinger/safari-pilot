# Checkpoint
*Written: 2026-05-03 02:35 (updated 02:50)*

## Current Task
Phase 5A · 5A.1 `safari_file_upload` — `upp:executing-plans` IN PROGRESS on `feat/file-upload` branch. **3 of 21 tasks complete**: Phase 0 GATING scaffolding (Tasks 1+2) + Phase 1 first task (Task 3 error codes). Next is Task 4 (`src/tools/mime.ts`).

## Progress

### Phase 5A · Group A — chunk-by-chunk
- [x] **5A.3/4/5/6/8/2/9** Group A chunk 1 + TS-only items shipped (prior sessions)
- [x] **5A.7** HAR record & replay (chunk 2 item 1)
- [x] **5A.1 brainstorm + spec + plan** (iter 50)
- [x] **5A.1 Task 1** Phase 0 spike scaffolding (extension JS) — `9e67332` + `cad67de`
- [x] **5A.1 Task 2** Phase 0 spike e2e tests (RED until v0.1.22) — `8ff3153` + `e6eb3fd`
- [x] **5A.1 Task 3** Error codes + 10 FileUploadError subclasses — `a234937`
- [ ] **5A.1 Task 4** `src/tools/mime.ts` ← **NEXT**
- [ ] **5A.1 Task 5** `src/path-resolve.ts`
- [ ] **5A.1 Task 6** `src/tools/file-upload.ts` (largest task, opus recommended)
- [ ] **5A.1 Tasks 7–10** Daemon Swift (FileStagingStore, stage_file NDJSON, /file-bytes routes, TTL cleanup)
- [ ] **5A.1 Tasks 11–13** Extension JS (background sentinels, content-isolated bytefetch+DELETE, content-main DataTransfer injection)
- [ ] **5A.1 Task 14** Fixture endpoints (/upload-fixture, /upload-validate)
- [ ] **5A.1 Tasks 15–18** E2E suite (core, RHF, edge, concurrency)
- [ ] **5A.1 Task 19** v0.1.22 release (USER GATE — manual `open "bin/Safari Pilot.app"`)
- [ ] **5A.1 Tasks 20–21** Smoke + docs
- [ ] Phase 5A · Group B (5A.10–5A.14)

## Key Decisions (already persisted in TRACES.md iter 51)

All decisions documented in iteration 51 entry. Highlights:
- Branch `feat/file-upload` created from `main` (CLAUDE.md branch protocol).
- Subagent mode for executing-plans: every task dispatched implementer + 2 reviewers (spec + quality). 2 fix cycles invoked so far (clearTimeout, about:blank → fixture origin).
- Plan documentation errors caught by reviewers: 3 micro-manifest snippet bugs corrected by implementers (cmd.commandId vs cmd.id, super(...) signature, alphabetical sort claim). Functional contract preserved.

## Next Steps

### Resume at Task 4 (`src/tools/mime.ts`)

The plan section is at lines 554+ of `docs/upp/plans/2026-05-03-safari-file-upload-plan.md`. Read and dispatch via:

```
Skill tool → upp:executing-plans
args: docs/upp/plans/2026-05-03-safari-file-upload-plan.md (subagent mode)
```

When resuming, the controller should:
1. Verify branch state (`git status` should show clean working tree on `feat/file-upload`, 5 commits ahead of `main`).
2. Read TaskList — Tasks 60-77 still pending (Task 4 = #60, Task 5 = #61, etc.). Task 1-3 = #57-59 marked completed.
3. Continue dispatching from Task 4 onward.

### TASK 6 PREREQUISITES (folded findings from Task 3 reviewer)

Before dispatching Task 6 implementer, ensure these are addressed:

1. **Add named constant exports to `src/errors.ts`** (or new `src/constants.ts`):
   ```typescript
   export const FILE_UPLOAD_SIZE_CAP = 26_214_400;  // 25 MiB
   export const FILE_UPLOAD_MAX_FILES = 4;
   ```
   And update `FileUploadFileTooLargeError.cap` to reference the constant. Update `FileUploadTooManyFilesError` message template to interpolate `FILE_UPLOAD_MAX_FILES`. The handler at `src/tools/file-upload.ts` will enforce these caps using the same constants.

2. **Add hints to two empty-hints error classes**:
   - `FileUploadPathNotReadableError.hints = ['Check file permissions (chmod +r), verify the path is a regular file (not a directory), and confirm it contains no NUL bytes.']`
   - `FileUploadInvalidParamsError.hints = ['Check the tool input schema — paths must be absolute, mimeOverrides keys must match entries in paths.']`

3. **Optional retryability sweep test** (test #6 in `test/unit/errors-file-upload.test.ts`):
   ```typescript
   expect(err.retryable).toBe(err instanceof FileUploadElementDetachedError);
   ```

### Hard gates encoded in the plan (still apply)

1. **Phase 0 e2e tests run FIRST in Phase 7 step 7** — architectural gate. Both must pass (content-script fetch + File structured-clone) or 5A.1 ABORTS.
2. **Version bump before rebuild** — `package.json` + `extension/manifest.json` both at 0.1.22 BEFORE `update-daemon.sh` or `build-extension.sh`.
3. **User installs `.app` manually** — agent never invokes system tools (per `feedback-no-system-manipulation`). Tell the user to `open "bin/Safari Pilot.app"`, wait for confirmation.
4. **TDD reviewer gate per task** — `upp:test-reviewer-fast` for ≤3 tests, `upp:test-reviewer` for >3. (Plan often says fast where full is correct — reviewer to use full when count > 3.)

### Plan documentation errors to correct in a follow-up commit (non-blocking)

- Task 1 micro-manifest: `cmd.commandId` should be `cmd.id`. Storage-bus dispatch shape needs `tabId/method/deadline/params`, not minimal `{op,commandId}`.
- Task 2 alphabetical-order claim: `5A1-file-upload` actually sorts BEFORE `5A1-phase0-spike` (`f` < `p`). Plan's Phase 7 step 7 enforces gate by running spike file separately, so order is moot for correctness.
- Task 3 `super(code, message, retryable, hints)` snippet: `SafariPilotError(message, options?)` is the actual signature. `code`/`retryable`/`hints` are readonly class fields per existing pattern.

## Context

### Branch state
- on `feat/file-upload`, 5 commits ahead of `main`
- last commit: `a234937 feat(5A.1 phase-1): 10 FileUpload error codes + typed subclasses`
- working tree clean
- pre-existing untracked files (leave alone): `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock`
- Stale stashes from 2026-04-16 — DO NOT `git stash pop` in any composed `&&` command

### Test state going into Task 4
- **402 + 6 = 408 unit tests passing** (Task 3 added 6)
- **27 + 2 = 29 e2e tests** (Task 2 added 2 RED-by-design until v0.1.22)
- All non-spike e2e tests still GREEN against v0.1.21 install

### Active extension version
- **v0.1.21** installed and verified
- Will bump to **v0.1.22** at Phase 7 (Task 19) of the plan

### 5A.1 spec + plan locations
- Spec: `docs/upp/specs/2026-05-03-safari-file-upload-design.md` (final commit `8a670e7`)
- Plan: `docs/upp/plans/2026-05-03-safari-file-upload-plan.md` (commit `6a974bf`, 21 tasks, 3273 lines)

### Memory rules (load-bearing for execution)
- `feedback-debugging-discipline`: use `upp:systematic-debugging` for any bug, never ad-hoc.
- `feedback-no-system-manipulation`: NEVER invoke system tools to manipulate extension state — only the user's manual `open "bin/Safari Pilot.app"` flow.
- `feedback-extension-version-both-fields`: bump package.json AND extension/manifest.json BEFORE any extension rebuild.
- `feedback-never-open-app-without-version-bump`: never `open bin/Safari Pilot.app` after rebuild without bumping first.
- `feedback-distribution-builds`: source changes to `extension/*.js` or `daemon/Sources/**/*.swift` must be followed by rebuild + sign + notarize.
- `feedback-e2e-means-e2e`: e2e tests use real processes/protocols/Safari; zero mocks.
- `feedback-e2e-tests-must-close-tabs`: every test that opens a tab MUST close it in afterAll. URL markers `?sp_t<N>=`.
- `feedback-never-switch-user-tabs`: never activate Safari, switch, or navigate user tabs.

### Architectural risk to track during execution
The Phase 0 spike is genuinely uncertain. Best estimate: 70% chance both assumptions pass. Worst case (Approach 3 dies):
1. Move File construction to MAIN world with bytes shipped via fragmented postMessage (workable but adds complexity)
2. Abandon Approach 3 and accept a smaller cap with Approach 1 storage bus (~5 MB single-file)
3. Abandon page-side injection entirely and pursue AX-driven NSOpenPanel automation in the daemon (multi-week scope)

If Phase 0 fails, stop the plan; do not attempt a workaround inline. Open a follow-up design pass.
