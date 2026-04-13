# Test ↔ Benchmark ↔ Recipe Integration

How Safari Pilot's test infrastructure, benchmark suite, trace capture, and recipe system connect. Written after shipping a11y snapshots, auto-wait, and locator targeting — all with integration and e2e tests against X, Reddit, LinkedIn, Wikipedia, HN, and GitHub.

---

## 1. What Exists Today

### Unit Tests (1107 tests, no Safari needed)
```
test/unit/aria.test.ts          — 152 tests (snapshot JS generation, role maps, ref mechanics)
test/unit/auto-wait.test.ts     — 99 tests (actionability check JS, profiles, force mode)
test/unit/locator.test.ts       — 106 tests (locator resolution JS, role selectors, matching)
test/unit/tools/*.test.ts       — 350+ tests (all 14 tool modules)
test/unit/security/*.test.ts    — 200+ tests (9 security layers)
test/unit/config.test.ts        — 17 tests
test/unit/server.test.ts        — 5 tests
... and more
```
**Purpose:** Verify code correctness. Mock-based. Run in CI on every push.
**Benchmark role:** None — these are code-level, not task-level.

### Integration Tests (25 tests, needs Safari)
```
test/integration/a11y-targeting-integration.test.ts
  Suite 1: Snapshot format/refs/scope/JSON on Wikipedia (4 tests)
  Suite 2: Ref lifecycle on example.com (3 tests)
  Suite 3: Auto-wait behavior on example.com (2 tests)
  Suite 4: Locator targeting on Wikipedia (4 tests)
  Suite 5: X (Twitter) authenticated (4 tests)
  Suite 6: Reddit authenticated (4 tests)
  Suite 7: LinkedIn authenticated (4 tests)
```
**Purpose:** Verify features work together against real sites.
**Benchmark role:** These are SEED MATERIAL for benchmark tasks. Each test verifies a specific capability; benchmark tasks will test goal completion.

### E2E Tests (33 tests, needs Safari + full security pipeline)
```
test/e2e/a11y-targeting-e2e.test.ts
  Suite 1: Wikipedia full pipeline (6 tests — snapshot, ref stability, audit log, scoped, ref click, nav back)
  Suite 2: Hacker News locator targeting (5 tests — text locator click, role locator, form fill, force mode)
  Suite 3: Auto-wait on example.com (3 tests — click, snapshot after nav, diagnostic errors)
  Suite 4: GitHub ref + locator (3 tests — snapshot, roles, sign-in locator)
  Suite 5: X authenticated (5 tests — feed snapshot, nav landmarks, search, tweet buttons, scoped timeline)
  Suite 6: Reddit authenticated (5 tests — feed, search fill, subreddit navigation, post-nav snapshot)
  Suite 7: LinkedIn authenticated (6 tests — rich ARIA roles, nav locators, search fill, feed clicks, post-nav)
```
**Purpose:** Verify the full MCP server pipeline (security → engine → Safari) against live sites.
**Benchmark role:** These are PROTOTYPE benchmark tasks. They verify features, but the benchmark needs to verify goals.

---

## 2. From Tests to Benchmark Tasks

### The Gap

Current tests ask: "Does `safari_click` with `ref: 'e12'` work on Wikipedia?"
Benchmark tasks ask: "Can the agent find the population of Tokyo on Wikipedia and extract it?"

Current tests drive tool calls directly from test code.
Benchmark tasks give Claude a natural language intent and measure whether it succeeds.

### Migration Path

Each existing test suite maps to a benchmark category, but the benchmark tasks are more ambitious:

