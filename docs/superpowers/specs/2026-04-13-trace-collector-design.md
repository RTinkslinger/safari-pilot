# TraceCollector: Exhaustive Test Trace Capture for Recipe Seeding

**Date:** 2026-04-13
**Status:** Design approved, pending implementation plan
**Depends on:** Existing test infrastructure (integration + e2e tests)
**Feeds into:** P1 Benchmark Suite, P3 Recipe System

---

## Purpose

Every test run generates domain knowledge that currently vanishes when the terminal scrolls. The TraceCollector captures structured traces of every tool call during integration and e2e tests — what was tried, what worked, what failed, how elements were targeted, how long things took, what the auto-wait system did. This raw data accumulates in git-tracked JSON files, seeding the recipe system that gets built later in the roadmap.

**This is Phase 0 of the benchmark/recipe pipeline** — the minimal capture layer that starts accumulating data immediately, months before the recipe system is built.

## Scope

**Building:**
- `src/trace-collector.ts` — the TraceCollector class
- Vitest wiring in `test/integration/a11y-targeting-integration.test.ts`
- Vitest wiring in `test/e2e/a11y-targeting-e2e.test.ts`
- Unit tests for TraceCollector itself
- `benchmark/traces/` directory structure

**NOT building:**
- Benchmark runner (P1 roadmap item)
- Recipe extraction pipeline (P3 roadmap item)
- Domain observation extraction from model reasoning (requires LLM)
- Trace analysis, dashboards, or visualization
- Any changes to `src/server.ts` or tool modules (zero production code changes)

---

## Architecture

### Relationship to AuditLog

TraceCollector is **completely separate** from AuditLog. AuditLog is a security feature (redacts params, enforces retention, in-memory). TraceCollector is a learning feature (captures rich context, writes to disk, accumulates over time). They never interact.

### Integration Points

TraceCollector wraps tool calls via monkey-patching at two levels:

1. **Handler-direct** (integration tests): wraps `getHandler()` return values on tool module instances (`ExtractionTools`, `InteractionTools`, `NavigationTools`)
2. **Server pipeline** (e2e tests): wraps `SafariPilotServer.executeToolWithSecurity()`

Both capture the same trace events with the same schema. The e2e path additionally captures security pipeline context (domain policy, rate limiter state).

### Data Flow

```
Test calls tool (via handler or server)
    ↓
TraceCollector intercept (before)
    ↓
Original method executes
    ↓
TraceCollector intercept (after)
    ↓
TraceEvent created and appended to current session
    ↓
Test completes → endSession(success, failureReason)
    ↓
All tests done → flush() writes TraceRun JSON to disk
```

---

## Data Model

### TraceEvent (per tool call)

```typescript
interface TraceEvent {
  // Identity
  seq: number;                      // monotonic within session (1, 2, 3, ...)
  timestamp: string;                // ISO 8601

  // Tool call
  tool: string;                     // "safari_snapshot", "safari_click", etc.
  params: Record<string, unknown>;  // full params, sensitive values redacted

  // Targeting — how the element was found
  targeting: {
    method: 'ref' | 'locator' | 'selector' | 'none';
    ref?: string;                   // "e42" if ref was used
    locator?: {                     // locator descriptor if used
      role?: string;
      name?: string;
      text?: string;
      label?: string;
      testId?: string;
      placeholder?: string;
      exact?: boolean;
    };
    selector?: string;              // final CSS selector (resolved from ref/locator or direct)
  };

  // Result
  success: boolean;
  result: {
    summary: string;                // human-readable: "245 elements, 38 interactive, 38 refs"
    data?: unknown;                 // parsed result (snapshots truncated to 500 chars)
    error?: {
      code: string;
      message: string;
      hints: string[];
    };
  };

  // Timing breakdown
  timing: {
    total_ms: number;               // wall-clock from call to return
    auto_wait_ms?: number;          // time in actionability checks (if applicable)
    engine_ms: number;              // time in AppleScript/daemon/extension (from metadata.latencyMs)
  };

  // Engine
  engine: 'applescript' | 'daemon' | 'extension';
  degraded: boolean;                // engine fallback occurred
  degradedReason?: string;

  // Context
  domain: string;                   // hostname from tabUrl
  tabUrl?: string;                  // full URL
  pageTitle?: string;               // document.title when available (from snapshot/evaluate results)

  // Auto-wait details (populated for interaction tools that use waitAndExecute)
  autoWait?: {
    checks: string[];               // ['visible', 'stable', 'enabled', 'receivesEvents']
    allPassed: boolean;
    failedCheck?: string;           // 'not_visible', 'not_stable', etc.
    waited_ms: number;
    force: boolean;                 // was force mode used?
  };

  // Snapshot-specific (populated when tool is safari_snapshot)
  snapshot?: {
    elementCount: number;
    interactiveCount: number;
    refCount: number;               // number of refs assigned
    format: 'yaml' | 'json';
    truncatedSnapshot: string;      // first 500 chars of the snapshot output
  };

  // Recipe hints (future-ready — populated when recipe system exists)
  recipeHintsInjected?: string[];
  recipeHintsUseful?: boolean;      // set by future feedback loop
}
```

