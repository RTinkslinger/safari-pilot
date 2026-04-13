# Checkpoint
*Written: 2026-04-13 15:20*

## Current State
Safari Pilot v0.1.4 on main. P0 complete (daemon lifecycle, a11y snapshots, auto-waiting). First P1 item complete (locator targeting). CI green. 1107 unit tests, 25 integration tests (7 suites), 33 e2e tests (7 suites). 5 competitive research reports written. Benchmark + recipe system design spec approved.

## What Shipped This Session
- [x] `src/aria.ts` — Playwright-compatible ARIA tree snapshots with `[ref=eN]`, data-sp-ref stamping, computedRole/computedName with full fallback chains (152 unit tests)
- [x] `src/auto-wait.ts` — Actionability checks before every interaction: visible, stable (2 rAF), enabled, editable, receivesEvents. Per-action profiles matching Playwright's matrix. Force option. (99 unit tests)
- [x] `src/locator.ts` — Role+name, text, label, testId, placeholder resolution with CSS pre-filter. Substring matching default. (106 unit tests)
- [x] `src/tools/extraction.ts` — safari_snapshot rewritten to use aria.ts. Ref + locator params on get_text/get_html/get_attribute
- [x] `src/tools/interaction.ts` — All 10 handlers: resolveElement (ref > locator > selector), waitAndExecute with auto-wait, force option. Selector no longer required
- [x] Breaking param renames: safari_type `text` → `content`, safari_select_option `value/label/index` → `optionValue/optionLabel/optionIndex`
- [x] Integration tests against Wikipedia, example.com, X, Reddit, LinkedIn (25 tests, 7 suites)
- [x] E2E tests (full security pipeline) against Wikipedia, HN, GitHub, example.com, X, Reddit, LinkedIn (33 tests, 7 suites)
- [x] CI fix: Safari-dependent tests skip via `process.env.CI` check + JS execution probe
- [x] 5 competitive research reports (AI-native agents, computer use, adaptive learning, benchmarks, classic tools)
- [x] Benchmark + recipe system design spec (`docs/superpowers/specs/2026-04-13-benchmark-recipe-system-design.md`)
- [x] Roadmap updated: P1 benchmark suite + P3 recipe system entries, P0 items marked SHIPPED
- [x] Test-to-benchmark integration guide (`docs/test-benchmark-integration.md`)
- [x] Orphaned research files moved to `docs/research/`

## Roadmap Status
| Item | Status | Research |
|------|--------|----------|
| Daemon Lifecycle + Config | **Shipped** | mcp-plugin-config-best-practices.md |
| Structured A11y Snapshots | **Shipped** | docs/research/p0-accessibility-snapshots-research.md |
| Auto-Waiting on All Actions | **Shipped** | docs/research/p0-auto-waiting-research.md |
| Locator-Style Element Targeting | **Shipped** | docs/research/p1-locator-targeting-research.md |
| Benchmark Suite | **Design approved** | docs/research/competitive-browser-benchmarks.md, design spec |
| File Download Handling | Ready | docs/research/p1-file-downloads-research.md |
| PDF Generation | Ready | docs/research/p1-pdf-generation-research.md |
| Recipe System | **Design approved** | 5 competitive research reports, design spec |

## Key Decisions (this session)
- safari_type `text` renamed to `content`, safari_select_option params prefixed with `option` — avoids collision with locator params
- Refs use `data-sp-ref` DOM attributes (persist across JS calls, simplest approach)
- computedRole/computedName (Safari 16.4+) as primary, full fallback chains for WebKit bugs
- Benchmark: 120 tasks, 11 categories, intelligence-tier (human-like inference), competitive dual-mode (vs Playwright)
- Recipe system: 3-layer (domain facts + AWM workflows + ExpeL heuristics), MCP-native delivery (hints in tool responses)
- Build order: benchmark first → traces accumulate → recipes last in roadmap
- No production browser tool has cross-session learning — first-mover opportunity

## Next Steps
1. Build benchmark suite (task definitions, runner, eval engine, trace capture, delta reports)
2. Define initial 120 benchmark tasks (seeded from existing e2e tests + intelligence-tier + competitive)
3. Run baseline benchmark before next roadmap item
4. P1: File Download Handling (FSEvents via daemon, ~/Downloads monitoring)
5. P1: PDF Generation (WKWebView via daemon)
6. After each ship: run benchmark, generate delta report, extract recipe candidates

## Context
- Repo: https://github.com/RTinkslinger/safari-pilot (public)
- npm: safari-pilot@0.1.4
- Branch: main (clean after this commit)
- CI: GitHub Actions — test.yml (push/PR to main), release.yml (tag push). CI green.
- Research: 27 docs in docs/research/ (22 original + 5 new competitive reports)
- Design spec: docs/superpowers/specs/2026-04-13-benchmark-recipe-system-design.md
- Integration guide: docs/test-benchmark-integration.md
