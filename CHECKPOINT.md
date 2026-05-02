# Checkpoint
*Written: 2026-05-02 23:05*

## Current Task
Phase 5A · Group A · **Chunk 2 item 1 (5A.7 HAR record & replay) SHIPPED + verified GREEN against existing v0.1.21 install.** Next up: chunk 2 item 2 = 5A.1 T41 safari_file_upload (multi-day, full UPP brainstorm pipeline). Then REBUILD CHECKPOINT 2 → v0.1.22.

## Progress
- [x] **5A.3** right-click + middle-click + modifiers — `6ae37db`
- [x] **5A.6** multi-element extraction — `e918ddf`
- [x] **5A.4** xpath as first-class locator — `5de6d74`
- [x] **5A.5** locator chaining (nth · filter) — `2824d53`
- [x] **5A.8** cookies httpOnly via browser.cookies — `979be01` (chunk 1)
- [x] **5A.2** download saveAs post-process — `bb7f4d4`
- [x] **5A.9** HTTP basic auth via DNR — `5104487` (chunk 1)
- [x] **REBUILD CHECKPOINT 1 v0.1.20 + v0.1.21 fix bundle** — `b0b5977`
- [x] **5A.7** HAR record & replay (path B) — `ef1ab4f` `43b61e3` `39528f9` `545929b` `597b1b4` ← **chunk 2 item 1 SHIPPED**
- [ ] **5A.1** T41 safari_file_upload (multi-day, full UPP brainstorm) ← **NEXT (chunk 2 item 2)**
- [ ] → REBUILD CHECKPOINT 2 (v0.1.22) — only needed if 5A.1 requires extension/daemon code (likely yes)
- [ ] Phase 5A · Group B (5A.10–5A.14)

## Key Decisions (not yet persisted)
All decisions persisted — see commits, ROADMAP.md § Phase 5A, this CHECKPOINT, and TRACES.md iteration 49.

## Next Steps

### Chunk 2 item 2 — 5A.1 T41 safari_file_upload

Tracker entry: T41 safari_file_upload. Multi-day work warranting full UPP pipeline (brainstorming → writing-plans → executing-plans). Per the original tracker entry, the architecture decision is open:

1. **Native macOS file picker via AppleScript / AXUIElement**: Safari's `<input type=file>` triggers a native NSOpenPanel; programmatic dismissal + path injection requires AX scripting from the daemon. Most realistic for true compat with all upload sites, but requires daemon/Swift work.
2. **HTML File API injection from extension**: bypass the picker entirely by setting `input.files` from a Web Extension API, using a host-permission'd file:// read. Simpler but coverage is partial — sites that intercept `<input type=file>` click programmatically may still trigger the picker.
3. **Hybrid**: extension-side injection as the default (handles 90% of cases); fall back to AX-driven picker for sites where the input element isn't directly reachable.

Decision belongs in the brainstorm. The brainstorm should also cover:
- File path validation (security: don't allow uploading from arbitrary paths an agent passes; constrain to a sandbox dir or require explicit user-allowed roots)
- Multi-file uploads (single input vs multiple-attribute)
- Drag-drop uploads (separate code path; many sites use drag-drop instead of file picker)
- Test fixture: a multipart-receiving endpoint on fixture-server.ts that echoes uploaded content for assertion

Recommended sequence:
1. Invoke `upp:brainstorming` to nail the architecture, security model, and scope
2. `upp:writing-plans` for the implementation plan
3. `upp:executing-plans` to execute (likely a multi-task plan with daemon Swift + TS handler + extension code)

### Then REBUILD CHECKPOINT 2 (v0.1.22)
Only if 5A.1 ends up requiring extension or daemon code (very likely):
- Bump package.json 0.1.21 → 0.1.22
- `bash scripts/build-extension.sh`
- User installs (`open "bin/Safari Pilot.app"`)
- Verify in Safari > Settings > Extensions
- Run e2e for 5A.1

### Then Group B (no rebuild needed)
5A.10 T42, 5A.11 SD-32-followup, 5A.12 ROADMAP-flake, 5A.13 final Cluster 1-7 sweep, 5A.14 npm test:e2e:harness automation.

## Context

### Branch state
- on `main`, all commits pushed up to `597b1b4`
- Pre-existing untracked: `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock` — leave them alone
- Stash list: TWO stale stashes from 2026-04-16 `feat/file-download-handling` branch — irrelevant to current work, preserved for salvage. Do NOT `git stash pop` these in any composed `&&` command (one was accidentally popped this session, recovered cleanly).

### Test state
- **402 unit tests** (was 305 at start of chunk 2, +52 from 5A.7: 15 har-serialize + 21 har-route + 3 interceptor-smoke + 13 dispatch + others incidental)
- **27 new e2e tests** total in this Phase 5A · Group A:
  - 4 right-click (5A.3) ✓
  - 4 multi-extract (5A.6) ✓
  - 4 xpath (5A.4) ✓
  - 5 locator-chaining (5A.5) ✓
  - 4 cookies httpOnly (5A.8) ✓ verified v0.1.21
  - 3 HTTP basic auth (5A.9) ✓ verified v0.1.21
  - 3 HAR record/replay (5A.7) ✓ verified v0.1.21
- T65 (phase3-3.1 form-submission flake) still open — confirmed pre-existing

### Active extension version
- **v0.1.21** installed and verified. Will bump to v0.1.22 at chunk-2 rebuild ONLY if 5A.1 requires it.

### Memory rules to remember (load-bearing for next session)
- `feedback-debugging-discipline`: Use upp:systematic-debugging for any bug, never ad-hoc.
- `feedback-no-system-manipulation`: NEVER pluginkit/lsregister/pkill if Safari acts up.
- `reference-extension-enablement-workaround`: Develop > Allow Unsigned Extensions toggle for first-install enable.
- `feedback-extension-version-both-fields`: Bump package.json version BEFORE any extension rebuild.
- `feedback-never-open-app-without-version-bump`: Never `open bin/Safari Pilot.app` after rebuild without bumping first.
- `feedback-distribution-builds`: Source changes to `extension/*.js` must be followed by rebuild + sign + notarize.
- `feedback-e2e-means-e2e`: e2e tests use real processes/protocols/Safari; zero mocks.
- `feedback-e2e-tests-must-close-tabs`: Every test that opens a tab MUST close it in afterAll. URL markers `?sp_t<N>=`.
- `feedback-never-switch-user-tabs`: Never activate Safari, switch, or navigate user tabs.
- `reference-pdf-generation-sop`: PDF generation SOP at `~/.claude/rules/pdf-generation.md`.

### 5A.7 discovery (worth promoting if it recurs)
**The existing safari_intercept_requests + safari_mock_request infrastructure is engine-agnostic page-side TS, not extension routing.** CHECKPOINT predicted HAR would need extension changes; reading network.ts revealed the foundation was already complete. Saved a rebuild cycle. Lesson: read the source before classifying scope — checkpoint hand-offs can over-estimate dependency chains.

### Sentinel pattern reference
HAR did NOT need new sentinels because `__safariPilotNetwork` and `__safariPilotMocks` are page-side state, accessed by tag-team TS handlers. For 5A.1 file upload, the architecture decision will determine sentinel needs — extension-injection-based path would add `__SP_FILE_UPLOAD__` sentinel; daemon-AX-based path would need new daemon-side commands.

### Locked sequence reference
ROADMAP.md `Phase 5A` section has the full sequence with 3+2 cadence. Chunk 1 closed; chunk 2 item 1 (5A.7) closed; chunk 2 item 2 (5A.1) is next.