### TraceSession (per test)

```typescript
interface TraceSession {
  // Identity
  sessionId: string;                // "trace-{timestamp}-{randomHex}"
  runId: string;                    // groups all tests in one invocation
  testId: string;                   // vitest test name: "1. snapshot returns YAML with refs"
  suiteName: string;                // vitest describe name: "Suite 1: Wikipedia"
  testFile: string;                 // relative path: "test/integration/a11y-targeting-integration.test.ts"

  // Intent
  intent: string;                   // what the test is trying to accomplish (from test name or annotation)

  // Outcome
  success: boolean;
  failureReason?: string;           // error message if failed
  failureStep?: number;             // seq of the event where failure occurred

  // Events (ordered by seq)
  events: TraceEvent[];

  // Start/end state
  startUrl?: string;                // URL when session began
  endUrl?: string;                  // URL when session ended

  // Aggregate metrics
  metrics: {
    totalSteps: number;
    totalMs: number;
    successfulSteps: number;
    failedSteps: number;
    autoWaitTriggers: number;       // how many tool calls had auto-wait
    autoWaitTotalMs: number;        // cumulative auto-wait time
    autoWaitFailures: number;       // auto-wait checks that failed
    retriesOrFallbacks: number;
    enginesUsed: Record<string, number>;
    domainsVisited: string[];
    uniqueToolsUsed: string[];
    refTargetingCount: number;      // how many calls used ref targeting
    locatorTargetingCount: number;  // how many calls used locator targeting
    selectorTargetingCount: number; // how many calls used CSS selector
  };

  // Domain observations (manually added via trace.addObservation())
  domainObservations: string[];

  // Timing
  startedAt: string;                // ISO 8601
  endedAt: string;                  // ISO 8601
  durationMs: number;
}
```

### TraceRun (per test suite execution)

```typescript
interface TraceRun {
  // Identity
  runId: string;                    // "integ-{timestamp}" or "e2e-{timestamp}"
  type: 'integration' | 'e2e';     // which test tier

  // Environment
  environment: {
    safariPilotVersion: string;     // from package.json
    nodeVersion: string;            // process.version
    platform: string;               // process.platform
    arch: string;                   // process.arch
    gitCommit: string;              // short hash from `git rev-parse --short HEAD`
    gitBranch: string;              // from `git branch --show-current`
    timestamp: string;              // ISO 8601
  };

  // Test file
  testFile: string;

  // Sessions (one per test)
  sessions: TraceSession[];

  // Summary
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    totalMs: number;
    domainsTestedOnce: string[];
    toolsUsedAtLeastOnce: string[];
    avgStepsPerTest: number;
    avgMsPerTest: number;
    refTargetingUsage: number;      // % of tool calls that used refs
    locatorTargetingUsage: number;  // % that used locators
    autoWaitUsage: number;          // % that had auto-wait
  };
}
```

---

## TraceCollector Class API

```typescript
class TraceCollector {
  constructor(options: {
    runId: string;
    type: 'integration' | 'e2e';
    testFile: string;
  });

  // Session lifecycle
  startSession(testId: string, suiteName: string, intent?: string): void;
  endSession(success: boolean, failureReason?: string): void;

  // Monkey-patch tool modules (integration tests)
  wrapToolModule(module: ToolModuleLike, moduleName: string): void;

  // Monkey-patch server (e2e tests)
  wrapServer(server: SafariPilotServer): void;

  // Manual annotations
  addObservation(observation: string): void;
  setSessionStartUrl(url: string): void;
  setSessionEndUrl(url: string): void;

  // Restore original methods
  unwrap(): void;

  // Write all sessions to disk
  flush(outputDir: string): Promise<string>;  // returns file path written

  // Access current state (for assertions in tests)
  getCurrentSession(): TraceSession | null;
  getSessionCount(): number;
  getEventCount(): number;
}
```

### Wrapping Mechanics

**`wrapToolModule(module, name)`** — for integration tests:

Replaces the module's `getHandler(toolName)` so that returned handler functions are wrapped in trace-capturing interceptors. The original handler is preserved and called normally. The wrapper:
1. Records start time
2. Extracts targeting info from params (ref, locator fields, selector)
3. Calls original handler
4. Captures result, timing, engine metadata from the ToolResponse
5. Creates TraceEvent and appends to current session

**`wrapServer(server)`** — for e2e tests:

Replaces `server.executeToolWithSecurity` with a wrapped version that captures the same data plus security pipeline context. The original method is preserved.

### Redaction Rules

Same as AuditLog for consistency:
- `safari_fill` `value` param → `"[REDACTED]"`
- `safari_set_cookie` `value` param → `"[REDACTED]"`
- `safari_clipboard_write` `content` param → `"[REDACTED]"`
- `safari_evaluate` `script` param → truncated to 200 chars
- Snapshot YAML in `result.data` → truncated to 500 chars
- Full snapshot kept in `snapshot.truncatedSnapshot` field (500 chars)

---

## Test Wiring

### Integration Tests

