# Safari Pilot Benchmark Suite — Implementation Spec

**Date:** 2026-04-13
**Status:** Approved — ready for implementation plan
**Parent spec:** `docs/superpowers/specs/2026-04-13-benchmark-recipe-system-design.md`
**Research inputs:** `docs/research/competitive-browser-benchmarks.md`, `docs/test-benchmark-integration.md`

---

## 1. Vision & Objective

Build the measurement system for Safari Pilot's journey to being the best native Safari browser automation tool on macOS. The benchmark measures whether Safari Pilot helps Claude accomplish real-world browsing tasks — not just tool reliability, but agent effectiveness.

**Build order:** Wire the full infrastructure once → define all 120 tasks upfront → incrementally enable tasks as roadmap items ship → each ship produces a delta report → traces accumulate for the future recipe system.

---

## 2. Runner Architecture

### 2.1 Execution Model

The benchmark runner spawns one Claude Code CLI process (`claude -p`) per task. Each task gets full isolation — fresh session, clean MCP connection, no context pollution between tasks. Claude autonomously completes each task using Safari Pilot's MCP tools.

**Per-task invocation:**
```bash
claude -p "<system_prompt + task_intent>" \
  --output-format stream-json \
  --model <model> \
  --json-schema '<eval_schema>' \
  --tools ToolSearch \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --strict-mcp-config --mcp-config <generated-config>
```

**Key flags:**
- `--output-format stream-json` — streams every tool call, result, and reasoning chunk in real-time
- `--json-schema` — enforces structured output matching the task's eval schema
- `--tools ToolSearch` — restricts built-in tools to ToolSearch only (blocks Bash, WebFetch). MCP tools remain available.
- `--strict-mcp-config` — only load the Safari Pilot MCP server (generated config with absolute paths)
- `--permission-mode bypassPermissions` — no interactive prompts during automated runs
- `--no-session-persistence` — don't pollute session history with benchmark runs

**Removed from original spec (implementation deviations):**
- `--bare` — removed because it breaks OAuth/subscription auth (skips keychain reads)
- `--max-budget-usd` — removed because the benchmark runs on subscription, not API. The field remains in task JSONs for future API-key mode but is not passed to the CLI.

### 2.2 Parallel Execution

Window-based parallelism with configurable concurrency (default N=3):

1. Runner pre-creates N Safari windows via AppleScript
2. Tasks are distributed across N worker slots with domain affinity (all Wikipedia tasks to one worker, all HN to another — prevents rate limiter conflicts)
3. Each worker spawns `claude -p` with a system prompt that includes the window assignment
4. Each Claude session creates tabs in its assigned window only
5. When a worker finishes a task, it picks up the next from its queue
6. Results accumulate in a thread-safe collector

**Timing:** 120 tasks × ~30s avg = ~60min sequential. With 3 workers: ~20min.

### 2.3 CLI Interface

Registered as `safari-pilot-bench` bin entry in package.json.

```bash
npx safari-pilot-bench                          # default: sonnet, all eligible tasks, 3 workers
npx safari-pilot-bench --model opus             # specific model
npx safari-pilot-bench --model sonnet,opus      # multi-model run (sequential per model)
npx safari-pilot-bench --category intelligence  # filter to one category
npx safari-pilot-bench --competitive            # include competitive dual-mode tasks
npx safari-pilot-bench --task intel-003         # run single task (debugging)
npx safari-pilot-bench --dry-run               # show which tasks would run, skip execution
npx safari-pilot-bench --parallel 1             # sequential mode (debugging)
npx safari-pilot-bench --parallel 5             # 5 concurrent workers
npx safari-pilot-bench --timeout-multiplier 2   # 2x default timeouts
```

### 2.4 Pre-Flight Checks

Before executing tasks, the runner verifies capabilities:

1. **Tool availability** — Start a Safari Pilot MCP server, query available tools. Determines which `requires.tools` are satisfied.
2. **Engine health** — Check daemon is running, extension is available. Determines `requires.engines`.
3. **Auth verification** — For each unique `requires.auth_domains`, navigate to the site and check for login indicators (profile elements, logged-in state). Auth tasks are skipped (not failed) if not logged in.
4. **Competitive readiness** — Check if Playwright MCP config exists at `benchmark/mcp-configs/playwright-only.json`. Competitive tasks skipped if absent.
5. **Fixture server** — Start local HTTP server on port 9876 for fixture-based tasks.

