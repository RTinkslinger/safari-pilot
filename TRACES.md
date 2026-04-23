# Build Traces

## Project Summary
- **Milestone 1 (iter 1-3):** Extension build pipeline, config externalisation, distribution hardening, enforcement hooks
- **Milestone 2 (iter 4-6):** P0 accessibility/ARIA/auto-wait/locator, benchmark fixture server, benchmark reporter. Fixed type contract mismatches in types.ts (enginesUsed, perTask, evalDetails).
- **Milestone 3 (iter 7-9):** MCP STDIO transport fix (was never wired), benchmark suite (120 tasks, CLI runner), real e2e tests (45 tests, zero mocks), locator IIFE + URL trailing-slash bugs fixed, e2e enforcement hooks, first real baseline 37.8%

## Milestone Index
| # | Iterations | Focus | Key Decisions |
|---|------------|-------|---------------|
| 1 | 1-3 | Extension pipeline + config + hardening | Three-persona distribution model; codesign via xcodebuild only; enforcement hooks |
| 2 | 4-6 | ARIA/auto-wait/locator + benchmark foundation | enginesUsed→Record<string,number>; perTask→Record<string,PerTaskSummary>; flakiness threshold 0.2-0.8 |
| 3 | 7-9 | MCP fix + benchmark suite + real e2e + baseline | MCP Server+StdioServerTransport in index.ts; --tools ToolSearch blocks Bash/WebFetch; e2e=spawn real processes; ID-based MCP response matching; generateLocatorJs emits raw body not IIFE |

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

### Iteration 10 - 2026-04-14
**What:** P1 File Download Handling — full feature: spec, plan, 10-task subagent-driven implementation, code review, adversarial audit, all fixes
**Changes:** `daemon/Sources/SafariPilotdCore/DownloadWatcher.swift` (created — 628 lines, FSEvents + DispatchSource hybrid), `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` (added watch_download case), `src/tools/downloads.ts` (created — 456 lines, daemon primary + plist polling fallback + inline render + sheet detection), `src/tools/interaction.ts` (click context capture: href, download attr via closest('a')), `src/server.ts` (keyed ClickContext Map, getDaemonEngine, DownloadTools registration), `src/engines/daemon.ts` (command() method for arbitrary daemon commands, fixed trimEnd on objects), `src/types.ts` (ClickContext interface), `src/benchmark/fixture-server.ts` (download endpoints, sanitized Content-Disposition), `vitest.config.ts` (fileParallelism: false), `test/unit/tools/downloads.test.ts` (20 tests), `test/unit/tools/interaction-download-context.test.ts` (3 tests), `test/integration/download-plist.test.ts` (5 tests), `test/e2e/downloads-via-mcp.test.ts` (3 tests — real download verified on disk), `benchmark/tasks/downloads/` (6 tasks), `benchmark/fixtures/downloads/` (3 fixtures)
**Context:** Subagent-driven development: 10 implementation tasks dispatched to fresh agents, 2-stage review (spec compliance + code quality) after each. Code review found 2 critical (timer leak, double-close fds) + adversarial audit found 2 more critical (daemon path dead — trimEnd on objects, FSEvents nil guard). All 14 critical+important findings fixed. Key discoveries: (1) Safari blocks downloads from direct URL navigation but allows them from same-origin `<a download>` clicks, (2) plist reading needs python3 plistlib not plutil (binary bookmark data breaks JSON conversion), (3) download permission sheet detectable via System Events `count of sheets of front window`, (4) daemon probe overhead means FSEvents starts after download completes — quickDirectoryCheck catches this, (5) e2e test flakiness was vitest file parallelism competing for Safari tabs. 21 commits, 22 files, +2500 lines. 1299 unit + 5 integration + 48 e2e tests all green.
---

### Iteration 11 - 2026-04-14
**What:** P1 PDF Generation — WKWebView.createPDF, page ranges via PDFKit, margin/scale via CSS injection
**Changes:** `daemon/Sources/SafariPilotdCore/PdfGenerator.swift` (375 lines), `src/tools/pdf.ts` (550 lines), plus gates, fixtures, 73 unit + 5 integration + 3 e2e tests
**Context:** Major bug: NSPrintOperation.run() with WKWebView enters infinite spool loop. Fixed with createPDF API. Code review + adversarial audit found 3 critical + 5 important, all fixed.
---