```typescript
// At top of file
import { TraceCollector } from '../../src/trace-collector.js';

// In module scope
let trace: TraceCollector;

// Before all tests
beforeAll(() => {
  // ... existing setup ...
  trace = new TraceCollector({
    runId: `integ-${Date.now()}`,
    type: 'integration',
    testFile: 'test/integration/a11y-targeting-integration.test.ts',
  });
  trace.wrapToolModule(extract, 'extraction');
  trace.wrapToolModule(interact, 'interaction');
  trace.wrapToolModule(nav, 'navigation');
});

// Before each test (vitest provides task context)
beforeEach((ctx) => {
  const suiteName = ctx.task.suite?.name ?? 'unknown';
  const testName = ctx.task.name;
  trace.startSession(testName, suiteName, testName);
});

// After each test
afterEach((ctx) => {
  const passed = ctx.task.result?.state === 'pass';
  const error = ctx.task.result?.errors?.[0]?.message;
  trace.endSession(passed, error);
});

// After all tests
afterAll(async () => {
  // ... existing cleanup ...
  trace.unwrap();
  const tracePath = await trace.flush('benchmark/traces/integration');
  console.log(`Trace written to: ${tracePath}`);
});
```

### E2E Tests

Same pattern, but `wrapServer` instead of `wrapToolModule`:

```typescript
beforeAll(async () => {
  server = new SafariPilotServer();
  await server.initialize();
  trace = new TraceCollector({
    runId: `e2e-${Date.now()}`,
    type: 'e2e',
    testFile: 'test/e2e/a11y-targeting-e2e.test.ts',
  });
  trace.wrapServer(server);
});

// beforeEach, afterEach, afterAll — same as integration
```

### Safari Availability Guard

Both files already have `safariAvailable` checks. When Safari is unavailable (CI), tests skip and NO traces are written. TraceCollector's `flush()` is a no-op if there are zero sessions.

---

## Storage

### Directory Structure

```
benchmark/
└── traces/
    ├── integration/
    │   ├── 2026-04-13T16-30-00-abc1234.json
    │   └── 2026-04-14T09-15-00-def5678.json
    └── e2e/
        ├── 2026-04-13T16-45-00-abc1234.json
        └── 2026-04-14T09-20-00-def5678.json
```

### File Naming

`{ISO-timestamp}-{git-short-hash}.json`

Example: `2026-04-13T16-30-00-abc1234.json`

### Git Tracking

- `benchmark/traces/` is git-tracked (committed to repo)
- Each trace file is a self-contained `TraceRun` JSON
- Typical size: 5-50KB per run (depends on test count and snapshot sizes)
- When directory exceeds ~100 files, oldest traces can be archived or gitignored

---

## Extracting Trace Data (by the field)

For recipe extraction later, here's what each trace field enables:

| Field | Recipe extraction use |
|-------|---------------------|
| `targeting.method` + domain | "On linkedin.com, ref targeting succeeds 90% vs selector 60%" |
| `autoWait.failedCheck` + domain | "LinkedIn elements frequently fail 'not_visible' — page hydrates slowly" |
| `snapshot.interactiveCount` + domain | "Reddit averages 45 interactive elements; <10 indicates JS challenge" |
| `timing.auto_wait_ms` + domain | "X elements take avg 800ms to stabilize — CSS animations" |
| `result.error.hints` | Direct recipe candidates: "Element has display:none — may be inside hidden container" |
| `domainObservations` | Human-curated domain facts: "Wikipedia search is role=combobox not searchbox" |
| `success` + `events` sequence | Successful multi-step patterns extractable as AWM workflows |
| Cross-session `failedCheck` frequency | ExpeL-style heuristic: "On SPAs, 'not_stable' failures are 3x more common" |

---

## Unit Tests for TraceCollector

```
test/unit/trace-collector.test.ts

- creates trace events with correct schema
- assigns monotonic seq numbers
- tracks targeting method (ref, locator, selector, none)
- redacts sensitive params (fill value, cookie value, evaluate script)
- truncates snapshot data
- captures auto-wait details from tool responses
- captures timing breakdown
- startSession/endSession lifecycle
- multiple sessions per run
- endSession with failure tags the session and records failure step
- addObservation appends to current session
- wrapToolModule intercepts handler calls
- wrapServer intercepts executeToolWithSecurity
- unwrap restores original methods
- flush writes valid JSON to disk
- flush is no-op with zero sessions
- flush creates directory if needed
- environment metadata populated (node version, git commit)
- summary statistics computed correctly
- concurrent sessions throw (one at a time)
```

---

## What's Explicitly Not Built

1. **Automatic domain observation extraction** — requires LLM analysis of traces. Future work.
2. **Recipe candidate generation** — the trace→recipe pipeline. P3 roadmap.
3. **Trace analysis or visualization** — no dashboard, no aggregation tool.
4. **Benchmark task execution** — traces are captured from existing tests, not a benchmark runner.
5. **Trace storage rotation** — manual archival when directory gets large.
6. **Changes to production code** — zero modifications to server.ts, tool modules, or engines.