Tasks whose requirements aren't met get `skipped` status with a clear reason.

---

## 3. Task Definition Format

### 3.1 JSON Schema

Each task is a JSON file in `benchmark/tasks/{category}/`. WebArena-informed with Safari Pilot extensions.

```json
{
  "id": "extract-005",
  "category": "extraction",
  "difficulty": "medium",

  "intent": "On Wikipedia, find the population of Tokyo and extract it as a number",
  "intent_template": "On Wikipedia, find the population of {{city}} and extract it as a number",
  "instantiation_dict": {
    "city": "Tokyo"
  },

  "start_url": "https://en.wikipedia.org/wiki/{{city}}",

  "requires": {
    "tools": [],
    "engines": [],
    "auth_domains": [],
    "features": [],
    "competitive": false
  },

  "eval": {
    "type": "structured_output",
    "schema": {
      "type": "object",
      "properties": {
        "population": { "type": "string", "pattern": "^[0-9,]+$" }
      },
      "required": ["population"]
    }
  },
  "reference_answers": {
    "exact_match": "13,960,000",
    "must_include": ["13"],
    "fuzzy_match": "approximately 14 million"
  },
  "eval_fallback": {
    "type": "llm_judge",
    "criteria": "Did the agent extract Tokyo's population? Accept any reasonable figure between 13-14 million."
  },

  "timeout_ms": 60000,
  "max_budget_usd": 0.25,
  "tags": ["extraction", "wikipedia", "structured-data"],
  "roadmap_gate": null,
  "enabled_after": null
}
```

### 3.2 Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique task identifier (e.g., `nav-001`, `intel-003`) |
| `category` | string | yes | One of 11 categories |
| `difficulty` | string | yes | `easy`, `medium`, `hard`, `intelligence` |
| `intent` | string | yes | Natural language task description (fully instantiated) |
| `intent_template` | string | no | Parameterized intent with `{{variable}}` placeholders |
| `instantiation_dict` | object | no | Default variable values for template |
| `start_url` | string | no | Starting URL (supports template variables) |
| `requires` | object | yes | Capability requirements for the task |
| `requires.tools` | string[] | yes | Specific tools needed (e.g., `["safari_wait_for_download"]`) |
| `requires.engines` | string[] | yes | Required engines (e.g., `["extension"]`) |
| `requires.auth_domains` | string[] | yes | Sites that must be logged in |
| `requires.features` | string[] | yes | High-level features (e.g., `["file-download"]`) |
| `requires.competitive` | boolean | yes | Whether this is a dual-mode task |
| `eval` | object | yes | Primary evaluation criteria |
| `eval.type` | string | yes | `exact_match`, `contains`, `structured_output`, `llm_judge` |
| `reference_answers` | object | no | Multiple valid answer formats (WebArena compatibility) |
| `eval_fallback` | object | no | Secondary eval if primary is inconclusive |
| `timeout_ms` | number | yes | Per-task timeout in milliseconds |
| `max_budget_usd` | number | yes | Per-task budget cap for Claude CLI |
| `tags` | string[] | yes | Searchable tags |
| `roadmap_gate` | string | no | Roadmap item that must ship before task is eligible |
| `enabled_after` | string | no | ISO date after which the task is enabled |

### 3.3 Task Distribution

