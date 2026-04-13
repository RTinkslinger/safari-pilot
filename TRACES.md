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
**Changes:** `src/config.ts` (created), `safari-pilot.config.json` (created), all security modules (constructor options), `src/server.ts` (loads config), `.claude-plugin/commands/` (start.md, stop.md), `scripts/postinstall.sh` (3-path fallback), `test/unit/config.test.ts` (17 tests)
**Context:** All module constants became instance properties with backwards-compatible defaults. Config loader: env var → project root → silent defaults. Deep-merge, validation, deep-freeze. Sensitive domain protections immutable.
---

### Iteration 3 - 2026-04-13
**What:** Code review fixes (3 critical, 5 warnings), distribution pipeline hardening, enforcement hooks, full adversarial audit
**Changes:** `src/security/domain-policy.ts` (guard against config overriding sensitive domains), `src/config.ts` (assertSection for null handling, deep-freeze, unknown key rejection, removed dead fields), `src/server.ts` (health check timeout as parameter not module global), `scripts/postinstall.sh` (rewritten: pre-built → source → GitHub Releases download, no Xcode dependency), `.github/workflows/release.yml` (stable-URL archive), `hooks/safari-pilot-guard.sh` (created — hard-blocks dangerous commands), `hooks/distribution-check.sh` (created — pipeline reminders on file edits), `.claude/settings.json` (created — registers enforcement hooks), `CLAUDE.md` (distribution paths + extension build hard rules), `README.md` (config section, daemon commands), `test/integration/cross-version.test.ts` (updated for download-fallback behavior)
**Context:** Reconstructed full v0.1.1-v0.1.3 disaster timeline from JSONL logs (13 missteps). Codified 7 hard rules in CLAUDE.md. Enforcement hooks block pluginkit/lsregister/manual codesign/pkill Safari and inject distribution reminders. Three-persona model documented. CI green (852 tests). PR #1 merged.
---

### Iteration 4 - 2026-04-13
**What:** Implemented P0 accessibility snapshots, auto-waiting, and P1 locator targeting — three major roadmap items in one session
**Changes:** `src/aria.ts` (created — Playwright-compatible ARIA tree with refs, role/name computation, data-sp-ref stamping), `src/auto-wait.ts` (created — actionability checks: visible/stable/enabled/editable/receivesEvents, rAF-based stability, backoff retry), `src/locator.ts` (created — role+name/text/label/testId/placeholder resolution with CSS pre-filter), `src/tools/extraction.ts` (snapshot rewritten to use aria.ts, ref+locator params on get_text/get_html/get_attribute), `src/tools/interaction.ts` (all 10 handlers: resolveElement priority ref>locator>selector, waitAndExecute with auto-wait, force option, selector no longer required), `test/unit/aria.test.ts` (152 tests), `test/unit/auto-wait.test.ts` (99 tests), `test/unit/locator.test.ts` (106 tests), `test/unit/tools/interaction.test.ts` (updated for new schemas + auto-wait mock pattern), `test/unit/tools/extraction.test.ts` (updated)
**Context:** Three parallel sub-agents wrote core modules simultaneously. safari_type.text renamed to content, safari_select_option value/label/index renamed to optionValue/optionLabel/optionIndex to avoid collision with locator params. computedRole/computedName (Safari 16.4+) used with full fallback chains. 1590/1591 tests pass (1 pre-existing flaky e2e benchmark).
---