### Iteration 12 - 2026-04-14
**What:** Bug fixes: click navigation via el.href, Shadow DOM slot traversal in aria.ts, health check accepts "2.0", ExtensionEngine wired in server init (never was before)
**Changes:** `src/aria.ts` (slot.assignedNodes traversal — Reddit 82→18178 chars), `src/tools/interaction.ts` (click nav fix), `src/server.ts` (ExtensionEngine created+checked)
**Context:** CRITICAL DISCOVERY: Extension engine had NEVER been functional. SafariWebExtensionHandler was an Xcode stub. Three-tier engine model was always two-tier. User demanded full audit.
---

### Iteration 13 - 2026-04-15
**What:** Full 547-step architecture fix — 15 phases. Daemon TCP socket, handler TCP proxy, in-memory command queue, IEngine interface unification, 12 tool module refactor, selectEngine wired into execution path, all 9 security layers wired, 14 e2e test files rewritten from scratch.
**Changes:** `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift` (created), `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (rewritten with in-memory queue), `extension/native/SafariWebExtensionHandler.swift` (TCP proxy), `app/Safari Pilot/Safari Pilot Extension/Safari Pilot Extension.entitlements` (+network.client), `src/engines/engine.ts` (IEngine + executeJsInTab), `src/engines/daemon.ts` + `src/engines/extension.ts` (implementations), 12 tool files (IEngine type), `src/server.ts` (selectEngine wired, all 9 security layers), `extension/background.js` (daemon proxy response format), 14 new e2e test files, `CLAUDE.md` (+Ways of Working + tool count 76), `ARCHITECTURE.md` (canonical source created), `scripts/build-extension.sh` (custom handler copy, python3 pbxproj injection)
**Context:** Previous state: extension was a stub, engine selection was dead code, 3 security layers unused. Fixed everything structurally. Adversarial audit found 3 critical + 3 important issues — all addressed. 1378 unit tests, 74 e2e tests, 41 daemon tests all passing.
---

### Iteration 14 - 2026-04-16
**What:** RCA + fixes for benchmark failures + discovered extension never worked (stale DerivedData build + service worker suspension)
**Changes:** `src/engines/daemon.ts` (TCP reuse for LaunchAgent daemon, settle guard, 200ms probe), `src/engines/engine-proxy.ts` (created — routes tool calls through selected engine), `src/server.ts` (EngineProxy wired, __engine embedded in text content), `src/benchmark/runner.ts` (preflight probes real engines), `src/benchmark/stream-parser.ts` (recursive _meta search, __engine fallback, tool_use_id correlation), `src/benchmark/reporter.ts` (architecture report section), `CLAUDE.md` (honest ScreenshotRedaction)
**Context:** ROOT CAUSES: (1) Benchmark preflight hardcoded `healthyEngines: ['applescript','daemon']` — extension tasks always skipped. (2) Claude CLI strips `_meta` from stream-json — benchmark could never see engine metadata. (3) Extension in Safari was from stale DerivedData debug build (April 13), not bin/ — every rebuild was ignored. (4) EngineProxy was missing — selectEngine result only stamped metadata, tools always used AppleScriptEngine from constructor. (5) Full benchmark: 42.2% (38/90) but with broken extension.
---

### Iteration 15 - 2026-04-16
**What:** Discovered extension runtime does not execute commands — service worker suspension breaks polling. 7+ push architectures attempted, none verified working end-to-end. Created EXTENSION_DEBUGGING_ISSUE.md as systematic debugging reference.
**Changes:** `extension/native/AppDelegate.swift` (stashed), `daemon/Sources/SafariPilotdCore/AppRelayServer.swift` (stashed), `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (onCommandQueued — stashed), multiple `extension/background.js` polling variants (stashed), `extension/native/SafariWebExtensionHandler.swift` long-polling (stashed), `EXTENSION_DEBUGGING_ISSUE.md` (created), `CHECKPOINT.md` (comprehensive state for UPP pipeline), `ARCHITECTURE.md` (honest current-state warning), `TRACES.md` (restored iterations 11-15)
**Context:** Deep research via Parallel MCP (trun_4719934bf6364778a0bf373a2c479243 "ultra"): dispatchMessage is only sub-2s push path but Xcode 16 marks it unavailable in app extensions. Attempts: setInterval (killed by worker suspension), alarms (30s min too slow), persistent bg (MV3 rejects), Promise chain, dispatchMessage, NSDistributedNotification, TCP app relay, long-polling with stored context, connectNative port, hybrid setInterval+alarms. None produced observable poll activity in daemon log. Core debugging gap: no Safari Web Inspector access — all tests were blind CLI timeouts. User directed: clean context + full UPP pipeline for systematic debugging.
---