| Existing Test | Benchmark Category | Benchmark Task Example |
|--------------|-------------------|----------------------|
| Wikipedia snapshot | Data extraction | "Extract all section headings from the Safari (web browser) article" |
| Wikipedia ref click | Navigation | "Navigate from Main Page to the article about WebKit via link refs" |
| Wikipedia scoped snapshot | Accessibility | "Find the search input using only the a11y tree (no CSS selectors)" |
| Wikipedia locator fill | Form interaction | "Search Wikipedia for 'browser automation' and extract the first 3 result titles" |
| HN text locator click | Intelligence | "Find the most discussed post on HN today and summarize its top 3 comments" |
| HN form fill | Form interaction | "Fill the HN login form with test credentials and detect the error message" |
| X feed snapshot | Intelligence | "On X, find the latest post by @anthropicdotcom and get the reply count" |
| X nav landmarks | Accessibility | "Navigate X entirely via ARIA roles — go from Home to Explore to Search" |
| Reddit search fill | Multi-step | "Search Reddit for 'Safari automation' and extract the top 5 post titles" |
| Reddit subreddit nav | Navigation | "Navigate to r/programming via the snapshot ref system" |
| LinkedIn nav locators | Accessibility | "Find LinkedIn's messaging section using only role+name locators" |
| LinkedIn search fill | Intelligence | "Search LinkedIn for engineers at Anthropic and list 3 names + titles" |
| GitHub sign-in locator | Data extraction | "Extract the 3 most-starred trending repos from GitHub this week" |
| example.com auto-wait | Error recovery | "Click a non-existent element and verify the diagnostic error is actionable" |

### What to Keep, What to Evolve

**Keep as-is (regression tests):**
- All unit tests — code correctness, run in CI
- Integration tests — feature verification, run before benchmark

**Evolve into benchmark tasks:**
- E2E tests become the SEED for benchmark task definitions
- Each e2e test inspired by a real scenario → extract the intent → define as a benchmark JSON task
- The e2e test code stays for regression; the benchmark task tests goal achievement

**Add new:**
- Intelligence-tier tasks (12, per the spec) — these have no current test equivalent
- Competitive dual-mode tasks (12) — require Playwright MCP alongside Safari Pilot
- Trace capture middleware — wraps tool calls to emit structured traces

---

## 3. Trace Logging Architecture

### What Gets Logged

Every tool call through the MCP server should optionally emit a trace event:

```
Tool call → Security pipeline → Engine execution → Result
                                                      ↓
                                              Trace event emitted
```

### Trace Event Schema

```typescript
interface TraceEvent {
  timestamp: string;          // ISO 8601
  tool: string;               // e.g., "safari_snapshot"
  params: Record<string, unknown>;  // tool params (sensitive fields redacted)
  result: {
    success: boolean;
    summary: string;          // e.g., "245 elements, 38 interactive"
    error?: string;
  };
  timing: {
    total_ms: number;
    auto_wait_ms?: number;    // time spent in actionability checks
    engine_ms: number;        // time in AppleScript/daemon/extension
  };
  engine: 'applescript' | 'daemon' | 'extension';
  domain: string;             // extracted from tabUrl
  recipe_hints?: string[];    // domain hints that were injected (future)
}
```

### Trace Session Schema

A trace session groups all events from a single benchmark task:

```typescript
interface TraceSession {
  task_id: string;            // benchmark task ID
  run_id: string;             // benchmark run ID
  timestamp: string;
  success: boolean;
  domain: string;
  events: TraceEvent[];
  metrics: {
    total_steps: number;
    total_ms: number;
    retries: number;
    auto_wait_triggers: number;
    engines_used: Record<string, number>;
  };
  domain_observations: string[];  // model-generated observations about the site
}
```

### Where Traces Live

```
benchmark/
├── tasks/              # Task definitions (JSON)
│   ├── navigation/
│   ├── forms/
│   ├── intelligence/
│   └── competitive/
├── traces/             # Raw trace output per run
│   ├── bench-20260413-001/
│   │   ├── nav-001.json
│   │   ├── intel-003.json
│   │   └── ...
│   └── bench-20260414-001/
├── reports/            # Delta reports (markdown)
│   └── 2026-04-13-abc1234.md
├── history.json        # Run-over-run aggregate metrics
└── fixtures/           # Local HTML for deterministic tests
    ├── forms/
    ├── shadow-dom/
    └── ...
```

### Implementation: Trace Middleware

Add a `TraceCollector` class that wraps `SafariPilotServer.executeToolWithSecurity()`:

