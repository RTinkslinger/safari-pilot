# Build Traces

## Project Summary
*No milestones yet.*

## Milestone Index
| # | Iterations | Focus | Key Decisions |
|---|------------|-------|---------------|

## Current Work

### Iteration 1 - 2026-04-12
**What:** Implemented Xcode project generation + extension packaging pipeline (Task 3.6)
**Changes:** `scripts/build-extension.sh` (created), `test/integration/extension-build.test.ts` (created), `.gitignore` (added .build/ and app/)
**Context:** safari-web-extension-packager uses `--project-location` not a second positional arg; generates project in `app/Safari Pilot/` subfolder (not directly in `app/`); packager auto-derives app bundle ID as `com.safari-pilot.Safari-Pilot` ignoring our `--bundle-identifier` flag — requires sed patch in pbxproj; packager references Icon.png but doesn't create it — needs placeholder; scheme name is "Safari Pilot" not "SafariPilot (macOS)"; xcodebuild succeeded after both fixes.
---

### Iteration 2 - 2026-04-13
**What:** Externalized all hardcoded config into safari-pilot.config.json + plugin commands for daemon lifecycle (first P0 roadmap item)
**Changes:** `src/config.ts` (created — typed config, loader, validator, deep-merge), `safari-pilot.config.json` (created — default config file), `src/security/rate-limiter.ts` (constructor accepts options), `src/security/circuit-breaker.ts` (constructor accepts options), `src/security/domain-policy.ts` (constructor accepts blocked/trusted/defaultMaxActionsPerMinute), `src/security/audit-log.ts` (added logPath), `src/engines/daemon.ts` (added timeoutMs option), `src/server.ts` (loads config, passes to all modules), `.claude-plugin/commands/start.md` (created), `.claude-plugin/commands/stop.md` (created), `.claude-plugin/plugin.json` (registered commands), `scripts/postinstall.sh` (added launchctl load), `test/unit/config.test.ts` (created — 15 tests), security test files (added config-specific tests)
**Context:** All module constants became instance properties with backwards-compatible defaults. DaemonEngine constructor changed from `string?` to `DaemonEngineOptions | string` for backwards compat with tests. Config loader uses SAFARI_PILOT_CONFIG env var → project root fallback → silent defaults. 746 tests pass. Zero new dependencies.
---