### Iteration 16 - 2026-04-17
**What:** Safari MV3 event-page pivot commit 1a (v0.1.5): lifecycle fix + observability
**Changes:** extension/manifest.json (event-page form), extension/background.js (rewrite: wake-sequence + storage queue + alarm keepalive), extension/content-main.js (executedCommands Map), daemon/Sources/SafariPilotdCore/* (HealthStore, ExtensionBridge flip-back + drain-on-poll, CommandDispatcher extension_log + extension_health + healthStore wiring), src/types.ts (idempotent required + StructuredUncertainty), src/errors.ts (EXTENSION_UNCERTAIN), src/tools/*.ts (76 tools migrated + extension-diagnostics 2 new tools), src/security/circuit-breaker.ts (engine scope), src/security/human-approval.ts + idpi-scanner.ts (invalidateForDegradation), src/server.ts (INFRA_MESSAGE_TYPES + degradation re-run + extension-diagnostics registration), safari-pilot.config.json + src/config.ts (kill-switch), scripts/*.sh (verify-extension-smoke, verify-artifact-integrity, promote-stable, health-check), hooks/*.sh (pre-publish-verify, session-end rollback detector), launchagents/com.safari-pilot.health-check.plist, extension/build.config.js, test/e2e/* (commit-1a-shippable, extension-lifecycle, extension-health + engine-selection updates), test/canary/real-cold-wake-60s, test/security/extension-recovery-bypass, test/manual/multi-profile.md, docs/upp/incidents/TEMPLATE.md, ARCHITECTURE.md updates.
**Context:** Three-audit synthesis → brainstorming → spec → plan pipeline. pollLoop deleted entirely; event-page form + storage-backed drain-on-wake. Observability in 1a so the change is measurable. Per-tool idempotent flag blocks auto-retry on side-effect tools. Kill-switch enables <30min config-only rollback. LaunchAgent hourly health check. Next: 1b reconcile + executedLog (v0.1.6) after 72h observation.
---

### Iteration 17 - 2026-04-20
**What:** Security hardening — 35 injection sites fixed, tab ownership fail-closed, enforcement e2e tests
**Changes:** `src/escape.ts` (new — shared escaping utility), `src/server.ts` (ownership fail-closed + navigate_back/forward skip + circuit breaker assertClosed + navigation URL tracking + monotonic tab IDs), `src/errors.ts` (TabUrlNotRecognizedError), `src/tools/{extraction,storage,network,structured-extraction,permissions,interaction,frames}.ts` (escaping), `src/security/{rate-limiter,circuit-breaker}.ts` (eviction), `test/e2e/security-enforcement.test.ts` (new), `test/e2e/{security-pipeline,setup-production,mcp-handshake}.test.ts` (fixes), `ARCHITECTURE.md` (security docs)
**Context:** Four-agent code review found 22 issues. Three adversarial audits refined the plan to v3. Key decisions: navigate_back/forward added to SKIP_OWNERSHIP_TOOLS (pre-existing handler limitation — can't determine post-navigation URL). Engine routing change (daemon-first) deferred (44 test cascade). escapeForJsSingleQuote handles \, ', \n, \r, \0, U+2028, U+2029. escapeForTemplateLiteral handles \, `, ${. IDPI test learned: innerText excludes display:none content.
---

### Iteration 18 - 2026-04-21
**What:** Tab ownership by identity — extension tab.id replaces URL-only matching. Fixes click→navigate→interact breakage from fail-closed ownership (iteration 17).
**Changes:** `src/types.ts` (+meta field on EngineResult), `src/security/tab-ownership.ts` (complete rewrite — dual-key registry: Map<TabId, OwnedTab> with currentUrl + extensionTabId), `src/engines/engine-proxy.ts` (resetMeta/getLastMeta capture meta from executeJsInTab), `src/engines/extension.ts` (detect _meta wrapper, extract into EngineResult.meta), `extension/background.js` (enrich results with _meta: {tabId, tabUrl}), `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (pass through _meta in wrapper), `src/server.ts` (pipeline reorder: engine selection before ownership; deferred ownership for extension engine; post-execution verify via _meta.tabId; removed NAVIGATION_URL_TRACKING_TOOLS), `test/unit/security/tab-ownership.test.ts` (rewritten — 30 tests for new API), `test/e2e/security-enforcement.test.ts` (+deferred path test), `ARCHITECTURE.md` (new pipeline order, dual-key model, _meta propagation)
**Context:** Pipeline reordered: engine selection (step 7) before ownership check (step 7d). When URL lookup fails but extension engine + domain matches → defer to post-execution. Extension result _meta.tabId verifies the tab is owned. Zero additional IPC latency — piggybacks on existing result. Fixes the 2 e2e failures in interaction-tools.test.ts caused by fail-closed ownership after safari_click navigation. 1461 unit tests pass (17 net new).
---

### Iteration 19 - 2026-04-21
**What:** Telemetry system (15 trace points) + persistent session tab (keepalive via content script). Eliminates 15s dead windows in extension connectivity.
**Changes:** `src/trace.ts` (created — TS trace module), `src/engines/daemon.ts` (+traceId injection), `src/server.ts` (+8 trace points + ensureExtensionReady bootstrap), `daemon/Sources/SafariPilotdCore/Trace.swift` (created), `daemon/Sources/SafariPilotdCore/{CommandDispatcher,ExtensionBridge,ExtensionHTTPServer,HealthStore}.swift` (trace points + /status + /session + __keepalive__ + MCP tracking), `extension/background.js` (trace points + keepalive handler + alarm_fire), `extension/content-isolated.js` (session page keepalive ping), `docs/EXECUTION-FLOWS.md` (created — canonical flow map), `scripts/trace-merge.sh` + `trace-rotate.sh`, `scripts/build-extension.sh` (manifest.json version sync fix)
**Context:** Root causes found: (1) Extension alarm WAS working but telemetry was broken (background.js never sent "alarm_fire" to daemon). (2) Safari caches extensions by manifest.json "version" not Info.plist — all rebuilds at same version were invisible. (3) Engine selector already preferred extension but isAvailable() returned false during 15s dead windows between alarm cycles. Fix: persistent session tab with 20s content script keepalive ping → extension stays alive continuously. Verified: 36/36 checks over 3 minutes, zero dead windows. Version: 0.1.9.
---

### Iteration 20 - 2026-04-22/23
**What:** "Saving the project" — deleted all 104 fake tests, wrote new roadmap, built initialization system (spec→plan→execute), fixed Bug 6, validated Phases 1-3 with 19 real e2e tests against real Safari.
**Changes:** Deleted `test/unit/` (58 files), `test/e2e/*.test.ts` (20 files), `test/integration/` (23 files), `test/security/` (2 files), `test/canary/` (1 file). Created `docs/ROADMAP.md` (saving-the-project roadmap), `docs/upp/specs/2026-04-22-initialization-system-design.md`, `docs/upp/plans/2026-04-23-initialization-system.md`. Modified `src/server.ts` (init in start(), pre-call health gate, recovery, registerWithDaemon, sessionTabUrl getter), `src/errors.ts` (+SessionRecoveryError), `daemon/Sources/SafariPilotdCore/HealthStore.swift` (+session registry), `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (+/session/register, extended /status, dashboard session ID), `extension/content-isolated.js` (Bug 6 fix: read sp_cmd on init + dedup guard). Created `test/e2e/initialization.test.ts` (5/5), `phase1-core-navigation.test.ts` (4/4+2 skip), `phase2-page-understanding.test.ts` (6/6), `phase3-interaction.test.ts` (4/4).
**Context:** Bug 6 root cause: `storage.onChanged` only fires for future changes. Content scripts inject at `document_idle` — commands written before injection are invisible. Fix: read current `sp_cmd` after tabId registration. Extension rebuilt + notarized (build 202604230054). All 19 e2e tests proven through extension engine against real Safari. navigate_back/forward deferred (stale URL query — backlog #3).
---

### Iteration 21 - 2026-04-23
**What:** Full codebase audit — 8 specialist agents + 61 per-finding deep-trace agents. Produced `docs/AUDIT-TASKS.md` (58 verified tasks, P0-P3). Also fixed 6 issues: escaping migration (26 sites), navigate_back/forward positional targeting, domainMatches ccTLD, Bug 9 alarm_fire, orphaned daemon cleanup, ARCHITECTURE.md branch ref.
**Changes:** `src/tools/interaction.ts` (17 escaping sites → escapeForJsSingleQuote), `src/tools/shadow.ts` (4 sites + import), `src/tools/permissions.ts` (3 sites), `src/tools/frames.ts` (2 sites + import + escapeForTemplateLiteral), `src/tools/navigation.ts` (navigate_back/forward use executeJsInTabByPosition + new helper method), `src/security/tab-ownership.ts` (extractRegistrableDomain + TWO_PART_TLDS for ccTLD fix), `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (alarm_fire → recordAlarmFire in __trace__ handler), `scripts/update-daemon.sh` (pkill orphaned daemons), `ARCHITECTURE.md` (branch ref, escaping contract, domainMatches description, ccTLD limitation removed), `CLAUDE.md` (SKIP_OWNERSHIP_TOOLS updated). Created `docs/AUDIT-TASKS.md` (58 tasks). UPP proposal at `~/Claude Projects/Skills Factory/Ultra Product Powers/docs/upp/specs/2026-04-23-test-reviewer-hardening-proposal.md`.
**Context:** Audit methodology: 8 specialist agents (security pipeline, engine system, extension IPC, daemon core, tool modules, tab ownership, init/session, distribution) → unified gap map (7C + 24H + 30M) → 61 per-finding deep-trace agents (6-slot concurrency) each tracing full git history. 2 findings rejected (M15 primitive _meta unreachable, M27 keepalive works), 1 corrected (H7 serializer sound — real issue is silent catch{}). 7 recurring patterns identified (build-then-wire gap, spec-as-truth, mock false confidence, catch-and-swallow, forward declarations, URL as identity, asymmetric handling). 7 rules codified. UPP test-reviewer hardening proposed (2 new checks + mandatory gate).
---

### Iteration 22 - 2026-04-23
**What:** T10 (P0) — SIGTERM/SIGINT handlers in `src/index.ts` close the session window before process exit, stopping the hundreds-of-Safari-windows leak across vitest test runs.
**Changes:** `src/index.ts` (SIGINT/SIGTERM handlers registered BEFORE `start()` so mid-init signals are caught; 3s shutdown race; exits 130/143), `src/server.ts` (`shutdown()` now calls new `closeSessionWindow()` first; uses `osascript` with 3s exec timeout; traces close_start / closed / close_failed), `test/e2e/signal-shutdown.test.ts` (2 tests — SIGTERM + SIGINT, isolated `SAFARI_PILOT_TRACE_DIR` per run to read `session_window_created`, assert on `visible of window id` rather than `exists` because Safari keeps ghost dict entries), `ARCHITECTURE.md` (+Shutdown Lifecycle section documenting ordering, ghost-reference quirk, SIGKILL caveat).
**Context:** Root cause found via systematic debugging: initial handler registration was AFTER `await safariPilot.start()`, and start() blocks ~10s waiting for extension; SIGTERM from vitest during that window hit Node's default terminator before any handler existed. Second-order discovery: Safari's AppleScript dictionary retains `window id N` with `exists=true` after close — `visible=false` is the truthful "user-facing closed" signal. This commit is standalone per advisor directive; T-Harness refactor (single-spawn harness) is next. SIGKILL / hard crashes are intentionally out of scope.
---

<!-- Iterations 5-6 archived to traces/archive/milestone-2.md -->

<!-- Iterations 7-9 archived to traces/archive/milestone-3.md -->
