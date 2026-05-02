# Checkpoint
*Written: 2026-05-02 13:42*

## Current Task
Phase 5A · Group A · **Chunk 1 CLOSED, verified GREEN against v0.1.21.** Next up: Chunk 2 = 5A.7 (HAR record & replay) → 5A.1 (T41 file upload) → REBUILD CHECKPOINT 2 (v0.1.22).

## Progress
- [x] **5A.3** right-click + middle-click + modifiers — `6ae37db` (TS-only sub-batch)
- [x] **5A.6** multi-element extraction — `e918ddf` (TS-only sub-batch)
- [x] **5A.4** xpath as first-class locator — `5de6d74` (TS-only sub-batch)
- [x] **5A.5** locator chaining (nth · filter) — `2824d53` (TS-only sub-batch)
- [x] **5A.8** cookies httpOnly via browser.cookies — `979be01` (chunk 1)
- [x] **5A.2** download saveAs post-process (TS-only standalone) — `bb7f4d4`
- [x] **5A.9** HTTP basic auth via DNR — `5104487` (chunk 1)
- [x] **REBUILD CHECKPOINT 1 v0.1.20** — built, signed, notarized
- [x] **v0.1.21 fix bundle** — manifest perm + cookie url-filter + 5A.9 e2e arch — `b0b5977`
- [x] **Chunk 1 e2e VERIFIED**: 4/4 cookies + 3/3 auth GREEN against v0.1.21 install
- [ ] **5A.7** HAR record & replay ← **NEXT (chunk 2)**
- [ ] **5A.1** T41 safari_file_upload (multi-day, full UPP brainstorm)
- [ ] → REBUILD CHECKPOINT 2 (v0.1.22)
- [ ] Phase 5A · Group B (5A.10–5A.14)

## Key Decisions (not yet persisted)
All decisions already persisted — see commits, ROADMAP.md § Phase 5A, this CHECKPOINT, and the v0.1.21 commit message which documents the three discovery learnings.

## Next Steps

### Chunk 2 — 5A.7 HAR record & replay
1. Read `src/tools/network.ts` (existing `safari_list_network_requests`, `safari_intercept_requests`, `safari_mock_request`) — that's the foundation. HAR adds: serialize captured requests as HAR 1.2 JSON; provide a `routeFromHAR` matching layer.
2. Investigate Safari Web Extension webRequest API support — what request lifecycle events are available. Likely needs extension changes (sentinels for capture-on/capture-off/dump-har/route-from-har).
3. UPP TDD per existing patterns:
   - failing unit test for HAR serialization (one captured request → HAR entry shape per spec 1.2)
   - reviewer gate
   - GREEN
   - failing unit test for `routeFromHAR` matcher (URL+method match → response shape)
   - reviewer gate
   - GREEN
   - e2e tests committed RED awaiting v0.1.22
4. Also requires extension build → defer to chunk-2 rebuild.

### Then 5A.1 T41 safari_file_upload
Multi-day. Full UPP pipeline: brainstorming → writing-plans → executing-plans. Per the original tracker entry T41. Native macOS file picker is the mechanism Safari uses — extension may not be the right tool; might need daemon/AppleScript/AXUIElement work. Decide architecture in brainstorm.

### Rebuild Checkpoint 2 (after 5A.7 + 5A.1 code-side complete)
- Bump package.json 0.1.21 → 0.1.22
- `bash scripts/build-extension.sh`
- User installs (`open "bin/Safari Pilot.app"`)
- Verify in Safari > Settings > Extensions
- Run e2e for 5A.7 + 5A.1

### Then Group B (no rebuild needed)
5A.10 T42, 5A.11 SD-32-followup, 5A.12 ROADMAP-flake, 5A.13 final Cluster 1-7 sweep, 5A.14 npm test:e2e:harness automation.

## Context

### Branch state
- on `main`, all pushed up to `b0b5977`
- Pre-existing untracked: `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock` — leave them alone

### Test state
- **305 unit tests** (was 268 at session start, +37 across all of Phase 5A Group A code so far)
- **24 new e2e tests** total in this Phase 5A · Group A:
  - 4 right-click (5A.3) ✓
  - 4 multi-extract (5A.6) ✓
  - 4 xpath (5A.4) ✓
  - 5 locator-chaining (5A.5) ✓
  - 4 cookies httpOnly (5A.8) ✓ verified v0.1.21
  - 3 HTTP basic auth (5A.9) ✓ verified v0.1.21
- T65 (phase3-3.1 form-submission flake) still open — confirmed pre-existing

### Active extension version
- **v0.1.21** installed and verified. Will bump to v0.1.22 at chunk-2 rebuild.

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

### Three new discovery learnings worth promoting (not yet in memory)
1. **`browser.cookies.getAll({})` returns incomplete set in Safari** — empty filter only surfaces HttpOnly cookies. Always pass `url` or `domain`.
2. **DNR `modifyHeaders` requires `declarativeNetRequestWithHostAccess`** — without it, `updateDynamicRules` accepts the rule but the action silently no-ops.
3. **Safari modal HTTP auth dialog blocks JS** — top-level navigation to a 401+WWW-Authenticate response leaves the tab in indeterminate state. e2e must use `fetch()` with `credentials:'omit'` to assert wire-level header behavior. (Add to memory before chunk 2 if HAR e2e involves auth-protected resources.)

### Sentinel pattern reference for chunk 2
HAR will follow the same sentinel pattern:
- T55a `__SP_LIST_FRAMES__` (extension/background.js:241)
- 5A.8 `__SP_COOKIE_*__` (extension/background.js ~290)
- 5A.9 `__SP_DNR_*__` (extension/background.js ~280)
- Future 5A.7: likely `__SP_HAR_RECORD_START__`, `__SP_HAR_DUMP__`, `__SP_HAR_ROUTE_FROM__`, `__SP_HAR_CLEAR__`

### Locked sequence reference
ROADMAP.md `Phase 5A` section has the full sequence with 3+2 cadence. Chunk 1 closed; chunk 2 starts with 5A.7.
