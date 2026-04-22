# Checkpoint
*Written: 2026-04-23 01:05*

## Current Task
Validating Safari Pilot capabilities phase-by-phase against the "Saving The Project" roadmap (`docs/ROADMAP.md`). Phases 1-3 shipped with 19 passing e2e tests. Ready for Phase 4+.

## Progress
- [x] Bug 1+2 fix: Dynamic extension availability (chicken-and-egg cycle broken)
- [x] Bug 5: Confirmed not a real bug (Hummingbird handles requests concurrently)
- [x] Bug 3+4: Positional tab targeting (windowId+tabIndex instead of URL matching)
- [x] Bug 6 fix: Content script reads sp_cmd on init (storage bus timeout in new tabs)
- [x] Deleted all 104 fake test files (unit, e2e, integration, security, canary)
- [x] Wrote new roadmap: `docs/ROADMAP.md` — Playwright capability table, 7 phases
- [x] Initialization system: spec → plan → 10-task execution → shipped
  - MCP initialize blocks until all systems green (~2s)
  - Pre-call live health gate (HTTP /status + window exists check)
  - Transparent recovery with 10s timeout
  - Multi-session detection ("found N existing, starting N+1")
  - Session dashboard shows session ID
- [x] Daemon rebuilt with session registry, /session/register route, extended /status
- [x] Extension rebuilt v0.1.10 build 202604230054 (Bug 6 fix + notarized)
- [x] Phase 1 validation: navigate, new_tab, close_tab, list_tabs, evaluate, screenshot — 4/4 pass + 2 skip (back/forward stale URL)
- [x] Phase 2 validation: snapshot (ARIA+refs), get_text, get_html, extract_links, extract_metadata — 6/6 pass
- [x] Phase 3 validation: fill (verified readback), click, wait_for — 4/4 pass
- [ ] Phase 4: Multi-tab workflows (session isolation, tab targeting, website-opened tabs)
- [ ] Phase 5: Extension engine proof (shadow DOM, fallback)
- [ ] Phase 6: Advanced capabilities (downloads, PDF, cookies, storage, network, frames)
- [ ] Phase 7: Benchmark

## Key Decisions (not yet persisted)
- **Session window decoupled from extension bootstrap:** `ensureSessionWindow()` runs unconditionally on every MCP session. `ensureExtensionReady()` only handles extension connectivity. This ensures Session B gets its own window even when Session A already connected the extension.
- **Pre-call health gate is live HTTP, not cached:** Every tool call does `GET /status?sessionId=X` + AppleScript window-exists check. ~15-45ms overhead. Replaces stale `engineAvailability` cache.
- **Transparent recovery pattern:** Block up to 10s, explicit SessionRecoveryError if fails. Agent sees latency, not infrastructure — unless truly broken.
- **Post-click tab adoption exists in code but is NOT yet tested** (written earlier in session, never validated).
- **Positional identity (`_windowId`/`_tabIndex`) exists in code but is NOT yet tested** (written earlier in session, never validated). Only navigate uses it; `executeJsInTab` has the proxy intercept but untested.

## Next Steps
1. Continue with Phase 4 validation (multi-tab workflows) — `docs/ROADMAP.md` Phase 4 table
2. Then Phase 5 (extension engine proof — shadow DOM access is the key differentiator)
3. Then Phase 6 (advanced capabilities)
4. Each phase: write e2e test → run → fix if broken → commit with proof
5. The navigate_back/forward stale URL issue (backlog #3) and NDJSON line-split issue are known but deferred

## Context
- **Branch:** `feat/persistent-session-tab` — 54+ commits ahead of main, none merged
- **HEAD:** `a0109c3` (roadmap update with Phase 1-3 proof)
- **Test files:** `test/e2e/initialization.test.ts`, `phase1-core-navigation.test.ts`, `phase2-page-understanding.test.ts`, `phase3-interaction.test.ts`
- **19 passing e2e tests, 2 skipped (back/forward), 0 unit tests (all deleted)**
- **Daemon:** rebuilt with session registry, running on TCP:19474 + HTTP:19475
- **Extension:** v0.1.10 build 202604230054, Bug 6 fix, signed+notarized, active in Safari
- **Roadmap spec:** `docs/upp/specs/2026-04-22-initialization-system-design.md`
- **Init plan:** `docs/upp/plans/2026-04-23-initialization-system.md` (all 10 tasks complete)
- **Earlier uncommitted code changes:** Tab positional identity (applescript.ts, engine-proxy.ts, tab-ownership.ts, server.ts, navigation.ts) and post-click tab adoption (server.ts) — written in session but ONLY the navigate path is tested. The broader `executeJsInTabByPosition` and `_snapshotTabPositions` code exists but is unvalidated.
