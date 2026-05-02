# Checkpoint
*Written: 2026-05-03 03:25*

## Current Task
Phase 5A · 5A.1 `safari_file_upload` — `upp:executing-plans` IN PROGRESS on `feat/file-upload` branch. **6 of 21 tasks complete**: Phase 0 GATING + Phase 1 TS foundations + Phase 2 TS handler. Next is Task 7 (Swift `FileStagingStore` actor — first daemon-side task).

## Progress

### Phase 5A · 5A.1
- [x] **Task 1** Phase 0 spike scaffolding (extension JS) — `9e67332` + `cad67de`
- [x] **Task 2** Phase 0 spike e2e tests (RED until v0.1.22) — `8ff3153` + `e6eb3fd`
- [x] **Task 3** 10 FileUpload error codes + subclasses — `a234937`
- [x] **Task 4** `src/tools/mime.ts` (8 tests) — `8a9776f`
- [x] **Task 5** `src/path-resolve.ts` + `findClosestSibling` (13 tests) — `df79f90` + `e736399`
- [x] **Task 6** `src/tools/file-upload.ts` handler + server registration (18 dispatch tests) — `0a0662b` + `90aa71f` (architectural fix)
- [ ] **Task 7** Swift `FileStagingStore` actor + Swift unit tests ← **NEXT** (first daemon Swift task)
- [ ] **Tasks 8–10** Daemon Swift continued (stage_file NDJSON command, /file-bytes routes, TTL cleanup)
- [ ] **Tasks 11–13** Extension JS (background sentinels, content-isolated bytefetch+DELETE, content-main DataTransfer injection)
- [ ] **Task 14** Fixture endpoints (/upload-fixture, /upload-validate)
- [ ] **Tasks 15–18** E2E suite (core, RHF, edge, concurrency)
- [ ] **Task 19** v0.1.22 release (USER GATE — manual `open "bin/Safari Pilot.app"`)
- [ ] **Tasks 20–21** Smoke + docs

## Key Decisions (already persisted in TRACES.md iter 51)

All major decisions captured in iteration 51 entry (rolling-window log). Highlights from this session:

- **Task 6 architectural fix (`90aa71f`)**: `FileUploadTools` constructor now takes `(engine: IEngine, daemon: DaemonEngine)`. Plan's `engine.execute({cmd: ...})` doesn't typecheck (IEngine.execute only takes string). Plan's runtime path (eval JSON string as JS in tab) doesn't reach daemon. Fix: `daemon.command('stage_file', {token, mimeType, bytesB64})` via existing `DaemonEngine.command()` at `src/engines/daemon.ts:100`. Tasks 7-9 (daemon stage_file route + /file-bytes) will receive these NDJSON commands.

- **Task 5 plan-bug fix**: NUL-byte check (`'\x00'`) instead of space — macOS paths legitimately contain spaces.

- **Task 2 plan-bug fix**: Use fixture-server origin instead of `about:blank` — content scripts don't inject on `about:` URLs under `<all_urls>`.

- **7 plan documentation errors caught and corrected** in Tasks 1-6 (full list in TRACES.md iter 51). Plan author should be informed for Tasks 7+ to reduce correction overhead.

## Next Steps

### Resume at Task 7 (Swift `FileStagingStore` actor)

The plan section is at lines 1679+ of `docs/upp/plans/2026-05-03-safari-file-upload-plan.md`. This is the FIRST daemon Swift task. Task 7 implements the actor-based token-keyed file staging store; Task 8 wires it into the NDJSON command dispatcher (where the `daemon.command('stage_file', ...)` calls from Task 6 will land); Tasks 9-10 expose HTTP routes + TTL cleanup.

```
Skill tool → upp:executing-plans
args: docs/upp/plans/2026-05-03-safari-file-upload-plan.md (subagent mode)
```

