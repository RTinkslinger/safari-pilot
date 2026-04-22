# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Safari Pilot is a native Safari browser automation framework for AI agents on macOS. It exposes 78 tools via MCP (stdio), letting Claude Code control Safari directly through AppleScript, a persistent Swift daemon, or a Safari Web Extension — no Chrome needed.

## Ways of Working

### 1. Think Before Coding

- State assumptions explicitly. Uncertain? Ask.
- Search for verifiable facts before proposing — never reason from memory.
- Present multiple interpretations with tradeoffs. Never pick silently.
- Simpler approach exists? Say so. Push back when warranted.
- Unclear? Stop. Name the confusion. Ask.
- Read ARCHITECTURE.md, CLAUDE.md, and source files BEFORE proposing. Unread = unknown.
- "Tests pass" ≠ "feature works." Know the difference.

### 2. Simplicity First

- No abstractions for single-use code. No unrequested flexibility.
- No error handling for impossible scenarios.
- 200 lines that could be 50? Rewrite.
- Three similar lines > premature abstraction.
- Ship complete or don't ship. No half-finished implementations.
- If a senior engineer would call it overcomplicated, simplify.

### 3. Surgical Changes

- Touch only what the request requires.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor what isn't broken. Match existing style.
- Unrelated dead code or bugs? Flag them — don't silently fix or delete.
- Remove only orphans YOUR changes created. Never pre-existing dead code.
- Every changed line must trace to the user's request.

### 4. Goal-Driven Execution

Transform tasks into verifiable goals:
- "Add validation" → write tests for invalid inputs, make them pass
- "Fix the bug" → write reproducing test, make it pass
- "Refactor X" → tests pass before and after

