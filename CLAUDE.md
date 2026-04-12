# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Safari Pilot is a native Safari browser automation framework for AI agents on macOS. It exposes 74 tools via MCP (stdio), letting Claude Code control Safari directly through AppleScript, a persistent Swift daemon, or a Safari Web Extension — no Chrome needed.

## Commands

```bash
npm run build          # TypeScript → dist/
npm run dev            # tsc --watch
npm run lint           # tsc --noEmit (type-check only)
npm test               # all tests via vitest
npm run test:unit      # 700+ unit tests (no Safari needed)
npm run test:integration
npm run test:e2e       # needs Safari running + JS from Apple Events enabled
npm run test:security
```

Run a single test file: `npx vitest run test/unit/tools/navigation.test.ts`

Run tests matching a name: `npx vitest run -t "navigate"`

Build the Swift daemon: `cd daemon && swift build -c release && cp .build/release/SafariPilotd ../bin/`

## Architecture

### Three-Tier Engine Model

Every tool call goes through engine selection based on required capabilities:

```
Extension (10ms p50)  →  Shadow DOM, CSP bypass, network intercept, cross-origin frames
Daemon    (5ms p50)   →  Fastest pure AppleScript execution, no JS injection
AppleScript (80ms p50) →  Always available fallback, basic navigation/forms
```

`engine-selector.ts` picks the best available engine by matching `ToolRequirements` against `ENGINE_CAPS`. If a tool needs `requiresShadowDom`, only Extension qualifies — if unavailable, `EngineUnavailableError` is thrown (not a silent fallback).

### Security Pipeline

Nine sequential layers run before every tool execution in `server.ts`:

1. **KillSwitch** — global emergency stop
2. **TabOwnership** — agent can only touch tabs it created via `safari_new_tab`
3. **DomainPolicy** — per-domain trust levels and rules
4. **RateLimiter** — 120 actions/min global, per-domain buckets
5. **CircuitBreaker** — 5 errors on a domain → 120s cooldown
6. **IdpiScanner** — indirect prompt injection detection in extracted text
7. **HumanApproval** — flags sensitive actions on untrusted domains
8. **AuditLog** — records every tool call (params redacted for passwords)
9. **ScreenshotRedaction** — blurs cross-origin iframes, redacts password fields

### Tool Module Pattern

Each of the 14 files in `src/tools/` follows the same structure:

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
│   ├── daemon.ts         # Swift daemon with JSON IPC at ~/.safari-pilot/bridge/
│   └── extension.ts      # Safari Web Extension native messaging bridge
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

## Non-Obvious Constraints

- **macOS only** — package.json enforces `"os": ["darwin"]`. Node 20+.
- **Single production dependency** — `@modelcontextprotocol/sdk`. Everything else is stdlib.
- **AppleScript escaping** — double-escape both backslashes and quotes to survive the shell → AppleScript → JavaScript round-trip. See `buildTabScript()` in `applescript.ts`.
- **Daemon IPC is file-based** — request/response JSON through `~/.safari-pilot/bridge/`, not stdout, to avoid buffering issues.
- **Safari prerequisite** — "Allow JavaScript from Apple Events" must be enabled in Safari > Develop menu for any JS execution to work. Health check detects this (error code `-1743`).
- **No credential access** — never touches macOS Keychain. Auth happens via real browser interaction only.
- **SKIP_OWNERSHIP_TOOLS** — `safari_list_tabs`, `safari_new_tab`, `safari_health_check` bypass tab ownership checks.
- **Rate limiter is per-domain**, not per-tab — prevents spamming one domain across multiple tabs.