When resuming:
1. Verify branch state: `git status` clean on `feat/file-upload`, ~12 commits ahead of `main`
2. TaskList: Tasks 63-77 still pending (Task 7 = #63, Task 8 = #64, etc.). Tasks 57-62 marked completed.
3. Continue from Task 7 onward.

### Tasks 7-10 are Swift — different verification rhythm

The daemon side uses Swift / `daemon/Sources/` files and `daemon/Tests/` for unit tests. The build and test commands differ:
- Build: `bash scripts/update-daemon.sh` (rebuild + atomic swap + launchctl restart)
- Tests: `swift test` from `daemon/` directory
- TS unit tests don't exercise daemon Swift — daemon Swift tests are in Swift

Reviewer dispatches will need Swift test result evidence, not vitest.

### TASK 8 PREREQUISITES (folded findings from Task 6 fix)

When Task 8 wires `stage_file` into `daemon/Sources/.../CommandDispatcher.swift`, the NDJSON command shape is the one Task 6 ships:
```
{ "cmd": "stage_file", "token": "<64-char hex>", "mimeType": "<string>", "bytesB64": "<base64>" }
```

(NOT `cmd: 'stage_file'` with `cmd` lowercase as a JSON key for Swift's Codable; verify the command-dispatcher Codable wrapper format. Existing daemon commands like `extension_health` should give the canonical pattern.)

The response shape Task 6's TS handler expects from `daemon.command('stage_file', ...)`:
```
{ ok: true, value?: any }
```
Match `EngineResult` shape — `command()` returns this in its existing contract. See `src/engines/daemon.ts:100-145`.

### TASK 6 NON-BLOCKING DEFERRALS (still apply)

From Task 3 reviewer (deferred to Task 6 — but Task 6 didn't fold them in; defer to a follow-up or Task 21 docs commit):

1. Add named constant exports to `src/errors.ts`:
   ```typescript
   export const FILE_UPLOAD_SIZE_CAP = 26_214_400;  // 25 MiB
   export const FILE_UPLOAD_MAX_FILES = 4;
   ```
   Currently `CAP_BYTES = 25 * 1024 * 1024` is inline in `src/tools/file-upload.ts:24`. Acceptable since both files agree on the value, but a named export prevents drift if Task 17 needs the same constant for tests.

2. Add hints to two empty-hints error classes:
   - `FileUploadPathNotReadableError.hints` (currently `[]`)
   - `FileUploadInvalidParamsError.hints` (currently `[]`)

3. From Task 4 reviewer (deferred): `text/rust` → `text/x-rust` in `src/tools/mime.ts` for table consistency.

These are all 1-line cleanups suitable for a Task 21 polish commit.

### Hard gates encoded in the plan (still apply)

1. **Phase 0 e2e tests run FIRST in Phase 7 step 7** — architectural gate. Both must pass or 5A.1 ABORTS.
2. **Version bump before rebuild** — `package.json` + `extension/manifest.json` both at 0.1.22 BEFORE `update-daemon.sh` or `build-extension.sh`.
3. **User installs `.app` manually** — agent never invokes system tools.
4. **TDD reviewer gate per task** — test-reviewer-fast for ≤3 tests, test-reviewer for >3.

## Context

### Branch state
- on `feat/file-upload`, ~12 commits ahead of `main`
- last commit: `90aa71f fix(5A.1 phase-2): inject DaemonEngine — runtime path for stage_file NDJSON`
- working tree clean
- pre-existing untracked files (leave alone): `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock`

### Test state going into Task 7
- **402 + 6 + 8 + 13 + 18 = 447 unit tests passing**
- **27 + 2 = 29 e2e tests** (Task 2 added 2 RED-by-design until v0.1.22)
- All non-spike e2e tests still GREEN against v0.1.21 install

### Active extension version
- **v0.1.21** installed and verified
- Will bump to **v0.1.22** at Phase 7 (Task 19)

### 5A.1 spec + plan locations
- Spec: `docs/upp/specs/2026-05-03-safari-file-upload-design.md` (final commit `8a670e7`)
- Plan: `docs/upp/plans/2026-05-03-safari-file-upload-plan.md` (commit `6a974bf`, 21 tasks, 3273 lines)

### Memory rules (load-bearing for execution)
- `feedback-debugging-discipline`: use `upp:systematic-debugging` for any bug
- `feedback-no-system-manipulation`: NEVER invoke system tools to manipulate extension state
- `feedback-extension-version-both-fields`: bump package.json AND extension/manifest.json BEFORE rebuild
- `feedback-never-open-app-without-version-bump`
- `feedback-distribution-builds`: source changes → rebuild + sign + notarize
- `feedback-e2e-means-e2e`: zero mocks in test/e2e/
- `feedback-e2e-tests-must-close-tabs`: URL markers `?sp_t<N>=`
- `feedback-never-switch-user-tabs`

### Architectural risk to track during execution
The Phase 0 spike is genuinely uncertain (~70% confidence). If Phase 7 Task 19 reveals it fails:
1. Move File construction to MAIN world with bytes via fragmented postMessage
2. Abandon Approach 3 → smaller cap with Approach 1 storage bus (~5 MB)
3. Pursue AX-driven NSOpenPanel automation in daemon (multi-week)

If Phase 0 fails, stop the plan; do not workaround inline. Open a follow-up design pass.