| Category | Count | Difficulty Mix | Environment |
|----------|-------|---------------|-------------|
| Navigation | 15 | 5 easy, 7 medium, 3 hard | 5 fixture, 7 live, 3 auth |
| Form interaction | 15 | 5 easy, 7 medium, 3 hard | 6 fixture, 6 live, 3 auth |
| Data extraction | 15 | 4 easy, 7 medium, 4 hard | 5 fixture, 7 live, 3 auth |
| Multi-step workflows | 12 | 0 easy, 6 medium, 6 hard | 3 fixture, 5 live, 4 auth |
| DOM complexity | 8 | 2 easy, 4 medium, 2 hard | 8 fixture, 0 live, 0 auth |
| Auth flows | 8 | 2 easy, 4 medium, 2 hard | 2 fixture, 0 live, 6 auth |
| Accessibility-first | 8 | 2 easy, 4 medium, 2 hard | 4 fixture, 3 live, 1 auth |
| Error recovery | 8 | 2 easy, 4 medium, 2 hard | 6 fixture, 2 live, 0 auth |
| Safari-specific | 7 | 2 easy, 3 medium, 2 hard | 2 fixture, 5 live, 0 auth |
| Intelligence-tier | 12 | 0 easy, 0 medium, 0 hard, 12 intel | 0 fixture, 4 live, 4 auth, 4 competitive |
| Competitive | 12 | 0 easy, 4 medium, 8 hard | 0 fixture, 8 live, 4 auth |
| **Total** | **120** | **24 easy, 50 medium, 34 hard, 12 intel** | **41 fixture, 47 live, 28 auth, 4 comp** |

### 3.4 Incremental Enablement

Each task's `requires` and `roadmap_gate` fields control when it becomes eligible:

| Milestone | New Tasks Enabled | Cumulative |
|-----------|-------------------|------------|
| Baseline (now) | Navigation, forms, extraction, a11y, error recovery, Safari-specific, intelligence, competitive | ~116 |
| File downloads | Download-dependent extraction and workflow tasks | ~118 |
| PDF generation | PDF export tasks | ~120 |
| Recipe system | All intelligence-tier tasks get recipe hints | 120 (with recipes) |

The runner auto-discovers eligibility. No code changes needed — just add/update task JSON files.

---

## 4. Eval Engine

### 4.1 Eval Types

Three primary types, ordered by reliability:

1. **`exact_match`** — String comparison against `reference_answers.exact_match`. Case-insensitive option. For simple factual answers.

2. **`contains`** — Check that all strings in `reference_answers.must_include` appear in the output. For answers where format varies but key content must be present.

3. **`structured_output`** — JSON schema validation against `eval.schema`. The Claude CLI already validates via `--json-schema`, but the eval engine double-checks and extracts specific fields for comparison against `reference_answers`.

One fallback type:

4. **`llm_judge`** — Claude (Haiku model for cost) evaluates the result against `eval_fallback.criteria`. Returns YES/NO with explanation. Used ONLY for intelligence-tier tasks where success criteria are subjective.

### 4.2 Eval Chain

```
1. Parse Claude's final output (structured JSON from --json-schema)
2. Run primary eval (exact_match, contains, or structured_output)
3. If primary passes → task PASSED
4. If primary fails and eval_fallback exists → run fallback (llm_judge)
5. If fallback passes → task PASSED (with note: "passed via fallback")
6. If fallback fails → task FAILED
7. Record eval method used, details, and any discrepancies
```

### 4.3 Flakiness Detection

Computed at report-generation time by comparing the same task across the last N runs in `history.json`:

- If a task passed 100% or failed 100% across last 5 runs → stable
- If a task's pass/fail ratio is between 20%-80% → marked `flaky`
- Flaky tasks are included in results but excluded from regression alerts
- Flaky tasks are flagged in delta reports for investigation

---

## 5. Trace Capture

### 5.1 Stream-JSON Parsing

Claude Code's `--output-format stream-json` emits structured events:

```json
{"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "...", "name": "safari_navigate", "input": {...}}]}}
{"type": "tool", "content": [{"type": "tool_result", "tool_use_id": "...", "content": "..."}]}
{"type": "assistant", "message": {"content": [{"type": "text", "text": "I can see the page..."}]}}
```

The runner's stream parser (`stream-parser.ts`) maps these to trace events:

| Stream Event | Maps To |
|-------------|---------|
| `tool_use` | `TraceEvent` start (tool, params, targeting) |
| `tool_result` | `TraceEvent` completion (success, result, timing) |
| `text` (assistant) | Model reasoning excerpts |
| First event | `TraceSession` start |
| Stream end | `TraceSession` end |

### 5.2 Trace Storage

```
benchmark/traces/{run-id}/
  ├── meta.json          # Run metadata, model, commit, eligible/skipped
  ├── nav-001.json       # Per-task trace
  ├── intel-003.json
  └── summary.json       # Aggregate metrics for this run
```

Per-task trace format matches the existing `TraceSession` type from `src/trace-collector.ts` where possible, extended with benchmark-specific fields:

```json
{
  "taskId": "intel-003",
  "runId": "bench-20260413-001",
  "model": "sonnet",
  "intent": "On LinkedIn, find 3 software engineers at Anthropic...",
  "success": true,
  "evalMethod": "structured_output",
  "evalDetails": { "schema_valid": true, "engineers_count": 3 },
  "events": [ ... ],
  "reasoning_excerpts": [ ... ],
  "metrics": {
    "steps": 14,
    "duration_ms": 28500,
    "tools_used": ["safari_snapshot", "safari_click", "safari_fill", ...],
    "engines_used": { "applescript": 12, "daemon": 2 }
  }
}
```

---

## 6. Reporting

### 6.1 Delta Report

Generated after each benchmark run. Markdown file at `benchmark/reports/{date}-{commit}.md`.

Compares this run to the most recent baseline in `history.json`:

```markdown
# Safari Pilot Benchmark Report
**Run:** bench-20260413-003 | **Model:** sonnet | **Commit:** abc1234 | **Branch:** feat/benchmark-suite

## Overall: 89/116 eligible tasks passed (76.7%) — baseline

| Category | Pass | Rate | Delta |
|----------|------|------|-------|
| Navigation | 14/15 | 93.3% | baseline |
| Form interaction | 13/15 | 86.7% | baseline |
| Intelligence-tier | 2/12 | 16.7% | baseline |
| Competitive (vs PW) | 7/12 | 58.3% | baseline |

## Competitive Breakdown
Safari Pilot: 7/12 (58.3%) | Playwright: 5/12 (41.7%)
SP advantages: authenticated sessions (5/5 vs 0/5)
PW advantages: element screenshots (0/1 vs 1/1)

## Intelligence Tier
2/12 passing (16.7%) — this is the recipe system's future KPI

## Skipped Tasks (4)
- download-001: requires safari_wait_for_download (not yet shipped)
- download-002: requires safari_wait_for_download
- pdf-001: requires safari_export_pdf
- pdf-002: requires safari_export_pdf

## Flaky Tasks
None detected (first run — need 5+ runs for detection)
```

### 6.2 History Tracking

`benchmark/history.json` accumulates run-over-run metrics:

```json
{
  "runs": [
    {
      "id": "bench-20260413-001",
      "model": "sonnet",
      "commit": "abc1234",
      "branch": "feat/benchmark-suite",
      "timestamp": "2026-04-13T12:00:00Z",
      "eligible": 116,
      "skipped": 4,
      "passed": 89,
      "failed": 27,
      "overall_rate": 0.767,
      "by_category": { ... },
      "intelligence_rate": 0.167,
      "competitive_win_rate": 0.583,
      "mean_steps": 6.2,
      "p50_duration_ms": 22000,
      "p95_duration_ms": 85000,
      "flaky_count": 0,
      "per_task": {
        "nav-001": { "passed": true, "steps": 3, "duration_ms": 8500 },
        "intel-003": { "passed": false, "steps": 14, "duration_ms": 42000 }
      }
    }
  ]
}
```

---

## 7. Competitive Mode

### 7.1 Mechanism

Competitive tasks run twice — once with Safari Pilot, once with Playwright MCP:

**Safari Pilot run:**
```bash
claude -p "<intent>" --strict-mcp-config --mcp-config benchmark/mcp-configs/safari-only.json --allowedTools "mcp__safari__*"
```

**Playwright run:**
```bash
claude -p "<intent>" --strict-mcp-config --mcp-config benchmark/mcp-configs/playwright-only.json --allowedTools "mcp__playwright__*"
```

### 7.2 Metrics Compared

Per competitive task:
- Binary success (did it complete?)
- Step count (tool calls)
- Wall-clock duration
- Error recovery count

Aggregate:
- Safari Pilot win rate
- Per-advantage-category breakdown (auth, performance, features)

### 7.3 MCP Configs