```typescript
class TraceCollector {
  private events: TraceEvent[] = [];
  
  wrap(server: SafariPilotServer): void {
    const original = server.executeToolWithSecurity.bind(server);
    server.executeToolWithSecurity = async (name, params) => {
      const start = Date.now();
      try {
        const result = await original(name, params);
        this.events.push({
          timestamp: new Date().toISOString(),
          tool: name,
          params: this.redact(params),
          result: { success: true, summary: this.summarize(result) },
          timing: { total_ms: Date.now() - start, engine_ms: result.metadata.latencyMs },
          engine: result.metadata.engine,
          domain: this.extractDomain(params),
        });
        return result;
      } catch (err) {
        this.events.push({
          timestamp: new Date().toISOString(),
          tool: name,
          params: this.redact(params),
          result: { success: false, summary: '', error: err.message },
          timing: { total_ms: Date.now() - start, engine_ms: 0 },
          engine: 'applescript',
          domain: this.extractDomain(params),
        });
        throw err;
      }
    };
  }

  flush(): TraceEvent[] {
    const events = [...this.events];
    this.events = [];
    return events;
  }
}
```

---

## 4. What Needs Tracking

### Per Roadmap Item

After every roadmap item ships, the benchmark run produces:

| Metric | What it tells you | Where it's stored |
|--------|-------------------|-------------------|
| Overall success rate | Is Safari Pilot getting better? | `benchmark/history.json` |
| Per-category success rate | Which capabilities improved? | `benchmark/reports/{date}.md` |
| Intelligence-tier rate | Are we ready for the recipe system? | `benchmark/history.json` |
| Competitive win rate | Are we beating Playwright? | `benchmark/reports/{date}.md` |
| Mean steps per task | Is the agent getting more efficient? | `benchmark/history.json` |
| P50/P95 latency | Is performance stable? | `benchmark/history.json` |
| Flaky task count | Is test infrastructure reliable? | `benchmark/reports/{date}.md` |
| New recipe candidates | What did we learn about domains? | `recipes/candidates/` |

### Per Domain (from traces)

| Signal | What it reveals | How it's captured |
|--------|----------------|-------------------|
| Success rate on domain | How well does Safari Pilot handle this site? | Aggregate from traces |
| Common failure patterns | What goes wrong on this domain? | Error events in traces |
| Selector/locator effectiveness | Do refs work better than CSS on this site? | Tool params in traces |
| Auto-wait trigger frequency | Does this site have flaky/dynamic elements? | Timing data in traces |
| Domain observations | What did Claude notice about site behavior? | Model-generated, in traces |

### Maintenance Dashboard

Track over time:

```
                    Shipped Items →
         baseline   downloads   PDF   CI-runner   video   recipes
Overall    76.7%      80.0%    82.5%    85.0%    86.7%    92.0%
Intel       16.7%      25.0%    25.0%    33.3%    33.3%    75.0%  ← recipe impact
Compet.     58.3%      66.7%    66.7%    66.7%    75.0%    83.3%
Steps/task    8.2        7.5      7.5      7.1      7.1      5.3  ← recipes reduce steps
```

---

## 5. What Needs Maintenance

### Live Site Tests (high maintenance)

| Concern | Mitigation |
|---------|-----------|
| Site layout changes break assertions | Use resilient assertions: role-based, not CSS-based. Check for content patterns, not exact strings. |
| Authentication expires | Document re-login steps. Detect auth failures early (check for login redirects). |
| Rate limiting | Space requests, use modest concurrency. If blocked, skip with clear skip reason. |
| New cookie banners/overlays | Auto-dismiss common patterns (future recipe). Detect and flag unknown overlays. |
| Flaky tasks | Track flaky rate per task. Quarantine with `@flaky` tag if flaky >20% of runs. Investigate root cause. |

### Benchmark Tasks (medium maintenance)

| Concern | Mitigation |
|---------|-----------|
| Tasks become stale (site changes meaning) | Review intelligence-tier tasks quarterly. Replace outdated ones. |
| Eval criteria too strict/loose | Use eval_fallback (LLM judge) when programmatic eval fails. Calibrate thresholds. |
| Task count grows unwieldy | Cap at 150. When adding, consider removing a low-signal task. |
| Competitive tasks need Playwright | Make competitive tier opt-in (`--competitive` flag). Skip gracefully if Playwright MCP not available. |

### Recipes (low maintenance initially, grows)

| Concern | Mitigation |
|---------|-----------|
| Stale domain facts | `valid_since` + `last_verified` timestamps. If fact >90 days unverified, demote confidence. |
| Contradicting heuristics | ExpeL voting resolves: if a heuristic is downvoted below threshold, remove. |
| Recipe bloat | Cap active recipes per domain (20 facts, 10 workflows, 30 heuristics). Prune by confidence * age. |
| Manual input overhead | CLI tooling: `npx safari-pilot recipe add/list/prune`. Keep it low-friction. |

