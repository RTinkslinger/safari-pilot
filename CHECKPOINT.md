# Checkpoint — v0.1.5 Release Prep + Extension Runtime Issue
*Written: 2026-04-16 03:30*

## Project Vision (for context)

**Safari Pilot** is a native Safari browser automation framework for AI agents on macOS. The goal: be the **ultimate Claude Code setup on Mac for web use**, **beat every competitive benchmark** (Chrome DevTools MCP, Browser Use, Playwright MCP), and eventually support **recipe-based workflows** (saved, replayable browsing sequences) as the endgame roadmap item.

**Why it matters:** Chrome-based automation forces users into Chrome. Safari Pilot lets Claude Code automate Safari natively — preserving the user's logged-in sessions, cookies, Keychain state, and privacy. The three-tier engine model (Extension > Daemon > AppleScript) is the core differentiator that enables capabilities no competitor can match: closed Shadow DOM access, CSP bypass, network interception, cross-origin frame access.

**End goal:** Recipe system — user says "book me a flight" once, Claude Code records the full navigation + extraction flow as a recipe, and any future booking replays the recipe with new parameters. Requires solid foundation: working extension engine, architecture awareness in benchmarks, full three-tier operational.

## Current Task
Ship v0.1.5 with a working extension runtime. Currently blocked on: extension's background.js not executing commands despite handler, daemon, and engine selection all being wired correctly.

## Architecture Status (what IS shipped and wired)

### Daemon layer (Swift)
- [x] `ExtensionSocketServer` — TCP listener on localhost:19474, accepts one-message-per-connection
- [x] `ExtensionBridge` — in-memory command queue with CheckedContinuation (replaced file-based IPC)
- [x] `AppRelayServer` — TCP listener on localhost:19475 for containing app wake signals (stashed in WIP)
- [x] `CommandDispatcher` routes: ping, execute, shutdown, extension_connected, extension_disconnected, extension_result, extension_execute, extension_status, extension_poll, watch_download, generate_pdf
- [x] All daemon tests pass: 41 Swift tests including socket server, bridge queue, result matching, timeout

### Handler layer (Swift appex)
- [x] `SafariWebExtensionHandler` — TCP proxy to daemon via NWConnection
- [x] Settle guard prevents double completeRequest
- [x] 10s connection timeout, proper socket cleanup
- [x] Message type translation: poll/result/status/connected/disconnected/ping → daemon commands

### Extension JS (manifest.json, background.js, content scripts)
- [x] Manifest V3 with `service_worker` background, `activeTab`, `scripting`, `nativeMessaging`, `tabs` permissions
- [x] `content-isolated.js` — ISOLATED world relay (message bridge)
- [x] `content-main.js` — MAIN world (Shadow DOM, dialog interception, network interception, framework detection, execute_script handler with captured Function constructor)
- [x] `background.js` — sendNativeRequest, executeAndReturnResult, content script relay priority over scripting.executeScript

### Server layer (TypeScript)
- [x] `IEngine` interface with `executeJsInTab()` on all 3 engines
- [x] `EngineProxy` — routes tool calls to selected engine at call time (stashed in WIP)
- [x] `DaemonEngine` with TCP reuse (detects LaunchAgent daemon, connects via TCP:19474)
- [x] `ExtensionEngine` — routes through daemon with `__SAFARI_PILOT_INTERNAL__` sentinel
- [x] `AppleScriptEngine` — always available fallback
- [x] Engine selection invoked every tool call via `selectEngine()` in `executeToolWithSecurity`
- [x] MCP response includes `_meta.engine` via `src/index.ts` `_meta` field
- [x] `__engine` embedded in tool result text (for benchmark tracking when Claude CLI strips `_meta`)

### Security pipeline (9 layers, all wired in server.ts)
- [x] KillSwitch — checkBeforeAction (line 358)
- [x] TabOwnership — findByUrl + assertOwnership (lines 372-375)
- [x] DomainPolicy — evaluate (line 381)
- [x] HumanApproval — assertApproved, maps safari_wait_for_download/safari_fill/safari_click to semantic actions (line 385)
- [x] RateLimiter — checkLimit + recordAction (lines 419-423)
- [x] CircuitBreaker — isOpen/recordSuccess/recordFailure (lines 426/464/517)
- [x] Engine Selection — selectEngine (line 430)
- [x] IdpiScanner — scan on extraction tool results (line 480)
- [x] ScreenshotRedaction — getRedactionScript (line 496) — metadata-only (honestly documented)
- [x] AuditLog — record on every path (line 501)

### Tool modules (76 tools, 16 modules)
- [x] 12 modules accept `IEngine` (engine-agnostic)
- [x] 2 modules (navigation, compound) use `AppleScriptEngine` (tab management is always AppleScript)
- [x] 2 modules (downloads, pdf) get engine from server
- [x] 2 direct tools (health_check, emergency_stop) in server.ts

### Testing infrastructure
- [x] 1378 unit tests passing
- [x] 74 e2e tests rewritten from scratch, zero mocks, every test asserts `_meta.engine`
- [x] 10 extension-build integration tests verify `.appex` entitlements + handler is NOT stub
- [x] E2E architecture compliance report — generates per-suite reports in test/e2e/reports/
- [x] Benchmark architecture report — engine usage table, per-task code flow in generated markdown

