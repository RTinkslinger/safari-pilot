# Checkpoint
*Written: 2026-04-13 17:00*

## Current State
Safari Pilot v0.1.4 on main. P0 complete. P1 partially complete (locators shipped, benchmark + trace collector shipped). CI green. 1203 unit tests (39 files), 32 integration tests (7 suites), 33 e2e tests (7 suites). TraceCollector capturing live traces. 5 competitive research reports + 2 design specs + 1 implementation plan committed.

## What Shipped This Session (in order)

### Feature: Structured A11y Snapshots + Auto-Wait + Locators (P0+P1)
- `src/aria.ts` — Playwright-compatible ARIA tree with `[ref=eN]`, data-sp-ref stamping, computedRole/computedName with fallbacks (152 unit tests)
- `src/auto-wait.ts` — Actionability checks: visible, stable (2 rAF), enabled, editable, receivesEvents. Per-action profiles. Force option. (99 unit tests)
- `src/locator.ts` — Role+name, text, label, testId, placeholder resolution. CSS pre-filter + post-filter. (106 unit tests)
- `src/tools/extraction.ts` — safari_snapshot rewritten. Ref + locator params on get_text/get_html/get_attribute
- `src/tools/interaction.ts` — All 10 handlers: resolveElement (ref > locator > selector), waitAndExecute with auto-wait. Selector no longer required
- Breaking param renames: safari_type `text` → `content`, safari_select_option `value/label/index` → `optionValue/optionLabel/optionIndex`

### Testing: Integration + E2E Against Live Authenticated Sites
- Integration tests: Wikipedia, example.com, X (auth), Reddit (auth), LinkedIn (auth) — 32 tests, 7 suites, 31/32 passing
- E2E tests (full security pipeline): Wikipedia, HN, GitHub, example.com, X, Reddit, LinkedIn — 33 tests, 7 suites, 19/33 passing
- CI fix: Safari-dependent tests skip via `process.env.CI` check
- Known issues: dispatched click events don't trigger native `<a>` navigation; Reddit JS challenge pages; Wikipedia locator fill (combobox vs searchbox role)

### Competitive Research (5 parallel deep dives)
- `docs/research/competitive-ai-native-browser-agents.md` — Browser Use, Stagehand, AgentQL, Skyvern, MultiOn, etc.
- `docs/research/competitive-computer-use-visual-agents.md` — Claude CU, OpenAI CUA, UI-TARS, WebArena, Mind2Web
- `docs/research/competitive-adaptive-learning-systems.md` — Letta, Voyager, ExpeL, AWM, WALT, SkillWeaver
- `docs/research/competitive-browser-benchmarks.md` — WebArena, Mind2Web, WebVoyager, BrowserGym analysis
- `docs/research/competitive-classic-automation-tools.md` — Playwright, Puppeteer, Selenium, Cypress feature matrix

### Design: Benchmark Suite + Recipe System
- `docs/superpowers/specs/2026-04-13-benchmark-recipe-system-design.md` — 120 tasks, 11 categories, intelligence-tier, competitive dual-mode, 3-layer recipe architecture, MCP-native delivery
- `docs/test-benchmark-integration.md` — Maps existing tests to benchmark tasks, trace logging architecture, maintenance plans, full pipeline diagram
- `docs/ROADMAP.md` — Updated with P1 benchmark suite + P3 recipe system entries, P0 marked SHIPPED

### Feature: TraceCollector (Phase 0 of Benchmark Pipeline)
- `docs/superpowers/specs/2026-04-13-trace-collector-design.md` — Design spec
- `docs/superpowers/plans/2026-04-13-trace-collector.md` — Implementation plan (6 tasks)
- `src/trace-collector.ts` — 808 lines, 3 types (TraceEvent/TraceSession/TraceRun), monkey-patch wrapping, redaction, flush to disk
- `test/unit/trace-collector.test.ts` — 96 unit tests
- Wired into integration tests (handler-direct) and e2e tests (server pipeline)
- Code review: JSON.parse safety fix, cleanup leak fix
- First trace captured: 460KB, 32 sessions, 5 domains, 73 tool calls

## Roadmap Status
| Item | Status | Notes |
|------|--------|-------|
| Daemon Lifecycle + Config | **Shipped** | v0.1.4 |
| Structured A11y Snapshots | **Shipped** | aria.ts, refs, Playwright-compatible YAML |
| Auto-Waiting on All Actions | **Shipped** | auto-wait.ts, per-action profiles |
| Locator-Style Element Targeting | **Shipped** | locator.ts, role/text/label/testId/placeholder |
| TraceCollector | **Shipped** | trace-collector.ts, wired into all tests |
| **Benchmark Suite** | **NEXT — design approved, plan needed** | 120 tasks, runner, eval, delta reports |
| File Download Handling | Ready | Research: p1-file-downloads-research.md |
| PDF Generation | Ready | Research: p1-pdf-generation-research.md |
| CI Browser Testing | Ready | Research: p2-ci-browser-testing-research.md |
| Visual Regression Testing | Ready | Research: p2-visual-regression-research.md |
| Video Recording | Ready | Research: p2-video-recording-research.md |
| Route Modification | Ready | Research: p3-route-modification-research.md |
| HTTP Authentication | Ready | Research: p3-http-auth-research.md |
| **Recipe System** | **Design approved, built last** | 3-layer, MCP-native, seeded by traces |

## Key Decisions
- Refs use `data-sp-ref` DOM attributes (persist across JS calls)
- computedRole/computedName (Safari 16.4+) as primary, full fallback chains
- Benchmark: 120 tasks, 11 categories, intelligence-tier, competitive dual-mode (vs Playwright)
- Recipe system: 3-layer (domain facts + AWM workflows + ExpeL heuristics), MCP-native delivery
- Build order: benchmark first → traces accumulate → recipes last
- TraceCollector captures every tool call in tests — seeding recipe data from day one
- No production browser tool has cross-session learning — first-mover opportunity
- E2E tests run against X, Reddit, LinkedIn (authenticated), Wikipedia, HN, GitHub, example.com

## Test Counts
| Category | Count | Files |
|----------|-------|-------|
| Unit tests | 1203 | 39 files |
| Integration tests (Safari) | 32 | 1 file, 7 suites |
| E2E tests (Safari) | 33 | 1 file, 7 suites |
| **Total** | **1268** | **41 files** |

## Context
- Repo: https://github.com/RTinkslinger/safari-pilot (public)
- npm: safari-pilot@0.1.4
- Branch: main (clean)
- CI: GitHub Actions — test.yml (push/PR), release.yml (tag). CI green.
- Research: 27+ docs in docs/research/
- Specs: docs/superpowers/specs/ (benchmark-recipe-system, trace-collector)
- Plans: docs/superpowers/plans/ (trace-collector — completed)
- Traces: benchmark/traces/ (first integration trace captured)
