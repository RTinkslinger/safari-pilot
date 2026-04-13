# Checkpoint
*Written: 2026-04-14 02:15*

## Current Task
Benchmark suite shipped to main with first real baseline (37.8%), all code review findings fixed, e2e enforcement in place. Next: continue P1 roadmap (file downloads, PDF generation).

## Progress
- [x] Benchmark suite infrastructure (8 modules in src/benchmark/, 1276 unit tests)
- [x] 120 task definitions across 11 categories + 35 HTML fixtures
- [x] CLI: `npx safari-pilot-bench` with --model, --parallel, --category, --task, --competitive, --dry-run
- [x] MCP STDIO transport fix (index.ts was never wiring Server + StdioServerTransport — broken since v0.1.0)
- [x] Locator IIFE return value fix (generateLocatorJs returned IIFE, wrapJavaScript discarded return)
- [x] URL trailing-slash fix (buildTabScript 3-way match)
- [x] Real e2e tests: 45 tests across 5 files (mcp-protocol, daemon-engine, tools-via-mcp, a11y-via-mcp, security-via-mcp). Zero mocks.
- [x] 9 fake-e2e tests moved to test/integration/ with CI skip guards
- [x] E2e enforcement: pre-commit hook blocks mocks+source imports in test/e2e/, Stop hook reminds to run e2e, CLAUDE.md defines rules
- [x] First real baseline: 37.8% (34/90) with real MCP tools against real Safari. 90 traces captured.
- [x] Code review: 2 critical fixed (ID-based MCP response matching, async LLM judge), 6 important fixed, 5 suggestions addressed
- [x] CI green, all pushed to main
- [x] Shared McpTestClient in test/helpers/mcp-client.ts (-414 lines duplication)
- [ ] File Download Handling (next P1 roadmap item)
- [ ] PDF Generation (next P1 after downloads)
- [ ] Run benchmark after each roadmap item ships

## Key Decisions (not yet persisted)
- Benchmark runner uses `--tools ToolSearch` to block Bash/WebFetch — forces Safari Pilot MCP tool usage
- `--bare` removed (breaks OAuth), `--max-budget-usd` removed (subscription mode, not API)
- MCP config generated dynamically at runtime with absolute paths + cwd
- 30s SESSION_OVERHEAD_MS added to all task timeouts for MCP server startup
- history.json capped at 20 runs to prevent unbounded git bloat
- Old fake traces deleted — only real MCP traces kept

## Next Steps
1. Continue P1 roadmap: File Download Handling (research at docs/research/p1-file-downloads-research.md)
2. After shipping: run `npx safari-pilot-bench --model sonnet --parallel 3` for delta report
3. Then: PDF Generation (research at docs/research/p1-pdf-generation-research.md)
4. After each P1 item: benchmark delta → traces accumulate for recipe system
5. Investigate 25 timeout failures from baseline (MCP server startup latency)
6. Consider investigating safari-specific category (0/7) and workflows category (0/12)

## Context
- Branch: main (clean)
- Latest commit: ee4394b
- Baseline run ID: bench-20260413-sonnet-mnxkgwxd (90 traces in benchmark/traces/)
- Baseline results by category: dom-complexity 100%, error-recovery 87.5%, forms 66.7%, navigation 46.7%, accessibility 37.5%, extraction 20%, intelligence 0%, safari-specific 0%, workflows 0%
- 30 tasks skipped: 8 auth (x.com/reddit/linkedin), 12 competitive, 4 extension-engine, 6 auth+competitive overlap
- Bug found but not yet fixed: QMD hook JSON validation error (intermittent, `~/.claude/hooks/qmd/qmd-prompt-enrichment.sh` — added jq validation guard)
- Repo: https://github.com/RTinkslinger/safari-pilot (public)
- npm: safari-pilot (v0.1.4 on npm, but MCP was broken in published version — needs v0.1.5 release with STDIO fix)
