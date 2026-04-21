# Checkpoint
*Written: 2026-04-22 02:00*

## Current Task
Fix bugs found during session testing. 9 bugs documented. Use `upp:systematic-debugging` to address them in priority order.

## Resume File
**Read this first:** `docs/upp/bugs/2026-04-22-session-test-findings.md`

Contains all 9 bugs with root cause analysis, file locations, severity, observed behavior, and fix suggestions. Prioritized.

## Progress
- [x] Tab Ownership by Identity — plan executed (branch `feat/tab-ownership-by-identity`)
- [x] Telemetry system — 15 trace points across TS/Swift/JS (branch `feat/telemetry`)
- [x] Persistent Session Tab — spec + plan + execution (branch `feat/persistent-session-tab`)
- [x] Version sync fix — manifest.json synced from package.json
- [x] Alarm keepalive fix — clear-then-create + verify on boot
- [x] /health HTTP route added for session dashboard
- [x] Window ID tracking for per-session windows
- [x] Cross-domain ownership fix (domainMatches removed)
- [x] keepalive → handleConnected fix
- [x] Session test (2 headless CC sessions, 3 tasks each) — completed, bugs documented
- [ ] **Fix Bug 1+2: Dynamic extension availability (ROOT CAUSE)**
- [ ] Fix Bug 5: /status HTTP serialization
- [ ] Fix Bug 3+4: Window targeting discipline
- [ ] Fix Bug 6: Storage bus timeout after navigation
- [ ] Fix remaining bugs (7, 8, 9)

## Key Decisions
1. Extension engine should be the DEFAULT — engine selector already prefers it. The blocker is stale `engineAvailability`.
2. Session tab architecture is correct — keepalive works, dashboard works. The bootstrap just never fires (chicken-and-egg: Bug 2).
3. Daemon fallback works reliably — all tasks completed via AppleScript. The extension pipeline adds `_meta` identity but isn't required for basic operation.

## Next Steps
1. Read `docs/upp/bugs/2026-04-22-session-test-findings.md`
2. Invoke `upp:systematic-debugging` for Bug 1+2 (dynamic extension availability)
3. The fix: either refresh `engineAvailability` per-call, or restructure so `ensureExtensionReady()` runs BEFORE engine selection and updates availability
4. After Bug 1+2: fix Bug 5 (/status serialization), then Bug 3+4 (window targeting)
5. Re-run the same 2-session test to verify

## Context
- **Branch:** `feat/persistent-session-tab` (from `feat/telemetry` from `feat/tab-ownership-by-identity` from `main`)
- **HEAD:** `1134a48` (keepalive→handleConnected fix)
- **Version:** 0.1.10 (package.json, manifest.json, extension all synced)
- **Daemon:** rebuilt with /status, /session, /health, keepalive handling, MCP tracking
- **Extension:** v0.1.10 in Safari, enabled, keepalive content script + alarm backup
- **Test results:** Both sessions completed tasks via daemon fallback. Extension engine never used (Bug 1+2). Session tab opened but wasn't used for window targeting (Bug 3). Some task tabs opened in wrong windows (Bug 3+4).
- **Bugs file:** `docs/upp/bugs/2026-04-22-session-test-findings.md` — READ THIS TO RESUME