Multi-step tasks get a plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
```

Strong success criteria = independent looping. Weak criteria = constant clarification.

### 5. Verify Against Reality

Every claim needs evidence from THIS session:
- "X works" → run it, show output, verify it matches expectations.
- "Tests pass" → run them, show count, read any failures.
- "Component is wired" → grep the call site. No hit = not wired.
- "Architecture is correct" → trace actual data flow through actual files, not what docs claim.
- Claims go stale after code changes. Re-verify.
- Mocks prove the mock works. Only real execution proves the system works.

### 6. Test What Ships

- E2E = shipped architecture: which engine ran, which security layers fired, what users experience.
- "Tool returns result" = functional test. "Tool routes through correct engine + security layers" = architecture test. Both needed.
- Litmus: delete a critical component — does any test fail? No → suite incomplete.
- Never lower thresholds, skip tests, or mock broken paths to hide failures. Investigate root causes.
- Verify tests FAIL when the thing they test breaks. Always-passing tests test nothing.

### 7. Own Mistakes

- False claim? Correct it. Identify what led to it.
- Code broken? Say so. Don't reframe as "limitation" or "roadmap item."
- Tests pass but feature broken? Tests are wrong.
- User catches something you missed? Identify the skipped check. Add it to your process.
- Disagreements resolved with evidence, not assertions.

## Commands

```bash
npm run build          # TypeScript → dist/
npm run dev            # tsc --watch
npm run lint           # tsc --noEmit (type-check only)
npm test               # all tests via vitest
npm run test:e2e       # needs Safari running + JS from Apple Events enabled
```

Run a single test file: `npx vitest run test/e2e/initialization.test.ts`

Run all e2e tests: `npx vitest run test/e2e/`

Run tests matching a name: `npx vitest run -t "navigate"`

**Note:** Unit and integration tests were purged (2026-04-23) — they were mock-based fakes. Only real e2e tests exist now (19 tests, 4 files). See `docs/ROADMAP.md` for the validation plan.

Build the Swift daemon: `bash scripts/update-daemon.sh`

Build the extension: `bash scripts/build-extension.sh`

## Architecture

### Three-Tier Engine Model

Every tool call goes through engine selection based on required capabilities:

```
Extension (10ms p50)  →  Shadow DOM, CSP bypass, network intercept, cross-origin frames
Daemon    (5ms p50)   →  Fastest pure AppleScript execution, no JS injection
AppleScript (80ms p50) →  Always available fallback, basic navigation/forms
```

`engine-selector.ts` picks the best available engine by matching `ToolRequirements` against `ENGINE_CAPS`. If a tool needs `requiresShadowDom`, only Extension qualifies — if unavailable, `EngineUnavailableError` is thrown (not a silent fallback).

**Extension IPC (HTTP short-poll + storage bus):** `background.js` communicates with the daemon via HTTP `fetch()` to `127.0.0.1:19475` (Hummingbird). Three routes: `POST /connect` (reconcile on wake), `GET /poll` (5s hold for pending commands), `POST /result` (deliver execution result). Commands are executed via the **storage bus**: `background.js` writes to `browser.storage.local` key `sp_cmd`, `content-isolated.js` reads via `storage.onChanged`, relays to `content-main.js` via `window.postMessage`, and results flow back through `sp_result`. This replaces `browser.tabs.sendMessage`/`browser.scripting.executeScript` which return `undefined` in alarm-woken event page context. Tab discovery uses a persistent cache (`tabs.onCreated`/`onUpdated`/`onRemoved` → `browser.storage.local`) since `browser.tabs.query({})` also returns `[]` in alarm context. `SafariWebExtensionHandler.swift` is a Xcode-required stub (echo-only). TCP:19474 preserved for DaemonEngine, health checks, and benchmarks.

**Phase 0 fix (2026-04-20):** `handleInternalCommand()` in `CommandDispatcher.swift` now routes the `extension_health` sentinel, fixing `ExtensionEngine.isAvailable()` which previously always returned `false`. The extension engine was dead code until this fix. `handleResult()` in `ExtensionBridge.swift` now unwraps the storage bus `{ok, value}` wrapper on success results, preventing double-wrapping through the daemon response chain.

### Security Pipeline

Seven pre-execution layers + three post-execution checks run on every tool call in `server.ts executeToolWithSecurity()`:

**Pre-execution (block before tool runs):**
0. **Pre-call Health Gate** — live HTTP `/status` + window-exists check. If anything down, transparent recovery (10s) or `SessionRecoveryError`
1. **KillSwitch** — global emergency stop
2. **TabOwnership** — agent can only touch tabs it created via `safari_new_tab`; fails CLOSED on unrecognized URLs
3. **DomainPolicy** — per-domain trust levels and rules
4. **HumanApproval** — flags sensitive actions on untrusted domains
5. **RateLimiter** — 120 actions/min global, per-domain buckets
6. **CircuitBreaker** — 5 errors on a domain → 120s cooldown
7. **Engine Selection** — picks best available engine for tool's requirements

**Post-execution (annotate/audit after tool runs):**
8. **IdpiScanner** — indirect prompt injection detection on extraction tool results only (server.ts:575)
9. **ScreenshotRedaction** — attaches CSS blur script for cross-origin iframes and banking domains on screenshot tool only (server.ts:591)
10. **AuditLog** — records every tool call with params, engine, result, timing (server.ts:596)

### Tool Module Pattern

Each of the 17 files in `src/tools/` follows the same structure:

```typescript
class XTools {
  getDefinitions(): ToolDefinition[]   // name, description, inputSchema, requirements
  getHandler(name: string): Handler    // returns async (params) => ToolResponse
}
```

`server.ts` iterates all modules, registers definitions with MCP, and wires handlers. Tool names are all prefixed `safari_`.

### Error Hierarchy

All errors extend `SafariPilotError` with `code` (from `ERROR_CODES`), `retryable`, and `hints[]`. The `formatToolError()` function wraps these into `ToolError` with engine/timing context. 21 error codes defined in `errors.ts`.

### Key Type Contracts

- `EngineResult` — what engines return: `{ ok, value?, error?, elapsed_ms }`
- `ToolResponse` — what tools return to MCP: `{ content[], metadata }` where metadata includes which engine ran and whether degradation occurred
- `ToolRequirements` — capability flags a tool declares (shadowDom, cspBypass, etc.)

### Tab ID Scheme

`windowIndex * 1000 + tabIndex` — allows unique IDs across windows. Pre-existing tabs are recorded at startup and invisible to the agent.

## Project Layout

```
src/
├── index.ts              # Entry point — creates and starts MCP server
├── server.ts             # SafariPilotServer — tool registration, security orchestration
├── types.ts              # Engine, ToolResponse, ToolError, ToolRequirements
├── errors.ts             # SafariPilotError hierarchy (21 error codes)
├── engine-selector.ts    # selectEngine() + ENGINE_CAPS capability matrix
├── engines/              # IEngine interface + 3 implementations
│   ├── engine.ts         # IEngine interface, BaseEngine abstract class
│   ├── applescript.ts    # exec osascript via child_process
│   ├── daemon.ts         # Swift daemon with NDJSON IPC over stdin + TCP:19474
│   └── extension.ts      # Safari Web Extension via daemon's ExtensionBridge
├── security/             # 9 security layer implementations
└── tools/                # 14 tool modules (navigation, interaction, extraction, etc.)
daemon/                   # Swift source for SafariPilotd
test/
├── unit/                 # No Safari needed — tool handlers, security layers, engines
├── integration/          # Multi-component workflows
├── e2e/                  # Real Safari interaction
├── security/             # Penetration-style tests
├── canary/               # Installation validation
└── fixtures/             # Mock data, test servers
```

## Distribution & Update Paths

Safari Pilot is distributed as a signed, notarized npm package with pre-built binaries. Three personas use this repo differently. Every PR and roadmap item must account for all three.

### Path 1: npm user (`npm install safari-pilot`)

Ships with: pre-built `bin/SafariPilotd` (universal binary), pre-built `bin/Safari Pilot.app` (signed+notarized extension), compiled `dist/`, config, plugin files, plist.

Postinstall: finds pre-built binary → installs LaunchAgent → finds pre-built extension → done. Zero build tools required.

Updates via: `npm update safari-pilot` → new postinstall runs → new binaries in place.

### Path 2: git clone user (`git clone` + `npm install`)

Pre-built binaries are gitignored. Postinstall: no binary found → tries Swift build (if available) → if no Swift, downloads daemon from GitHub Releases → downloads extension from GitHub Releases → installs LaunchAgent → done.

Updates via: `git pull && npm install`.

### Path 3: Developer/maintainer (local development)

When modifying different components:

| Changed | Rebuild command | What happens |
|---------|----------------|-------------|
| `src/**/*.ts` | `npm run build` | Recompiles to `dist/`. MCP server picks up on next session. |
| `daemon/Sources/**/*.swift` | `bash scripts/update-daemon.sh` | Builds, atomic binary swap, launchctl restart. |
| `extension/**` (background.js, manifest.json, content scripts) | `bash scripts/build-extension.sh` | Xcode project → archive → export → sign → notarize → copy to `bin/Safari Pilot.app`. Then `open "bin/Safari Pilot.app"` to register with Safari. |
| `.claude-plugin/**`, `hooks/**`, `skills/**` | Session restart | Plugin metadata reloaded by Claude Code on session start. |
| `safari-pilot.config.json` | Session restart | Config loaded by MCP server on startup. |

### Release pipeline (tag push → `release.yml`)

1. `npm ci` + `npm run build` (TypeScript)
2. `swift build --arch arm64` + `swift build --arch x86_64` + `lipo` → universal daemon binary
3. `codesign` + `notarytool` + `stapler` (daemon)
4. GitHub Release: `SafariPilotd-{version}-universal.tar.gz` + `SafariPilotd-universal.tar.gz` (stable URL) + `Safari Pilot.zip`
5. `npm publish` (includes all pre-built artifacts)

The extension `.app` and `.zip` are pre-built locally via `build-extension.sh`, committed to `bin/`, and uploaded as release assets. They are NOT rebuilt in CI — Xcode project generation requires the full macOS dev environment.

### Scripts reference

| Script | Purpose | Who uses it |
|--------|---------|-------------|
| `scripts/postinstall.sh` | Install daemon + extension + LaunchAgent | npm user, git clone user, CI |
| `scripts/preuninstall.sh` | Unload LaunchAgent, cleanup | npm uninstall |
| `scripts/update-daemon.sh` | Rebuild daemon, atomic swap, restart | Developer only |
| `scripts/build-extension.sh` | Full Xcode → sign → notarize pipeline | Developer only |

## Extension Build: Hard Rules (from v0.1.1–v0.1.3 disaster)

These are non-negotiable. Every one of these was learned through a catastrophic failure.

1. **NEVER use manual `codesign`** for the extension .app. It strips entitlements (app-sandbox). Only `xcodebuild archive` + `xcodebuild -exportArchive` with ExportOptions.plist preserves them. The working pipeline is in `scripts/build-extension.sh` — don't bypass it.

2. **Version MUST sync from package.json** on every build. `CFBundleVersion` stuck at "1" caused Safari's code signing cache to reject the extension silently. The build script patches `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` via sed — don't remove this.

3. **Build number MUST be unique per build** (timestamp-based: `YYYYMMDDHHMM`). Safari keys its extension cache on bundle version. Same version = invisible update.

4. **NEVER run pluginkit, lsregister, pkill pkd, or edit Safari plists**. These caused unrecoverable state in v0.1.1. If the extension doesn't show up, the problem is the BUILD, not the system. Fix the build.

5. **NEVER publish to GitHub Releases or npm before verifying the extension works in Safari**. v0.1.1 and v0.1.2 shipped broken. The verification sequence: `open "bin/Safari Pilot.app"` → check Safari > Settings > Extensions → enable → test.

6. **NEVER quit Safari programmatically** (`osascript 'quit'`, `pkill Safari`). This is destructive — it kills user tabs. If Safari needs restarting, tell the user.

7. **After building, verify entitlements exist**:
   ```bash
   codesign -d --entitlements - "bin/Safari Pilot.app"  # must show app-sandbox
   codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"
   ```

## End-to-End Testing (HARD RULES)

E2E tests verify the **shipped artifact works as an end user would experience it**. Not the internal API. Not mocked components. The actual product, through the actual interfaces, producing actual results.

### Production stack requirement

E2E tests require the full production stack running: system daemon on TCP:19474, Safari extension connected via HTTP:19475, Safari open with JS from Apple Events enabled. The `test/e2e/setup-production.ts` globalSetup verifies all 4 preconditions before tests execute (skips checks for non-e2e runs).

### The principle

If a user installs Safari Pilot and uses it through Claude Code, every step of that workflow must be tested by a real e2e test: MCP server starts → tools are listed → tool is called → Safari is controlled → result comes back. If any link in that chain breaks, an e2e test must catch it.

This applies to **every shipped component**, not just the ones listed below. If something new is built and ships to users, it needs e2e coverage of the user-facing path before shipping.

### What e2e means for each component

| Component | E2E test must... | NOT acceptable |
|-----------|-----------------|----------------|
| **MCP server** | Spawn `node dist/index.js`, send JSON-RPC over stdin, verify stdout responses | Importing `SafariPilotServer` and calling methods |
| **Daemon engine** | Spawn `bin/SafariPilotd`, send NDJSON over stdin, verify responses | `vi.mock('child_process')` |
| **Tools** | Go through MCP protocol → server → engine → Safari → verify real DOM/page state | Mocking the engine and checking return shape |
| **Extension** | Execute via real Safari JS through MCP, verify extension namespace/functions | Importing extension code directly |
| **Security pipeline** | Run adversarial scenarios through MCP, verify enforcement | Testing security layers in isolation with mocked inputs |
| **Distribution** | `npm pack` → install in temp dir → start server → verify MCP handshake | Checking file existence without running anything |
| **Benchmark** | Spawn Claude CLI → verify Safari Pilot MCP tools are used → verify eval works | Using built-in tools (Bash/WebFetch) instead of Safari Pilot |

### What is NEVER allowed in test/e2e/

1. `vi.mock`, `vi.spyOn`, `jest.mock`, or any mock/stub/fake
2. `import { ... } from '../../src/'` — never import source modules directly
3. Calling `server.executeToolWithSecurity()` or any internal method
4. Skipping the user-facing protocol (MCP JSON-RPC, daemon NDJSON, HTTP)
5. Claiming "e2e" for a test that only exercises internal code paths

If a test does any of these, it belongs in `test/integration/`, not `test/e2e/`.

### Enforcement

- **Pre-commit hook** (`hooks/e2e-no-mocks.sh`): blocks `vi.mock`/`vi.spyOn`/`mockImplementation` and `import from '../../src/'` in `test/e2e/` files
- **Stop hook**: before session end, verifies e2e tests exist and pass if source files changed
- **CLAUDE.md** (this section): defines what e2e means — every session starts with this context

### Before shipping any feature

Ask: "Does a real e2e test exercise the path a user would take?" If not, the feature is not tested and must not ship.

### Trace capture (MANDATORY for all test runs)

Every e2e test run, benchmark run, validation run, or manual test session MUST capture traces. The `McpTestClient` in `test/helpers/mcp-client.ts` handles this automatically:

- **`test-results/traces/<timestamp>/tool-calls.jsonl`** — every tool call: name, args, full result, engine used, latency. This is the primary input for the recipe system's learning pipeline.
- **`test-results/traces/<timestamp>/stderr.log`** — MCP server init progress, warnings, errors.
- **`test-results/traces/<timestamp>/server-trace.ndjson`** — TypeScript server trace events (security pipeline, engine selection, ownership checks).
- **`test-results/traces/<timestamp>/daemon-trace.ndjson`** — Swift daemon trace events (command dispatch, bridge, HTTP).

These traces are NOT test artifacts to be cleaned up. They are the raw data that feeds domain learning, recipe extraction, and benchmark analysis. Never delete `test-results/traces/`. The directory is gitignored but must persist on the developer's machine.

Any new test harness, benchmark runner, or validation script that executes Safari Pilot tools MUST capture equivalent trace data. If building a new runner outside of `McpTestClient`, write `tool-calls.jsonl` in the same format.

## Canonical Architecture Document

**`ARCHITECTURE.md`** is the single source of truth for how Safari Pilot works as shipped. Every data flow, IPC protocol, security layer, and engine selection path is documented there with verification evidence.

**HARD RULE:** Any commit that changes component behavior, data flow, IPC protocol, security pipeline, engine selection, or test architecture MUST update `ARCHITECTURE.md` in the same commit. If code and document diverge, the code is suspect until the document is updated with verified evidence.

Read `ARCHITECTURE.md` at session start. Before claiming any component "works," verify against the document. Before shipping, run the litmus tests listed there.

## Non-Obvious Constraints

- **macOS only** — package.json enforces `"os": ["darwin"]`. Node 20+.
- **Single production dependency** — `@modelcontextprotocol/sdk`. Everything else is stdlib.
- **AppleScript escaping** — double-escape both backslashes and quotes to survive the shell → AppleScript → JavaScript round-trip. See `buildTabScript()` in `applescript.ts`.
- **Daemon IPC is triple** — stdin/stdout NDJSON for MCP commands, TCP localhost:19474 for DaemonEngine/health-checks/benchmarks, HTTP localhost:19475 for extension `fetch()` polling (Hummingbird, requires macOS 14+). TCP:19474 and HTTP:19475 serve different clients — they are NOT interchangeable.
- **Safari prerequisite** — "Allow JavaScript from Apple Events" must be enabled in Safari > Develop menu for any JS execution to work. Health check detects this (error code `-1743`).
- **No credential access** — never touches macOS Keychain. Auth happens via real browser interaction only.
- **Tab ownership fails CLOSED** — if `findByUrl(tabUrl)` returns undefined, `TabUrlNotRecognizedError` is thrown (not silently passed). After `safari_navigate` succeeds, ownership registry updates to the new URL. `safari_click` link navigation does NOT update the registry (known limitation).
- **SKIP_OWNERSHIP_TOOLS** — `safari_list_tabs`, `safari_new_tab`, `safari_health_check`, `safari_navigate_back`, `safari_navigate_forward` bypass tab ownership checks. The navigate_back/forward handlers query the tab by stale URL after history.back()/forward() — ownership enforcement is unreliable for them.
- **JS string escaping** — all user-provided strings embedded in JS use `escapeForJsSingleQuote()` or `escapeForTemplateLiteral()` from `src/escape.ts`. Never use bare `.replace(/'/g, "\\'")` — it misses backslash escaping and creates injection vectors.
- **Rate limiter is per-domain**, not per-tab — prevents spamming one domain across multiple tabs.
