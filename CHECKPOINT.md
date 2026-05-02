# Checkpoint
*Written: 2026-05-02 11:25*

## Current Task
Phase 5A · Parity Closure (Clusters 1–7) — extension sub-batch chunk 1: starting **5A.8 cookies httpOnly via browser.cookies extension API**. TS-only sub-batch (5A.3 + 5A.6 + 5A.4 + 5A.5) is COMPLETE. Resuming after context compaction.

## Progress
- [x] **T60** dormancy fix (extension structural — pollLoop decoupled from wake lock) — `8b3147d`
- [x] **T55a** frame-aware storage bus — verified 8/9 e2e GREEN, 9th is T64 build-mode (RESOLVED-AS-DOCUMENTED)
- [x] **T64** filed as build-mode dependency, not bug
- [x] **Phase 5A** drafted into `docs/ROADMAP.md` — `d10b1f9`, sequence locked `7664d33`, cadence revised to 3+2 chunks `23f1acc`
- [x] Phase 5A · Group A · TS-only sub-batch (no Safari install needed):
  - [x] **5A.3** right-click + middle-click + modifiers — `6ae37db`
  - [x] **5A.6** multi-element extraction native API — `e918ddf`
  - [x] **5A.4** xpath as first-class locator — `5de6d74`
  - [x] **5A.5** locator chaining (nth · filter) — `2824d53`
- [x] PDF generation SOP captured at `~/.claude/rules/pdf-generation.md` — auto-loaded every session
- [x] Parity-matrix PDF generated at `~/Claude Projects/Documents/safari-pilot-vs-playwright-parity.pdf`
- [ ] Phase 5A · Group A · Extension sub-batch chunk 1 (3 items → rebuild + install + e2e):
  - [ ] **5A.8** cookies httpOnly via `browser.cookies` ← **NEXT**
  - [ ] **5A.2** download API parity
  - [ ] **5A.9** HTTP basic / digest auth
  - [ ] → REBUILD CHECKPOINT 1: build-extension.sh (v0.1.20), sign + notarize + staple, user installs, run e2e for 5A.8/2/9
- [ ] Phase 5A · Group A · Extension sub-batch chunk 2 (2 items → rebuild + install + e2e):
  - [ ] **5A.7** HAR record & replay
  - [ ] **5A.1** T41 safari_file_upload (multi-day, full UPP brainstorm)
  - [ ] → REBUILD CHECKPOINT 2: build-extension.sh (v0.1.21), sign + notarize + staple, user installs, run e2e for 5A.7/1
- [ ] Phase 5A · Group B (after Group A closes): 5A.10–5A.14

## Key Decisions (not yet persisted)
All decisions already persisted — see `docs/ROADMAP.md` § Phase 5A (locked sequence + 3+2 cadence) and `docs/TRACKER.md`.

## Next Steps

### Resume action (post-compaction)
**Start 5A.8 cookies httpOnly.** Plan summary:

1. **Read context**:
   - `src/tools/storage.ts:261-405` — `handleGetCookies`, `handleSetCookie`, `handleDeleteCookie` currently use `document.cookie` (excludes httpOnly).
   - `extension/background.js:443-456` — `handleCommand` already routes `cookie_get`/`cookie_set`/`cookie_remove`/`cookie_get_all` via `browser.cookies` API.
   - `extension/background.js:227` — existing `__SP_LIST_FRAMES__` sentinel pattern (T55a) is the model: background.js intercepts a sentinel script string before forwarding to content scripts.

2. **Approach**:
   - Add new sentinel(s) to `extension/background.js executeCommand`:
     - `__SP_COOKIE_GET_ALL__:<json-params>` → calls `handleCookieGetAll` directly, returns via storage bus
     - `__SP_COOKIE_SET__:<json-params>` → calls `handleCookieSet` directly
     - `__SP_COOKIE_REMOVE__:<json-params>` → calls `handleCookieRemove` directly
   - In `src/tools/storage.ts`: when extension engine is available, dispatch via the sentinel (gets full `browser.cookies` API including httpOnly). Otherwise fall back to existing `document.cookie` path.
   - Schema: no surface change — same params, just deeper extraction.