```json
// benchmark/mcp-configs/safari-only.json
{
  "mcpServers": {
    "safari": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

```json
// benchmark/mcp-configs/playwright-only.json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright"]
    }
  }
}
```

---

## 8. Local Fixtures

### 8.1 Fixture Server

Node.js HTTP server at `benchmark/fixtures/server.ts`, serves static HTML on port 9876. Started by the runner during pre-flight, stopped after all tasks complete.

### 8.2 Fixture Categories

```
benchmark/fixtures/
├── server.ts              # HTTP server
├── navigation/            # Links, redirects, history
├── forms/                 # Inputs, validation, submission
├── extraction/            # Tables, nested DOM, dynamic content
├── dom-complexity/        # Shadow DOM, iframes, lazy loading
├── error-recovery/        # Overlays, stale elements, slow loads
└── accessibility/         # ARIA-rich pages for ref/locator testing
```

### 8.3 Design Principles

- Every fixture is self-contained (no external dependencies)
- Fixtures include deterministic JS behavior (timers, dynamic content) for testing auto-wait
- Fixture tasks have fully deterministic expected answers
- Fixtures are version-controlled — changes require updating reference_answers

---

## 9. File Organization

```
benchmark/
├── runner.ts              # Main runner script (CLI entry point)
├── eval.ts                # Eval engine
├── reporter.ts            # Delta report generator
├── stream-parser.ts       # Claude stream-json → trace events
├── preflight.ts           # Auth checks, tool/engine availability
├── types.ts               # BenchmarkTask, BenchmarkResult, RunConfig
├── worker.ts              # Parallel worker (processes task queue for one Safari window)
├── tasks/                 # 120 task definitions (JSON)
│   ├── navigation/        # 15 tasks (nav-001.json through nav-015.json)
│   ├── forms/             # 15 tasks
│   ├── extraction/        # 15 tasks
│   ├── workflows/         # 12 tasks
│   ├── dom-complexity/    # 8 tasks
│   ├── auth-flows/        # 8 tasks
│   ├── accessibility/     # 8 tasks
│   ├── error-recovery/    # 8 tasks
│   ├── safari-specific/   # 7 tasks
│   ├── intelligence/      # 12 tasks
│   └── competitive/       # 12 tasks
├── fixtures/              # Local HTML served at localhost:9876
│   ├── server.ts
│   ├── navigation/
│   ├── forms/
│   ├── extraction/
│   ├── dom-complexity/
│   ├── error-recovery/
│   └── accessibility/
├── traces/                # Per-run trace output (gitignored)
│   └── {run-id}/
├── reports/               # Delta reports (committed)
├── history.json           # Run-over-run metrics (committed)
└── mcp-configs/           # MCP configs for competitive mode
    ├── safari-only.json
    └── playwright-only.json
```

---

## 10. Multi-Model Strategy

The benchmark supports running the same tasks across multiple models to measure:
- Whether Safari Pilot's tool quality lifts weaker models (Haiku → Sonnet → Opus)
- Per-model baselines for tracking improvement
- Whether recipe hints (future) differentially help different models

**Default run:** Sonnet only (fast, representative)
**Full run:** `--model sonnet,opus` — runs all tasks twice, once per model
**Reports:** Separate sections per model, cross-model comparison table

---

## 11. Integration with Existing Systems

### 11.1 TraceCollector

The existing `src/trace-collector.ts` captures traces in integration/e2e tests. The benchmark's `stream-parser.ts` produces compatible `TraceEvent` and `TraceSession` types. Both trace formats feed into the future recipe system's trace-to-recipe pipeline.

### 11.2 Existing Tests

Unit/integration/e2e tests remain unchanged. The benchmark is a separate system:
- Tests verify code correctness (must pass before merge)
- Benchmark measures agent effectiveness (runs after merge)
- Both produce traces that feed the recipe system

### 11.3 CI Integration

The benchmark does NOT run in CI (requires Safari, auth sessions, Claude Code). It runs locally after merging to main. A GitHub Action could run fixture-only tasks (no auth, no live sites) in the future if macOS runners are available.

---

## 12. What This Spec Does NOT Cover

- **Recipe system** — Separate P3 roadmap item. This spec builds the measurement infrastructure; recipes are built later.
- **WebArena/BrowserGym integration** — Future work. The task format is WebArena-compatible for forward compatibility.
- **Automated post-merge hooks** — Not in v1. Benchmark is manually triggered via `npx safari-pilot-bench`.
- **Task auto-generation** — The `intent_template` + `instantiation_dict` fields enable future variant generation, but v1 tasks are all hand-authored.