---

## 6. How It All Connects

```
                    ┌──────────────────────────────────────────┐
                    │           ROADMAP ITEM SHIPS              │
                    └────────────────┬─────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────────────┐
                    │         1. Unit Tests (CI)                │
                    │   1107 tests — code correctness           │
                    │   Must pass before merge                  │
                    └────────────────┬─────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────────────┐
                    │     2. Integration Tests (Safari)         │
                    │   25 tests — feature verification         │
                    │   Real sites: Wiki, example, X, Reddit, LI│
                    └────────────────┬─────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────────────┐
                    │      3. E2E Tests (Full Pipeline)         │
                    │   33 tests — security + engine + Safari   │
                    │   All 7 sites through executeToolWithSec  │
                    └────────────────┬─────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────────────┐
                    │       4. Benchmark Suite (Post-merge)     │
                    │   120 tasks — goal completion rate         │
                    │   Natural language intents → Claude → tools│
                    │   Includes intelligence-tier + competitive │
                    │                                           │
                    │   Emits: traces, delta report, metrics    │
                    └───────┬──────────────┬───────────────────┘
                            │              │
               ┌────────────▼──┐    ┌──────▼──────────────────┐
               │  5. Traces    │    │  6. Delta Report         │
               │  Per-task JSON│    │  Success rates, deltas   │
               │  Tool calls,  │    │  Competitive comparison  │
               │  timing, errs │    │  Intelligence KPI        │
               │  Domain obs.  │    │  Regression alerts       │
               └────────┬──────┘    └──────────────────────────┘
                        │
               ┌────────▼──────────────────────────────────────┐
               │     7. Recipe Candidates (auto-extracted)      │
               │  Domain observations → candidate facts         │
               │  Success patterns → candidate workflows        │
               │  Failure patterns → candidate heuristics       │
               └────────┬──────────────────────────────────────┘
                        │
               ┌────────▼──────────────────────────────────────┐
               │     8. Human Review + Manual Input             │
               │  Promote candidates → active recipes           │
               │  Add manual domain knowledge                   │
               │  ExpeL voting on heuristics                    │
               └────────┬──────────────────────────────────────┘
                        │
               ┌────────▼──────────────────────────────────────┐
               │     9. Active Recipes                          │
               │  Layer 1: Domain facts (per-site JSON)         │
               │  Layer 2: Workflows (parameterized procedures) │
               │  Layer 3: Heuristics (voted cross-domain rules)│
               └────────┬──────────────────────────────────────┘
                        │
               ┌────────▼──────────────────────────────────────┐
               │     10. MCP-Native Delivery                    │
               │  safari_snapshot response includes:            │
               │    domain_hints[], workflows[], heuristics[]   │
               │  Zero extra tool calls                         │
               └────────┬──────────────────────────────────────┘
                        │
                        │  (feeds back into step 4)
                        ▼
               Next benchmark run measures recipe impact
               Intelligence-tier climbing = recipes working
```

### The Feedback Loop

1. Ship roadmap item → run benchmark
2. Benchmark produces traces → traces produce recipe candidates
3. Review + promote candidates → active recipes
4. Next roadmap item ships → run benchmark WITH recipes active
5. Compare: did intelligence-tier improve? Did steps decrease?
6. Repeat

**The intelligence-tier success rate is the single number that tells you whether the whole system is working.** It starts at ~15-20%. When it crosses 80%, Safari Pilot browses like a skilled human.

---

## 7. Immediate Next Steps

1. **Build the benchmark runner** (Phase 1 from the spec) — task JSON schema, runner CLI, eval engine, trace capture, delta reports
2. **Define the initial 120 tasks** — start with the 33 e2e tests as inspiration, add intelligence-tier and competitive tasks
3. **Run baseline benchmark** — before shipping the next roadmap item (file downloads), establish the starting numbers
4. **After every subsequent roadmap ship**: run benchmark, generate report, extract recipe candidates
5. **After P2 (CI runner + visual regression + video) completes**: build the recipe system, seed from accumulated traces