3. **TDD per UPP**:
   - Failing tests at `test/unit/tools/storage-cookies-extension-bridge.test.ts` — assert handler dispatches the right sentinel script when engine.name === 'extension'; falls back to document.cookie when not.
   - Test-reviewer (full mode) before GREEN.
   - E2E at `test/e2e/5A8-cookies-httponly.test.ts` — gated until rebuild checkpoint.

4. **Mark e2e as `// 5A.8 — pending v0.1.20 install, do not skip; intentionally on-disk RED**` until rebuild checkpoint runs.

### After 5A.8: 5A.2 download API parity, 5A.9 HTTP basic auth — same TDD flow each. All three commit code+unit tests, e2e committed RED awaiting rebuild.

### When all 3 chunk-1 items shipped (code-side):
- `bash scripts/build-extension.sh` — v0.1.20 build (bump `package.json` version 0.1.19 → 0.1.20 first per memory `feedback-extension-version-both-fields`).
- `open "bin/Safari Pilot.app"` — user confirms enable in Safari.
- Run all 3 chunk-1 e2e suites against release-mode build.
- If any fail: investigate per item, do NOT batch-fix.

## Context

### Branch state
- on `main`, ahead of `origin/main` by 0 (all pushed at `23f1acc`)
- Working tree clean except pre-existing untracked: `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`, `.claude/scheduled_tasks.lock`

### Test state
- **268 unit tests** (was 220 at session start, +48)
- **13 new e2e tests** this session, all green on release-mode build (4 right-click + 4 multi-extract + 4 xpath + 5 locator-chaining... wait, 4+4+4+5 = 17. Actually: 5A.3 = 4 e2e, 5A.6 = 4 e2e, 5A.4 = 4 e2e, 5A.5 = 5 e2e. Total = **17 new e2e** all green.)
- Pre-existing flake T65 (phase3-3.1 form-submission TAB_NOT_FOUND) — confirmed pre-existing, filed in tracker, not blocking

### Active extension version
- v0.1.19 installed (T60 fix). Will bump to v0.1.20 at chunk-1 rebuild checkpoint.

### Memory rules to remember (load-bearing for next session)
- `feedback-debugging-discipline`: Use `upp:systematic-debugging` for any bug; never ad-hoc.
- `feedback-no-system-manipulation`: NEVER pluginkit/lsregister/pkill if Safari acts up.
- `reference-extension-enablement-workaround`: Develop > Allow Unsigned Extensions toggle for first-install enable.
- `feedback-extension-version-both-fields`: Bump package.json version BEFORE any extension rebuild.
- `feedback-never-open-app-without-version-bump`: Never `open bin/Safari Pilot.app` after rebuild without bumping first.
- `feedback-distribution-builds`: Source changes to `extension/*.js` must be followed by rebuild + sign + notarize + release.
- `feedback-e2e-means-e2e`: e2e tests use real processes/protocols/Safari; zero mocks.
- `feedback-e2e-tests-must-close-tabs`: Every test that opens a tab MUST close it in afterAll. URL markers `?sp_t<N>=`.
- `feedback-never-switch-user-tabs`: Never activate Safari, switch, or navigate user tabs.
- `reference-pdf-generation-sop`: PDF generation SOP at `~/.claude/rules/pdf-generation.md`.

### Sentinel pattern reference for extension batch
The T55a `__SP_LIST_FRAMES__` sentinel in `extension/background.js:227-248` is the model template for cookie/HAR/HTTP-auth/file-upload sentinels. Each sentinel:
1. Intercepted in `executeCommand` BEFORE the storage-bus forward to content scripts
2. Parses params from the sentinel script string
3. Calls the appropriate background handler (already implemented in many cases — see `extension/background.js:443-456`)
4. Returns via storage bus (same path as regular results)

### TRACES.md
Updated with iteration 47 covering this session's full scope (T60 + T55a verify + Phase 5A draft + 4 Group A items). See "Current Work" section.

### Locked sequence reference
ROADMAP.md `Phase 5A` section (lines ~135-200) has the full sequence with 3+2 cadence. Read that section first thing on resume.
