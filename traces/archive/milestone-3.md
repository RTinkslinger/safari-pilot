# Milestone 3: MCP Fix + Benchmark Suite + Real E2E + Baseline
**Iterations:** 7-9 | **Dates:** 2026-04-13 to 2026-04-14

## Summary
Fixed the completely broken MCP STDIO transport (never wired since v0.1.0), built the 120-task benchmark suite with CLI runner, wrote 45 real e2e tests (zero mocks), fixed locator IIFE return value + URL trailing-slash bugs, established enforcement hooks for e2e testing, and ran the first real baseline (37.8% pass rate).

## Key Decisions
- MCP server uses low-level `Server` class + `StdioServerTransport` (not `McpServer` which requires Zod schemas)
- Benchmark forces Safari Pilot MCP tools via `--tools ToolSearch` (blocks Bash, WebFetch, Read)
- `--bare` removed (breaks OAuth), `--max-budget-usd` removed (subscription mode)
- MCP config generated dynamically at runtime with absolute paths
- E2e tests must spawn real processes, use real protocols — pre-commit hook enforces
- McpTestClient uses ID-based response matching (not FIFO)
- `generateLocatorJs` emits raw function body, not IIFE (wrapJavaScript provides the wrapper)

## Iteration Details

### Iteration 7 - 2026-04-13
**What:** Added a11y + security e2e tests through real MCP protocol
**Changes:** test/e2e/a11y-via-mcp.test.ts (8 tests), test/e2e/security-via-mcp.test.ts (7 tests)
**Context:** Discovered locator IIFE bug — wrapJavaScript discards IIFE return values

### Iteration 8 - 2026-04-13/14
**What:** Benchmark suite infrastructure + MCP STDIO fix + 120 tasks + real e2e tests + baseline
**Changes:** src/benchmark/ (8 modules: types, task-loader, eval, stream-parser, fixture-server, worker, reporter, runner), src/index.ts (Server + StdioServerTransport), src/server.ts (getToolDefinition), benchmark/tasks/ (120 JSONs), benchmark/fixtures/ (35 HTMLs), test/e2e/ (mcp-protocol 10 tests, daemon-engine 8 tests, tools-via-mcp 12 tests), hooks/e2e-no-mocks.sh, hooks/e2e-coverage-check.sh, CLAUDE.md (e2e testing section)
**Context:** MCP server was permanently "pending" — index.ts called start() but never created StdioServerTransport. Benchmark initially used Bash+osascript (hijacked user's tab) → fixed with --tools ToolSearch. Multiple smoke test failures: --bare broke OAuth, --max-budget-usd capped tasks, --verbose required for stream-json, SessionStart hooks ate timeout.

### Iteration 9 - 2026-04-14
**What:** Code review fixes — 2 critical, 6 important, 5 suggestions
**Changes:** test/helpers/mcp-client.ts (shared, ID-based), src/benchmark/eval.ts (async execFile, recursive schema validation), src/benchmark/fixture-server.ts (resolve+startsWith path containment), src/benchmark/reporter.ts (removed dead competitive code, history cap 20 runs), src/benchmark/worker.ts (settle pattern, no budget cap), docs/superpowers/specs/ (updated deviations), src/engines/applescript.ts (URL 3-way match), src/locator.ts (raw body not IIFE)
**Context:** Locator fix: generateLocatorJs was an IIFE whose return was discarded by wrapJavaScript's outer wrapper. Changed to emit raw function body with return statements. URL fix: Safari normalizes URLs with trailing slashes; buildTabScript now tries exact, with-slash, and without-slash matches.