### Documentation
- [x] `ARCHITECTURE.md` — canonical source of truth with data flows, IPC protocols, litmus tests, version history
- [x] `CLAUDE.md` — Ways of Working (7 rules), updated tool count (76), honest layer descriptions
- [x] `TRACES.md` — iteration log

### Build pipeline
- [x] `scripts/update-daemon.sh` — universal binary, atomic swap, launchctl restart
- [x] `scripts/build-extension.sh` — copies custom handler from `extension/native/SafariWebExtensionHandler.swift` (survives Xcode project regeneration), injects `network.client` entitlement via python3 (macOS sed doesn't handle tabs), signs + notarizes + staples

## v0.1.5 Pending Tasks (priority order)

### CRITICAL BLOCKER
- [ ] **Extension runtime works end-to-end** — background.js receives commands from daemon and executes them. Currently: status checks pass, but extension_execute times out after 30s. See `EXTENSION_DEBUGGING_ISSUE.md` for full analysis.

### Release tasks (after blocker resolved)
- [ ] Rerun full benchmark (90 tasks) with working extension — expect dramatic improvement from 42.2% baseline
- [ ] Version bump package.json to 0.1.5
- [ ] Version bump daemon + extension + app to 0.1.5
- [ ] Run full test suite: `npm test` — unit + integration + e2e all green
- [ ] Build daemon universal binary: `bash scripts/build-daemon-universal.sh` (if exists, else adapt update-daemon.sh)
- [ ] Build extension .app with signed + notarized: `bash scripts/build-extension.sh`
- [ ] Create GitHub Release: upload `SafariPilotd-0.1.5-universal.tar.gz`, `Safari Pilot.zip`
- [ ] `npm publish` from feat/file-download-handling branch (after merge to main)
- [ ] Merge to main, tag v0.1.5
- [ ] Push tags, CI handles distribution

### Post-release validation
- [ ] Install from npm in fresh environment: verify postinstall works
- [ ] Install from git clone in fresh environment: verify GitHub Release fallback works
- [ ] Verify extension auto-registers in Safari after `open "bin/Safari Pilot.app"`

## Key Decisions Already Persisted
- Polling architecture is fundamentally broken in Safari MV3 (service worker suspension)
- SFSafariApplication.dispatchMessage() may be unavailable in appex in Xcode 16+ (per Stack Overflow thread)
- Push-based via containing app + NWConnection relay is the intended architecture
- Benchmarks are sacred — never modify to hide failures (saved to global memory)
- E2E tests must verify shipped architecture, not just tool results (saved to memory)
- Tab isolation: never touch user tabs — all testing via safari_new_tab (saved to memory)

## Reference Documents for UPP Pipeline

### In-repo
- `ARCHITECTURE.md` — canonical data flows, IPC, security pipeline, litmus tests
- `CLAUDE.md` — project instructions + Ways of Working
- `TRACES.md` — development log
- `EXTENSION_DEBUGGING_ISSUE.md` — full reference for the extension runtime blocker (this session)
- `docs/superpowers/plans/2026-04-14-full-architecture-fix.md` — the 547-step plan that built this

### Research
- Parallel deep research task `trun_4719934bf6364778a0bf373a2c479243` — Safari MV3 native push architecture (completed 2026-04-16)
  - View: https://platform.parallel.ai/view/task-run/trun_4719934bf6364778a0bf373a2c479243
  - Key finding: App-Relay Push via `SFSafariApplication.dispatchMessage()` is the only Apple-supported sub-2s push path
  - But: Xcode 16 marks dispatchMessage unavailable in app extensions
  - Alternative: long-polling with stored NSExtensionContext

### External
- Apple: https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension
- Apple: https://developer.apple.com/documentation/safariservices/troubleshooting-your-safari-web-extension
- Stack Overflow: https://stackoverflow.com/questions/78997580/sfsafariapplication-dispatchmessage-on-xcode-16 (dispatchMessage unavailable)
- EvilMartians: https://evilmartians.com/chronicles/how-to-quickly-and-weightlessly-convert-chrome-extensions-to-safari

## Session Branch State
- Branch: `feat/file-download-handling` (~70 commits ahead of main)
- WIP stash: "WIP: push-based extension delivery attempts" (contains AppRelayServer, AppDelegate relay, long-polling handler, multiple background.js approaches)
- Clean commits on branch: all architecture fixes, security wiring, engine selection, test rewrites, documentation
- LaunchAgent daemon: PID varies, owns port 19474 (and 19475 in WIP)
- Extension in Safari: last confirmed working at status-check level (bin/Safari Pilot.app build 202604160731)

## Next Steps (UPP pipeline)
1. Full UPP research + spec cycle on the extension runtime issue using `EXTENSION_DEBUGGING_ISSUE.md` as input
2. Systematic debugging: Safari Web Inspector on background page to see actual errors (require user help)
3. Write proper spec with expected data flow, failure modes, debugging checkpoints
4. Implement ONE approach end-to-end with logging at every step
5. Don't switch approaches without confirming each one failed with evidence (daemon log, WebInspector console, handler logs)
6. Once extension works: full benchmark rerun, validate architecture report data is real
7. Ship v0.1.5
