# Checkpoint
*Written: 2026-04-20 18:15*

## Current Task
Production e2e rewrite is COMPLETE and merged to main. No active task.

## Progress
- [x] Phase 0: Daemon fix (extension_health routing + result unwrapping)
- [x] Phase 1: Extension engine smoke test gate (5/5 pass)
- [x] Phase 2: Test infrastructure (globalSetup, wake probe, engine assertion, vitest config, report collector)
- [x] Phase 3a: Core architecture files (engine-selection, extension-engine, security-pipeline)
- [x] Phase 3b: All remaining 14 e2e files rewritten
- [x] Degradation test (4 scenarios: kill-switch, circuit breaker, extension-unavailable, disconnect)
- [x] Documentation (ARCHITECTURE.md, CLAUDE.md corrected)
- [x] Security fixes: TabOwnership wired (registerTab after safari_new_tab), DomainPolicy enforced (blocked domains throw)
- [x] Storage bus IPC: debug logging removed, production-ready
- [x] Three adversarial audits completed, findings addressed
- [x] Code review passed, squash-merged to main, pushed to origin
- [ ] Extension .app rebuild (source changes to background.js/content-isolated.js not yet in the binary)
- [ ] GitHub Release (daemon binary + extension .app)

## Key Decisions (not yet persisted)
- Storage bus `{ok, value}` wrapper is unwrapped in daemon's `handleResult` (not in background.js) — keeps the storage format self-describing while the daemon delivers only the inner value to callers
- TabOwnership uses synthetic tabIds (windowId * 1000 + ownedCount+1) since AppleScript doesn't return real tab indices
- DomainPolicy: only EXPLICIT blocked list throws; sensitive patterns (banking) just throttle (30 req/min)
- IDPI Scanner is advisory-only (adds metadata, never blocks tool execution)
- `handleExecuteInMain` in background.js is dead code (legacy from pre-storage-bus era) — preserved but unreachable

## Next Steps
1. Rebuild extension: `bash scripts/build-extension.sh` (picks up debug cleanup + storage bus from source)
2. Verify extension works in Safari after rebuild
3. Tag release + push to GitHub Releases + npm publish
4. Consider roadmap items from audits: per-engine circuit breaker wiring, audit log disk persistence, IDPI scanner threshold tuning

## Context
- Branch: main (at 744a75c)
- Feature branch deleted: fix/e2e-test-tab-ownership
- Daemon already rebuilt with latest fixes (version 20260420120543)
- Extension binary in `bin/Safari Pilot.app` is STALE (has old debug logging, old IPC without storage bus fixes)
- 1428 unit tests pass, 91 e2e tests pass (19 files)
- safari-extension-learnings.md at ~/Claude Projects/ documents the IPC race conditions discovered
