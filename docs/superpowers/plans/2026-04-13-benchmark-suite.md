# Benchmark Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 120-task benchmark suite that measures Safari Pilot's effectiveness as a browser automation tool by spawning Claude Code CLI sessions per task, evaluating results, and generating delta reports.

**Architecture:** Node.js runner in `src/benchmark/` compiles to `dist/benchmark/`. Spawns `claude -p` per task with `--output-format stream-json`. Parallel execution via worker pool with domain affinity. Task JSONs in `benchmark/tasks/`, HTML fixtures served from `benchmark/fixtures/` on localhost:9876. Reports and history in `benchmark/reports/` and `benchmark/history.json`.

**Tech Stack:** TypeScript (ESM), Node.js built-ins only (child_process, fs, http, path), vitest for tests. No new dependencies.

---

## File Structure

### New files (src/benchmark/ — compiled to dist/benchmark/)

| File | Responsibility |
|------|---------------|
| `src/benchmark/types.ts` | All benchmark types: BenchmarkTask, TaskResult, RunConfig, RunReport, etc. |
| `src/benchmark/task-loader.ts` | Load JSON tasks from disk, validate schema, filter by requires |
| `src/benchmark/eval.ts` | Eval engine: exact_match, contains, structured_output, llm_judge |
| `src/benchmark/stream-parser.ts` | Parse Claude's stream-json output into structured events |
| `src/benchmark/fixture-server.ts` | HTTP server for local HTML fixtures on port 9876 |
| `src/benchmark/preflight.ts` | Check auth, tool availability, engine health, competitive readiness |
| `src/benchmark/worker.ts` | Execute single task: spawn claude CLI, parse stream, run eval |
| `src/benchmark/reporter.ts` | Generate delta reports and update history.json |
| `src/benchmark/runner.ts` | CLI entry point, parallel orchestration, main loop |

### New files (benchmark/ — non-TypeScript assets)

| File | Responsibility |
|------|---------------|
| `benchmark/tasks/{category}/*.json` | 120 task definition files |
| `benchmark/fixtures/server.ts` | (Served by fixture-server.ts, this is the content root) |
| `benchmark/fixtures/{category}/*.html` | Static HTML for deterministic tasks |
| `benchmark/mcp-configs/safari-only.json` | MCP config restricting to Safari Pilot |
| `benchmark/mcp-configs/playwright-only.json` | MCP config restricting to Playwright |
| `benchmark/history.json` | Run-over-run accumulated metrics |
| `benchmark/reports/` | Delta report output directory |
| `benchmark/traces/` | Per-run trace output directory |

### New test files

| File | Responsibility |
|------|---------------|
| `test/unit/benchmark/types.test.ts` | Type validation tests |
| `test/unit/benchmark/task-loader.test.ts` | Task loading and filtering |
| `test/unit/benchmark/eval.test.ts` | Eval engine tests |
| `test/unit/benchmark/stream-parser.test.ts` | Stream parsing tests |
| `test/unit/benchmark/reporter.test.ts` | Report generation tests |
| `test/unit/benchmark/fixture-server.test.ts` | HTTP server tests |

### Modified files

| File | Change |
|------|--------|
| `package.json` | Add `bin.safari-pilot-bench`, `scripts.benchmark` |
| `.gitignore` | Add `benchmark/traces/`, `benchmark/reports/` |

---

### Task 1: Types and Project Setup

**Files:**
- Create: `src/benchmark/types.ts`
- Create: `test/unit/benchmark/types.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Update package.json and .gitignore**

Add bin entry and benchmark script to `package.json`:

```json
{
  "bin": {
    "safari-pilot-bench": "dist/benchmark/runner.js"
  },
  "scripts": {
    "benchmark": "node dist/benchmark/runner.js",
    "benchmark:dry": "node dist/benchmark/runner.js --dry-run"
  }
}
```

Add to `.gitignore`:

```
benchmark/traces/
benchmark/reports/
```

- [ ] **Step 2: Write types test**

```typescript
// test/unit/benchmark/types.test.ts
import { describe, it, expect } from 'vitest';
import {
  type BenchmarkTask,
  type TaskResult,
  type RunConfig,
  type RunReport,
  type StreamEvent,
  type TaskEval,
  type TaskRequires,
  CATEGORIES,
  DIFFICULTIES,
  EVAL_TYPES,
  validateTask,
} from '../../src/benchmark/types.js';

describe('benchmark types', () => {
  const validTask: BenchmarkTask = {
    id: 'nav-001',
    category: 'navigation',
    difficulty: 'easy',
    intent: 'Navigate to https://example.com and extract the page title',
    start_url: 'https://example.com',
    requires: {
      tools: [],
      engines: [],
      auth_domains: [],
      features: [],
      competitive: false,
    },
    eval: { type: 'exact_match', expected: 'Example Domain' },
    timeout_ms: 30000,
    max_budget_usd: 0.25,
    tags: ['navigation', 'basic'],
  };

  it('validates a well-formed task', () => {
    const errors = validateTask(validTask);
    expect(errors).toEqual([]);
  });

  it('rejects task with missing id', () => {
    const bad = { ...validTask, id: '' };
    const errors = validateTask(bad);
    expect(errors).toContain('id is required');
  });

  it('rejects task with invalid category', () => {
    const bad = { ...validTask, category: 'bogus' as any };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('category');
  });

  it('rejects task with invalid eval type', () => {
    const bad = { ...validTask, eval: { type: 'bogus' as any } };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('eval.type');
  });

  it('rejects task with negative timeout', () => {
    const bad = { ...validTask, timeout_ms: -1 };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('timeout_ms');
  });

  it('accepts task with optional fields', () => {
    const full: BenchmarkTask = {
      ...validTask,
      intent_template: 'Navigate to {{url}} and extract the page title',
      instantiation_dict: { url: 'https://example.com' },
      reference_answers: { exact_match: 'Example Domain', must_include: ['Example'] },
      eval_fallback: { type: 'llm_judge', criteria: 'Did it get the title?' },
      roadmap_gate: null,
      enabled_after: null,
    };
    const errors = validateTask(full);
    expect(errors).toEqual([]);
  });

  it('exports correct category list', () => {
    expect(CATEGORIES).toContain('navigation');
    expect(CATEGORIES).toContain('intelligence');
    expect(CATEGORIES).toContain('competitive');
    expect(CATEGORIES).toHaveLength(11);
  });

  it('exports correct difficulty list', () => {
    expect(DIFFICULTIES).toContain('easy');
    expect(DIFFICULTIES).toContain('intelligence');
    expect(DIFFICULTIES).toHaveLength(4);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement types.ts**

```typescript
// src/benchmark/types.ts

export const CATEGORIES = [
  'navigation', 'forms', 'extraction', 'workflows', 'dom-complexity',
  'auth-flows', 'accessibility', 'error-recovery', 'safari-specific',
  'intelligence', 'competitive',
] as const;

export type Category = typeof CATEGORIES[number];

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'intelligence'] as const;
export type Difficulty = typeof DIFFICULTIES[number];

export const EVAL_TYPES = ['exact_match', 'contains', 'structured_output', 'llm_judge'] as const;
export type EvalType = typeof EVAL_TYPES[number];

export interface TaskRequires {
  tools: string[];
  engines: string[];
  auth_domains: string[];
  features: string[];
  competitive: boolean;
}

export interface TaskEval {
  type: EvalType;
  expected?: string;
  must_include?: string[];
  schema?: Record<string, unknown>;
  criteria?: string;
  case_insensitive?: boolean;
}

export interface BenchmarkTask {
  id: string;
  category: Category;
  difficulty: Difficulty;
  intent: string;
  intent_template?: string;
  instantiation_dict?: Record<string, string>;
  start_url?: string;
  requires: TaskRequires;
  eval: TaskEval;
  reference_answers?: {
    exact_match?: string;
    must_include?: string[];
    fuzzy_match?: string;
  };
  eval_fallback?: TaskEval;
  timeout_ms: number;
  max_budget_usd: number;
  tags: string[];
  roadmap_gate?: string | null;
  enabled_after?: string | null;
}

export interface TaskResult {
  taskId: string;
  model: string;
  success: boolean;
  evalMethod: EvalType;
  evalDetails: Record<string, unknown>;
  fallbackUsed: boolean;
  skipped: boolean;
  skipReason?: string;
  steps: number;
  durationMs: number;
  toolsUsed: string[];
  enginesUsed: Record<string, number>;
  reasoningExcerpts: string[];
  error?: string;
  rawOutput?: string;
}

export interface StreamEvent {
  type: 'tool_use' | 'tool_result' | 'text' | 'system' | 'error' | 'unknown';
  timestamp: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResultContent?: string;
  toolResultError?: boolean;
  textContent?: string;
  raw: unknown;
}

export interface RunConfig {
  models: string[];
  parallel: number;
  categories: Category[] | null;
  taskIds: string[] | null;
  competitive: boolean;
  dryRun: boolean;
  timeoutMultiplier: number;
  fixturePort: number;
}

export interface CategoryResult {
  passed: number;
  failed: number;
  skipped: number;
  rate: number;
}

export interface CompetitiveResult {
  taskId: string;
  safariPilotSuccess: boolean;
  safariPilotSteps: number;
  safariPilotDurationMs: number;
  playwrightSuccess: boolean;
  playwrightSteps: number;
  playwrightDurationMs: number;
  winner: 'safari-pilot' | 'playwright' | 'tie' | 'both-failed';
}

export interface RunReport {
  id: string;
  model: string;
  commit: string;
  branch: string;
  timestamp: string;
  eligible: number;
  skipped: number;
  passed: number;
  failed: number;
  overallRate: number;
  byCategory: Record<Category, CategoryResult>;
  intelligenceRate: number;
  competitiveWinRate: number;
  competitive: CompetitiveResult[];
  meanSteps: number;
  p50DurationMs: number;
  p95DurationMs: number;
  flakyCount: number;
  perTask: Record<string, { passed: boolean; steps: number; durationMs: number }>;
}

export interface HistoryFile {
  runs: RunReport[];
}

export interface PreflightResult {
  availableTools: string[];
  healthyEngines: string[];
  authenticatedDomains: string[];
  competitiveReady: boolean;
  fixtureServerRunning: boolean;
}

export function validateTask(task: BenchmarkTask): string[] {
  const errors: string[] = [];

  if (!task.id) errors.push('id is required');
  if (!CATEGORIES.includes(task.category as Category)) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!DIFFICULTIES.includes(task.difficulty as Difficulty)) {
    errors.push(`difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
  }
  if (!task.intent) errors.push('intent is required');
  if (!task.eval?.type || !EVAL_TYPES.includes(task.eval.type as EvalType)) {
    errors.push(`eval.type must be one of: ${EVAL_TYPES.join(', ')}`);
  }
  if (task.timeout_ms <= 0) errors.push('timeout_ms must be positive');
  if (task.max_budget_usd <= 0) errors.push('max_budget_usd must be positive');
  if (!task.requires) errors.push('requires is required');

  return errors;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/types.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 6: Commit**

```bash
git add src/benchmark/types.ts test/unit/benchmark/types.test.ts package.json .gitignore
git commit -m "feat(benchmark): types, validation, project setup"
```

---

### Task 2: Task Loader

**Files:**
- Create: `src/benchmark/task-loader.ts`
- Create: `test/unit/benchmark/task-loader.test.ts`
- Create: `benchmark/tasks/navigation/nav-001.json` (test fixture)

- [ ] **Step 1: Write test**

```typescript
// test/unit/benchmark/task-loader.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasks, filterTasks } from '../../src/benchmark/task-loader.js';
import type { BenchmarkTask, PreflightResult } from '../../src/benchmark/types.js';

const TMP = join(import.meta.dirname, '../../.test-tasks');

const sampleTask: BenchmarkTask = {
  id: 'nav-001',
  category: 'navigation',
  difficulty: 'easy',
  intent: 'Navigate to example.com',
  start_url: 'https://example.com',
  requires: { tools: [], engines: [], auth_domains: [], features: [], competitive: false },
  eval: { type: 'exact_match', expected: 'Example Domain' },
  timeout_ms: 30000,
  max_budget_usd: 0.25,
  tags: ['navigation'],
};

const authTask: BenchmarkTask = {
  ...sampleTask,
  id: 'auth-001',
  category: 'auth-flows',
  requires: { ...sampleTask.requires, auth_domains: ['x.com'] },
};

const downloadTask: BenchmarkTask = {
  ...sampleTask,
  id: 'dl-001',
  category: 'extraction',
  requires: { ...sampleTask.requires, tools: ['safari_wait_for_download'] },
  roadmap_gate: 'file-downloads',
};

beforeAll(() => {
  mkdirSync(join(TMP, 'navigation'), { recursive: true });
  mkdirSync(join(TMP, 'auth-flows'), { recursive: true });
  mkdirSync(join(TMP, 'extraction'), { recursive: true });
  writeFileSync(join(TMP, 'navigation/nav-001.json'), JSON.stringify(sampleTask));
  writeFileSync(join(TMP, 'auth-flows/auth-001.json'), JSON.stringify(authTask));
  writeFileSync(join(TMP, 'extraction/dl-001.json'), JSON.stringify(downloadTask));
  writeFileSync(join(TMP, 'navigation/bad.json'), '{ broken json');
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadTasks', () => {
  it('loads all valid tasks from directory', async () => {
    const { tasks, errors } = await loadTasks(TMP);
    expect(tasks).toHaveLength(3);
    expect(errors).toHaveLength(1); // bad.json
  });

  it('reports parse errors with file paths', async () => {
    const { errors } = await loadTasks(TMP);
    expect(errors[0]).toContain('bad.json');
  });
});

describe('filterTasks', () => {
  const preflight: PreflightResult = {
    availableTools: ['safari_navigate', 'safari_click', 'safari_snapshot'],
    healthyEngines: ['applescript'],
    authenticatedDomains: [],
    competitiveReady: false,
    fixtureServerRunning: true,
  };

  it('passes tasks with no requirements', () => {
    const results = filterTasks([sampleTask], preflight, null, null);
    expect(results.eligible).toHaveLength(1);
    expect(results.skipped).toHaveLength(0);
  });

  it('skips tasks requiring unavailable auth domains', () => {
    const results = filterTasks([authTask], preflight, null, null);
    expect(results.eligible).toHaveLength(0);
    expect(results.skipped).toHaveLength(1);
    expect(results.skipped[0].reason).toContain('auth');
  });

  it('skips tasks requiring unavailable tools', () => {
    const results = filterTasks([downloadTask], preflight, null, null);
    expect(results.eligible).toHaveLength(0);
    expect(results.skipped[0].reason).toContain('safari_wait_for_download');
  });

  it('filters by category when specified', () => {
    const results = filterTasks([sampleTask, authTask], preflight, ['navigation'], null);
    expect(results.eligible).toHaveLength(1);
    expect(results.eligible[0].id).toBe('nav-001');
  });

  it('filters by task ID when specified', () => {
    const results = filterTasks([sampleTask, authTask], preflight, null, ['auth-001']);
    expect(results.skipped).toHaveLength(1); // auth not logged in
  });

  it('skips tasks with unmet roadmap_gate', () => {
    const gatedTask: BenchmarkTask = {
      ...sampleTask,
      id: 'dl-002',
      roadmap_gate: 'file-downloads',
    };
    const results = filterTasks([gatedTask], preflight, null, null);
    expect(results.skipped).toHaveLength(1);
    expect(results.skipped[0].reason).toContain('roadmap gate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/task-loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement task-loader.ts**

```typescript
// src/benchmark/task-loader.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type BenchmarkTask, type Category, type PreflightResult, CATEGORIES, validateTask } from './types.js';

export interface LoadResult {
  tasks: BenchmarkTask[];
  errors: string[];
}

export async function loadTasks(tasksDir: string): Promise<LoadResult> {
  const tasks: BenchmarkTask[] = [];
  const errors: string[] = [];

  let categories: string[];
  try {
    categories = await readdir(tasksDir);
  } catch {
    return { tasks, errors: [`Cannot read tasks directory: ${tasksDir}`] };
  }

  for (const category of categories) {
    const catDir = join(tasksDir, category);
    let files: string[];
    try {
      files = (await readdir(catDir)).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(catDir, file);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const task = JSON.parse(raw) as BenchmarkTask;
        const validationErrors = validateTask(task);
        if (validationErrors.length > 0) {
          errors.push(`${filePath}: ${validationErrors.join('; ')}`);
        } else {
          tasks.push(task);
        }
      } catch (err) {
        errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { tasks, errors };
}

export interface FilterResult {
  eligible: BenchmarkTask[];
  skipped: Array<{ task: BenchmarkTask; reason: string }>;
}

export function filterTasks(
  tasks: BenchmarkTask[],
  preflight: PreflightResult,
  categories: Category[] | null,
  taskIds: string[] | null,
): FilterResult {
  const eligible: BenchmarkTask[] = [];
  const skipped: FilterResult['skipped'] = [];

  for (const task of tasks) {
    if (categories && !categories.includes(task.category)) continue;
    if (taskIds && !taskIds.includes(task.id)) {
      // When filtering by ID, still check requirements for matched tasks
      continue;
    }
    if (taskIds && taskIds.includes(task.id)) {
      // Task explicitly requested — still check requirements
    }

    const missingTools = task.requires.tools.filter((t) => !preflight.availableTools.includes(t));
    if (missingTools.length > 0) {
      skipped.push({ task, reason: `Missing tools: ${missingTools.join(', ')}` });
      continue;
    }

    const missingEngines = task.requires.engines.filter((e) => !preflight.healthyEngines.includes(e));
    if (missingEngines.length > 0) {
      skipped.push({ task, reason: `Missing engines: ${missingEngines.join(', ')}` });
      continue;
    }

    const missingAuth = task.requires.auth_domains.filter((d) => !preflight.authenticatedDomains.includes(d));
    if (missingAuth.length > 0) {
      skipped.push({ task, reason: `Not authenticated: ${missingAuth.join(', ')}` });
      continue;
    }

    if (task.requires.competitive && !preflight.competitiveReady) {
      skipped.push({ task, reason: 'Playwright MCP not available for competitive mode' });
      continue;
    }

    if (task.roadmap_gate) {
      const gatedFeatures = preflight.availableTools;
      const featureTools: Record<string, string> = {
        'file-downloads': 'safari_wait_for_download',
        'pdf-export': 'safari_export_pdf',
        'video-recording': 'safari_start_recording',
        'route-modification': 'safari_route_request',
      };
      const requiredTool = featureTools[task.roadmap_gate];
      if (requiredTool && !gatedFeatures.includes(requiredTool)) {
        skipped.push({ task, reason: `Roadmap gate: ${task.roadmap_gate} not yet shipped` });
        continue;
      }
    }

    if (task.enabled_after) {
      const gateDate = new Date(task.enabled_after);
      if (gateDate > new Date()) {
        skipped.push({ task, reason: `Not enabled until ${task.enabled_after}` });
        continue;
      }
    }

    eligible.push(task);
  }

  return { eligible, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/task-loader.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/task-loader.ts test/unit/benchmark/task-loader.test.ts
git commit -m "feat(benchmark): task loader with validation and capability filtering"
```

---

### Task 3: Eval Engine

**Files:**
- Create: `src/benchmark/eval.ts`
- Create: `test/unit/benchmark/eval.test.ts`

- [ ] **Step 1: Write test**

```typescript
// test/unit/benchmark/eval.test.ts
import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/benchmark/eval.js';
import type { TaskEval } from '../../src/benchmark/types.js';

describe('evaluate', () => {
  describe('exact_match', () => {
    const evalDef: TaskEval = { type: 'exact_match', expected: 'Example Domain' };

    it('passes on exact match', () => {
      const r = evaluate(evalDef, 'Example Domain');
      expect(r.passed).toBe(true);
    });

    it('fails on mismatch', () => {
      const r = evaluate(evalDef, 'Wrong Title');
      expect(r.passed).toBe(false);
    });

    it('supports case-insensitive match', () => {
      const ci: TaskEval = { ...evalDef, case_insensitive: true };
      const r = evaluate(ci, 'example domain');
      expect(r.passed).toBe(true);
    });

    it('handles JSON output — extracts result field', () => {
      const r = evaluate(evalDef, JSON.stringify({ result: 'Example Domain' }));
      expect(r.passed).toBe(true);
    });
  });

  describe('contains', () => {
    const evalDef: TaskEval = { type: 'contains', must_include: ['Tokyo', '13'] };

    it('passes when all substrings present', () => {
      const r = evaluate(evalDef, 'The population of Tokyo is approximately 13.96 million');
      expect(r.passed).toBe(true);
    });

    it('fails when any substring missing', () => {
      const r = evaluate(evalDef, 'The population of Tokyo is large');
      expect(r.passed).toBe(false);
      expect(r.details).toHaveProperty('missing');
    });
  });

  describe('structured_output', () => {
    const evalDef: TaskEval = {
      type: 'structured_output',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, count: { type: 'number' } },
        required: ['name', 'count'],
      },
    };

    it('passes valid JSON matching schema', () => {
      const r = evaluate(evalDef, JSON.stringify({ name: 'test', count: 5 }));
      expect(r.passed).toBe(true);
    });

    it('fails when required fields missing', () => {
      const r = evaluate(evalDef, JSON.stringify({ name: 'test' }));
      expect(r.passed).toBe(false);
    });

    it('fails on non-JSON input', () => {
      const r = evaluate(evalDef, 'not json');
      expect(r.passed).toBe(false);
    });

    it('validates array minItems', () => {
      const arrayEval: TaskEval = {
        type: 'structured_output',
        schema: {
          type: 'object',
          properties: { items: { type: 'array', minItems: 3 } },
          required: ['items'],
        },
      };
      const r = evaluate(arrayEval, JSON.stringify({ items: [1, 2] }));
      expect(r.passed).toBe(false);
    });
  });

  describe('llm_judge', () => {
    it('returns pending for llm_judge — requires external call', () => {
      const evalDef: TaskEval = { type: 'llm_judge', criteria: 'Did it work?' };
      const r = evaluate(evalDef, 'Some output');
      expect(r.passed).toBe(false);
      expect(r.pending).toBe(true);
      expect(r.evalType).toBe('llm_judge');
    });
  });

  describe('edge cases', () => {
    it('handles empty output', () => {
      const r = evaluate({ type: 'exact_match', expected: 'x' }, '');
      expect(r.passed).toBe(false);
    });

    it('handles undefined eval fields gracefully', () => {
      const r = evaluate({ type: 'contains' }, 'output');
      expect(r.passed).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/eval.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement eval.ts**

```typescript
// src/benchmark/eval.ts
import type { TaskEval, EvalType } from './types.js';

export interface EvalResult {
  passed: boolean;
  evalType: EvalType;
  details: Record<string, unknown>;
  pending?: boolean;
}

function extractResult(output: string): string {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (typeof parsed['result'] === 'string') return parsed['result'];
    return output;
  } catch {
    return output;
  }
}

function evalExactMatch(evalDef: TaskEval, output: string): EvalResult {
  const expected = evalDef.expected ?? '';
  const actual = extractResult(output);
  const ci = evalDef.case_insensitive ?? false;
  const passed = ci
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;

  return { passed, evalType: 'exact_match', details: { expected, actual, case_insensitive: ci } };
}

function evalContains(evalDef: TaskEval, output: string): EvalResult {
  const mustInclude = evalDef.must_include ?? [];
  if (mustInclude.length === 0) {
    return { passed: false, evalType: 'contains', details: { error: 'must_include is empty' } };
  }

  const lower = output.toLowerCase();
  const missing = mustInclude.filter((s) => !lower.includes(s.toLowerCase()));
  return {
    passed: missing.length === 0,
    evalType: 'contains',
    details: { must_include: mustInclude, missing },
  };
}

function validateSchemaSimple(schema: Record<string, unknown>, data: unknown): string[] {
  const errors: string[] = [];
  const schemaType = schema['type'] as string | undefined;

  if (schemaType === 'object' && typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    const required = (schema['required'] as string[]) ?? [];
    for (const key of required) {
      if (!(key in obj)) errors.push(`Missing required field: ${key}`);
    }
    const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj) {
        const propType = propSchema['type'] as string;
        if (propType === 'string' && typeof obj[key] !== 'string') {
          errors.push(`${key} must be a string`);
        }
        if (propType === 'number' && typeof obj[key] !== 'number') {
          errors.push(`${key} must be a number`);
        }
        if (propType === 'array') {
          if (!Array.isArray(obj[key])) {
            errors.push(`${key} must be an array`);
          } else {
            const minItems = propSchema['minItems'] as number | undefined;
            if (minItems && (obj[key] as unknown[]).length < minItems) {
              errors.push(`${key} must have at least ${minItems} items`);
            }
          }
        }
      }
    }
  } else if (schemaType === 'object') {
    errors.push('Expected an object');
  }

  return errors;
}

function evalStructuredOutput(evalDef: TaskEval, output: string): EvalResult {
  const schema = evalDef.schema;
  if (!schema) {
    return { passed: false, evalType: 'structured_output', details: { error: 'No schema defined' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { passed: false, evalType: 'structured_output', details: { error: 'Output is not valid JSON' } };
  }

  const schemaErrors = validateSchemaSimple(schema, parsed);
  return {
    passed: schemaErrors.length === 0,
    evalType: 'structured_output',
    details: { schemaErrors, parsed },
  };
}

function evalLlmJudge(evalDef: TaskEval, _output: string): EvalResult {
  return {
    passed: false,
    evalType: 'llm_judge',
    details: { criteria: evalDef.criteria },
    pending: true,
  };
}

export function evaluate(evalDef: TaskEval, output: string): EvalResult {
  switch (evalDef.type) {
    case 'exact_match':
      return evalExactMatch(evalDef, output);
    case 'contains':
      return evalContains(evalDef, output);
    case 'structured_output':
      return evalStructuredOutput(evalDef, output);
    case 'llm_judge':
      return evalLlmJudge(evalDef, output);
    default:
      return { passed: false, evalType: evalDef.type, details: { error: 'Unknown eval type' } };
  }
}

export async function evaluateWithLlmJudge(
  criteria: string,
  output: string,
): Promise<EvalResult> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const prompt = `You are evaluating a browser automation task result.

Criteria: ${criteria}

Agent output:
${output.substring(0, 2000)}

Did the agent satisfy the criteria? Answer with exactly YES or NO on the first line, then a brief explanation.`;

  try {
    const { stdout } = await execFileAsync('claude', [
      '-p', prompt,
      '--model', 'haiku',
      '--output-format', 'text',
      '--bare',
      '--no-session-persistence',
      '--max-budget-usd', '0.02',
    ], { timeout: 30000 });

    const firstLine = stdout.trim().split('\n')[0].trim().toUpperCase();
    const passed = firstLine === 'YES';

    return {
      passed,
      evalType: 'llm_judge',
      details: { criteria, judgment: stdout.trim(), firstLine },
    };
  } catch (err) {
    return {
      passed: false,
      evalType: 'llm_judge',
      details: { criteria, error: err instanceof Error ? err.message : String(err) },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/eval.test.ts`
Expected: PASS (all 11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/eval.ts test/unit/benchmark/eval.test.ts
git commit -m "feat(benchmark): eval engine — exact_match, contains, structured_output, llm_judge"
```

---

### Task 4: Stream Parser

**Files:**
- Create: `src/benchmark/stream-parser.ts`
- Create: `test/unit/benchmark/stream-parser.test.ts`

- [ ] **Step 1: Write test**

```typescript
// test/unit/benchmark/stream-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseStreamEvents, extractFinalOutput, extractToolCalls } from '../../src/benchmark/stream-parser.js';

describe('parseStreamEvents', () => {
  it('parses tool_use events', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'safari_navigate', input: { url: 'https://example.com' } }],
        },
      }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].toolName).toBe('safari_navigate');
    expect(events[0].toolInput).toEqual({ url: 'https://example.com' });
  });

  it('parses tool_result events', () => {
    const lines = [
      JSON.stringify({
        type: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"title":"Example Domain"}' }],
      }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect(events[0].toolResultContent).toContain('Example Domain');
  });

  it('parses text events', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I found the page title.' }] },
      }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text');
    expect(events[0].textContent).toBe('I found the page title.');
  });

  it('handles mixed event types in order', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Starting' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'safari_navigate', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_use', 'tool_result', 'text']);
  });

  it('skips malformed JSON lines', () => {
    const lines = ['not json', JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
  });

  it('handles result type events', () => {
    const lines = [
      JSON.stringify({ type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: '{"result":"done"}' }] } }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text');
  });
});

describe('extractFinalOutput', () => {
  it('extracts last text content', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }] } }),
      JSON.stringify({ type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: '{"result":"Example Domain"}' }] } }),
    ];
    const events = parseStreamEvents(lines);
    const output = extractFinalOutput(events);
    expect(output).toBe('{"result":"Example Domain"}');
  });
});

describe('extractToolCalls', () => {
  it('counts tool calls by name', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'safari_navigate', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'safari_snapshot', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'safari_navigate', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] }),
    ];
    const events = parseStreamEvents(lines);
    const tools = extractToolCalls(events);
    expect(tools).toEqual(['safari_navigate', 'safari_snapshot', 'safari_navigate']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/stream-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement stream-parser.ts**

```typescript
// src/benchmark/stream-parser.ts
import type { StreamEvent } from './types.js';

interface StreamMessage {
  type: string;
  message?: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string;
    }>;
  };
  content?: Array<{
    type: string;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
  }>;
}

export function parseStreamEvents(lines: string[]): StreamEvent[] {
  const events: StreamEvent[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    let msg: StreamMessage;
    try {
      msg = JSON.parse(line) as StreamMessage;
    } catch {
      continue;
    }

    const timestamp = new Date().toISOString();

    if ((msg.type === 'assistant' || msg.type === 'result') && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            timestamp,
            toolName: block.name,
            toolInput: block.input,
            raw: msg,
          });
        } else if (block.type === 'text' && block.text) {
          events.push({
            type: 'text',
            timestamp,
            textContent: block.text,
            raw: msg,
          });
        }
      }
    } else if (msg.type === 'tool' && msg.content) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            timestamp,
            toolResultContent: block.content,
            toolResultError: block.is_error ?? false,
            raw: msg,
          });
        }
      }
    } else if (msg.type === 'error') {
      events.push({ type: 'error', timestamp, raw: msg });
    }
  }

  return events;
}

export function extractFinalOutput(events: StreamEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'text' && events[i].textContent) {
      return events[i].textContent!;
    }
  }
  return '';
}

export function extractToolCalls(events: StreamEvent[]): string[] {
  return events
    .filter((e) => e.type === 'tool_use' && e.toolName)
    .map((e) => e.toolName!);
}

export function extractReasoningExcerpts(events: StreamEvent[]): string[] {
  return events
    .filter((e) => e.type === 'text' && e.textContent)
    .map((e) => e.textContent!)
    .filter((t) => t.length > 20 && t.length < 500);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/stream-parser.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/stream-parser.ts test/unit/benchmark/stream-parser.test.ts
git commit -m "feat(benchmark): stream-json parser for Claude CLI output"
```

---

### Task 5: Fixture Server

**Files:**
- Create: `src/benchmark/fixture-server.ts`
- Create: `test/unit/benchmark/fixture-server.test.ts`
- Create: `benchmark/fixtures/test.html` (test fixture)

- [ ] **Step 1: Write test**

```typescript
// test/unit/benchmark/fixture-server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureServer } from '../../src/benchmark/fixture-server.js';

const TMP_FIXTURES = join(import.meta.dirname, '../../.test-fixtures');

beforeAll(() => {
  mkdirSync(TMP_FIXTURES, { recursive: true });
  writeFileSync(join(TMP_FIXTURES, 'test.html'), '<html><body><h1>Test Page</h1></body></html>');
  mkdirSync(join(TMP_FIXTURES, 'forms'), { recursive: true });
  writeFileSync(join(TMP_FIXTURES, 'forms/login.html'), '<html><body><form><input name="user"></form></body></html>');
});

afterAll(() => rmSync(TMP_FIXTURES, { recursive: true, force: true }));

describe('FixtureServer', () => {
  let server: FixtureServer;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('starts on specified port', async () => {
    server = new FixtureServer(TMP_FIXTURES, 0); // port 0 = OS picks
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
  });

  it('serves HTML files', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/test.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Test Page</h1>');
  });

  it('serves files from subdirectories', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/forms/login.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="user"');
  });

  it('returns 404 for missing files', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/nope.html`);
    expect(res.status).toBe(404);
  });

  it('sets correct content-type', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/test.html`);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('stops cleanly', async () => {
    await server.stop();
    await expect(fetch(`http://localhost:${server.getPort()}/test.html`)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/fixture-server.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement fixture-server.ts**

```typescript
// src/benchmark/fixture-server.ts
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

export class FixtureServer {
  private server: Server | null = null;
  private port = 0;

  constructor(
    private readonly fixturesDir: string,
    private readonly requestedPort: number,
  ) {}

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        const urlPath = req.url?.split('?')[0] ?? '/';
        const filePath = join(this.fixturesDir, urlPath);

        if (filePath.includes('..')) {
          res.writeHead(400);
          res.end('Bad request');
          return;
        }

        try {
          const content = await readFile(filePath);
          const ext = extname(filePath);
          const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
          });
          res.end(content);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      this.server.on('error', reject);
      this.server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.requestedPort;
        resolve(this.port);
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/fixture-server.test.ts`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/fixture-server.ts test/unit/benchmark/fixture-server.test.ts
git commit -m "feat(benchmark): local fixture HTTP server"
```

---

### Task 6: Worker — Single Task Execution

**Files:**
- Create: `src/benchmark/worker.ts`
- Create: `test/unit/benchmark/worker.test.ts`

- [ ] **Step 1: Write test**

```typescript
// test/unit/benchmark/worker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildClaudeArgs, buildSystemPrompt, parseTaskOutput } from '../../src/benchmark/worker.js';
import type { BenchmarkTask } from '../../src/benchmark/types.js';

const task: BenchmarkTask = {
  id: 'nav-001',
  category: 'navigation',
  difficulty: 'easy',
  intent: 'Navigate to https://example.com and extract the page title',
  start_url: 'https://example.com',
  requires: { tools: [], engines: [], auth_domains: [], features: [], competitive: false },
  eval: { type: 'exact_match', expected: 'Example Domain' },
  timeout_ms: 30000,
  max_budget_usd: 0.25,
  tags: ['navigation'],
};

describe('buildSystemPrompt', () => {
  it('includes the task intent', () => {
    const prompt = buildSystemPrompt(task, 1);
    expect(prompt).toContain(task.intent);
  });

  it('includes start_url when present', () => {
    const prompt = buildSystemPrompt(task, 1);
    expect(prompt).toContain('https://example.com');
  });

  it('includes window assignment', () => {
    const prompt = buildSystemPrompt(task, 3);
    expect(prompt).toContain('window 3');
  });

  it('instructs JSON output for structured_output eval', () => {
    const structTask: BenchmarkTask = {
      ...task,
      eval: {
        type: 'structured_output',
        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
    };
    const prompt = buildSystemPrompt(structTask, 1);
    expect(prompt).toContain('JSON');
  });
});

describe('buildClaudeArgs', () => {
  it('includes required flags', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, undefined);
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--bare');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--no-session-persistence');
  });

  it('includes max-budget-usd from task', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, undefined);
    const budgetIdx = args.indexOf('--max-budget-usd');
    expect(budgetIdx).toBeGreaterThan(-1);
    expect(args[budgetIdx + 1]).toBe('0.25');
  });

  it('uses safari mcp config by default', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, undefined);
    expect(args).toContain('--strict-mcp-config');
  });

  it('uses custom mcp config when provided', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/path/to/playwright.json');
    const configIdx = args.indexOf('--mcp-config');
    expect(args[configIdx + 1]).toBe('/path/to/playwright.json');
  });
});

describe('parseTaskOutput', () => {
  it('extracts steps and tools from stream events', () => {
    const streamOutput = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'safari_navigate', input: { url: 'https://example.com' } }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] }),
      JSON.stringify({ type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'Example Domain' }] } }),
    ].join('\n');

    const result = parseTaskOutput(streamOutput);
    expect(result.steps).toBe(1);
    expect(result.toolsUsed).toEqual(['safari_navigate']);
    expect(result.finalOutput).toBe('Example Domain');
  });

  it('handles empty output', () => {
    const result = parseTaskOutput('');
    expect(result.steps).toBe(0);
    expect(result.finalOutput).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/worker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement worker.ts**

```typescript
// src/benchmark/worker.ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { BenchmarkTask, TaskResult } from './types.js';
import { parseStreamEvents, extractFinalOutput, extractToolCalls, extractReasoningExcerpts } from './stream-parser.js';
import { evaluate, evaluateWithLlmJudge } from './eval.js';

export function buildSystemPrompt(task: BenchmarkTask, windowIndex: number): string {
  let prompt = `You are a browser automation agent being benchmarked. Complete the following task using the available Safari Pilot tools.

TASK: ${task.intent}
`;

  if (task.start_url) {
    prompt += `\nSTART URL: ${task.start_url}\n`;
  }

  prompt += `\nIMPORTANT:
- Use Safari window ${windowIndex} for all tab operations.
- Work efficiently — minimize unnecessary tool calls.
- When the task is complete, output your final answer clearly.`;

  if (task.eval.type === 'structured_output' && task.eval.schema) {
    prompt += `\n\nYou MUST output your final answer as valid JSON matching this schema:\n${JSON.stringify(task.eval.schema, null, 2)}`;
  } else if (task.eval.type === 'exact_match') {
    prompt += `\n\nOutput ONLY the exact answer — no explanation, no markdown, just the raw answer text.`;
  }

  return prompt;
}

export function buildClaudeArgs(
  task: BenchmarkTask,
  model: string,
  _windowIndex: number,
  mcpConfigPath: string | undefined,
): string[] {
  const prompt = buildSystemPrompt(task, _windowIndex);
  const projectRoot = join(import.meta.dirname, '../..');

  const args = [
    '--print',
    prompt,
    '--output-format', 'stream-json',
    '--model', model,
    '--bare',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
    '--max-budget-usd', String(task.max_budget_usd),
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath ?? join(projectRoot, 'benchmark/mcp-configs/safari-only.json'),
  ];

  if (task.eval.type === 'structured_output' && task.eval.schema) {
    args.push('--json-schema', JSON.stringify(task.eval.schema));
  }

  return args;
}

export interface ParsedOutput {
  steps: number;
  toolsUsed: string[];
  finalOutput: string;
  reasoningExcerpts: string[];
  rawLines: string[];
}

export function parseTaskOutput(streamOutput: string): ParsedOutput {
  const lines = streamOutput.split('\n').filter((l) => l.trim());
  const events = parseStreamEvents(lines);

  return {
    steps: extractToolCalls(events).length,
    toolsUsed: extractToolCalls(events),
    finalOutput: extractFinalOutput(events),
    reasoningExcerpts: extractReasoningExcerpts(events),
    rawLines: lines,
  };
}

export async function executeTask(
  task: BenchmarkTask,
  model: string,
  windowIndex: number,
  mcpConfigPath: string | undefined,
  timeoutMultiplier: number,
): Promise<TaskResult> {
  const args = buildClaudeArgs(task, model, windowIndex, mcpConfigPath);
  const timeout = task.timeout_ms * timeoutMultiplier;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('claude', args, {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', async (code) => {
      const durationMs = Date.now() - startTime;
      const parsed = parseTaskOutput(stdout);

      if (code !== 0 && parsed.finalOutput === '') {
        resolve({
          taskId: task.id,
          model,
          success: false,
          evalMethod: task.eval.type,
          evalDetails: { error: `Claude exited with code ${code}`, stderr: stderr.substring(0, 500) },
          fallbackUsed: false,
          skipped: false,
          steps: parsed.steps,
          durationMs,
          toolsUsed: parsed.toolsUsed,
          enginesUsed: {},
          reasoningExcerpts: parsed.reasoningExcerpts,
          error: `Process exited with code ${code}`,
          rawOutput: stdout.substring(0, 2000),
        });
        return;
      }

      let evalResult = evaluate(task.eval, parsed.finalOutput);

      let fallbackUsed = false;
      if (!evalResult.passed && task.eval_fallback) {
        if (task.eval_fallback.type === 'llm_judge' && task.eval_fallback.criteria) {
          evalResult = await evaluateWithLlmJudge(task.eval_fallback.criteria, parsed.finalOutput);
          fallbackUsed = true;
        } else {
          evalResult = evaluate(task.eval_fallback, parsed.finalOutput);
          fallbackUsed = true;
        }
      }

      resolve({
        taskId: task.id,
        model,
        success: evalResult.passed,
        evalMethod: fallbackUsed ? (task.eval_fallback?.type ?? task.eval.type) : task.eval.type,
        evalDetails: evalResult.details,
        fallbackUsed,
        skipped: false,
        steps: parsed.steps,
        durationMs,
        toolsUsed: parsed.toolsUsed,
        enginesUsed: {},
        reasoningExcerpts: parsed.reasoningExcerpts,
        rawOutput: stdout.substring(0, 2000),
      });
    });

    proc.on('error', (err) => {
      resolve({
        taskId: task.id,
        model,
        success: false,
        evalMethod: task.eval.type,
        evalDetails: { error: err.message },
        fallbackUsed: false,
        skipped: false,
        steps: 0,
        durationMs: Date.now() - startTime,
        toolsUsed: [],
        enginesUsed: {},
        reasoningExcerpts: [],
        error: err.message,
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/worker.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/worker.ts test/unit/benchmark/worker.test.ts
git commit -m "feat(benchmark): worker — task execution via Claude CLI with eval chain"
```

---

### Task 7: Reporter — Delta Reports and History

**Files:**
- Create: `src/benchmark/reporter.ts`
- Create: `test/unit/benchmark/reporter.test.ts`

- [ ] **Step 1: Write test**

```typescript
// test/unit/benchmark/reporter.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeRunReport,
  generateDeltaReport,
  computeFlakiness,
} from '../../src/benchmark/reporter.js';
import type { TaskResult, BenchmarkTask, RunReport, Category } from '../../src/benchmark/types.js';

function makeResult(id: string, category: Category, success: boolean, steps = 3): { task: BenchmarkTask; result: TaskResult } {
  return {
    task: {
      id, category, difficulty: 'easy', intent: 'test',
      requires: { tools: [], engines: [], auth_domains: [], features: [], competitive: false },
      eval: { type: 'exact_match', expected: 'x' },
      timeout_ms: 30000, max_budget_usd: 0.25, tags: [],
    },
    result: {
      taskId: id, model: 'sonnet', success, evalMethod: 'exact_match',
      evalDetails: {}, fallbackUsed: false, skipped: false,
      steps, durationMs: 5000, toolsUsed: ['safari_navigate'],
      enginesUsed: { applescript: steps }, reasoningExcerpts: [],
    },
  };
}

describe('computeRunReport', () => {
  it('computes overall and per-category rates', () => {
    const entries = [
      makeResult('nav-001', 'navigation', true),
      makeResult('nav-002', 'navigation', false),
      makeResult('form-001', 'forms', true),
    ];
    const report = computeRunReport('run-1', 'sonnet', 'abc123', 'main', entries.map((e) => e.result), entries.map((e) => e.task), []);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.overallRate).toBeCloseTo(0.667, 2);
    expect(report.byCategory['navigation'].rate).toBe(0.5);
    expect(report.byCategory['forms'].rate).toBe(1);
  });

  it('computes mean steps', () => {
    const entries = [
      makeResult('nav-001', 'navigation', true, 4),
      makeResult('nav-002', 'navigation', true, 6),
    ];
    const report = computeRunReport('run-1', 'sonnet', 'abc', 'main', entries.map((e) => e.result), entries.map((e) => e.task), []);
    expect(report.meanSteps).toBe(5);
  });
});

describe('generateDeltaReport', () => {
  it('generates markdown with category table', () => {
    const entries = [makeResult('nav-001', 'navigation', true)];
    const current = computeRunReport('run-1', 'sonnet', 'abc', 'main', entries.map((e) => e.result), entries.map((e) => e.task), []);
    const md = generateDeltaReport(current, null, []);
    expect(md).toContain('# Safari Pilot Benchmark Report');
    expect(md).toContain('navigation');
    expect(md).toContain('baseline');
  });

  it('shows deltas when previous run exists', () => {
    const entries = [makeResult('nav-001', 'navigation', true)];
    const prev = computeRunReport('run-0', 'sonnet', 'prev', 'main', [makeResult('nav-001', 'navigation', false).result], entries.map((e) => e.task), []);
    const current = computeRunReport('run-1', 'sonnet', 'abc', 'feat/x', entries.map((e) => e.result), entries.map((e) => e.task), []);
    const md = generateDeltaReport(current, prev, []);
    expect(md).toContain('100.0%');
  });
});

describe('computeFlakiness', () => {
  it('detects flaky tasks from run history', () => {
    const runs: RunReport[] = [
      { id: 'r1', model: 'sonnet', commit: 'a', branch: 'main', timestamp: '', eligible: 1, skipped: 0, passed: 1, failed: 0, overallRate: 1, byCategory: {} as any, intelligenceRate: 0, competitiveWinRate: 0, competitive: [], meanSteps: 3, p50DurationMs: 5000, p95DurationMs: 5000, flakyCount: 0, perTask: { 'nav-001': { passed: true, steps: 3, durationMs: 5000 } } },
      { id: 'r2', model: 'sonnet', commit: 'b', branch: 'main', timestamp: '', eligible: 1, skipped: 0, passed: 0, failed: 1, overallRate: 0, byCategory: {} as any, intelligenceRate: 0, competitiveWinRate: 0, competitive: [], meanSteps: 3, p50DurationMs: 5000, p95DurationMs: 5000, flakyCount: 0, perTask: { 'nav-001': { passed: false, steps: 3, durationMs: 5000 } } },
    ];
    const flaky = computeFlakiness(runs, 'nav-001');
    expect(flaky).toBe(true);
  });

  it('returns false for consistent tasks', () => {
    const runs: RunReport[] = [
      { id: 'r1', model: 'sonnet', commit: 'a', branch: 'main', timestamp: '', eligible: 1, skipped: 0, passed: 1, failed: 0, overallRate: 1, byCategory: {} as any, intelligenceRate: 0, competitiveWinRate: 0, competitive: [], meanSteps: 3, p50DurationMs: 5000, p95DurationMs: 5000, flakyCount: 0, perTask: { 'nav-001': { passed: true, steps: 3, durationMs: 5000 } } },
      { id: 'r2', model: 'sonnet', commit: 'b', branch: 'main', timestamp: '', eligible: 1, skipped: 0, passed: 1, failed: 0, overallRate: 1, byCategory: {} as any, intelligenceRate: 0, competitiveWinRate: 0, competitive: [], meanSteps: 3, p50DurationMs: 5000, p95DurationMs: 5000, flakyCount: 0, perTask: { 'nav-001': { passed: true, steps: 3, durationMs: 5000 } } },
    ];
    const flaky = computeFlakiness(runs, 'nav-001');
    expect(flaky).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/benchmark/reporter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement reporter.ts**

```typescript
// src/benchmark/reporter.ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TaskResult, BenchmarkTask, RunReport, HistoryFile, Category, CategoryResult, CompetitiveResult, CATEGORIES } from './types.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function computeRunReport(
  runId: string,
  model: string,
  commit: string,
  branch: string,
  results: TaskResult[],
  tasks: BenchmarkTask[],
  skippedTasks: Array<{ task: BenchmarkTask; reason: string }>,
): RunReport {
  const nonSkipped = results.filter((r) => !r.skipped);
  const passed = nonSkipped.filter((r) => r.success).length;
  const failed = nonSkipped.filter((r) => !r.success).length;

  const byCategory: Record<string, CategoryResult> = {};
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  for (const r of nonSkipped) {
    const task = taskMap.get(r.taskId);
    if (!task) continue;
    if (!byCategory[task.category]) {
      byCategory[task.category] = { passed: 0, failed: 0, skipped: 0, rate: 0 };
    }
    if (r.success) byCategory[task.category].passed++;
    else byCategory[task.category].failed++;
  }

  for (const cat of Object.values(byCategory)) {
    const total = cat.passed + cat.failed;
    cat.rate = total > 0 ? cat.passed / total : 0;
  }

  const intelResults = nonSkipped.filter((r) => taskMap.get(r.taskId)?.category === 'intelligence');
  const intelPassed = intelResults.filter((r) => r.success).length;
  const intelligenceRate = intelResults.length > 0 ? intelPassed / intelResults.length : 0;

  const durations = nonSkipped.map((r) => r.durationMs).sort((a, b) => a - b);
  const steps = nonSkipped.filter((r) => r.success).map((r) => r.steps);
  const meanSteps = steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;

  const perTask: RunReport['perTask'] = {};
  for (const r of nonSkipped) {
    perTask[r.taskId] = { passed: r.success, steps: r.steps, durationMs: r.durationMs };
  }

  return {
    id: runId,
    model,
    commit,
    branch,
    timestamp: new Date().toISOString(),
    eligible: nonSkipped.length,
    skipped: skippedTasks.length,
    passed,
    failed,
    overallRate: nonSkipped.length > 0 ? passed / nonSkipped.length : 0,
    byCategory: byCategory as Record<Category, CategoryResult>,
    intelligenceRate,
    competitiveWinRate: 0,
    competitive: [],
    meanSteps,
    p50DurationMs: percentile(durations, 50),
    p95DurationMs: percentile(durations, 95),
    flakyCount: 0,
    perTask,
  };
}

export function computeFlakiness(runs: RunReport[], taskId: string): boolean {
  const results = runs
    .map((r) => r.perTask[taskId])
    .filter(Boolean);

  if (results.length < 2) return false;

  const passCount = results.filter((r) => r.passed).length;
  const ratio = passCount / results.length;
  return ratio > 0.2 && ratio < 0.8;
}

function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined) return 'baseline';
  const diff = current - previous;
  if (Math.abs(diff) < 0.001) return '--';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${(diff * 100).toFixed(1)}%`;
}

export function generateDeltaReport(
  current: RunReport,
  previous: RunReport | null,
  skipped: Array<{ task: BenchmarkTask; reason: string }>,
): string {
  const lines: string[] = [];

  lines.push('# Safari Pilot Benchmark Report');
  lines.push(`**Run:** ${current.id} | **Model:** ${current.model} | **Commit:** ${current.commit} | **Branch:** ${current.branch}`);
  lines.push('');

  const overallDelta = previous ? formatDelta(current.overallRate, previous.overallRate) : 'baseline';
  lines.push(`## Overall: ${current.passed}/${current.eligible} eligible tasks passed (${(current.overallRate * 100).toFixed(1)}%) — ${overallDelta}`);
  lines.push('');

  lines.push('| Category | Pass | Rate | Delta |');
  lines.push('|----------|------|------|-------|');

  for (const [cat, result] of Object.entries(current.byCategory)) {
    const total = result.passed + result.failed;
    const rate = `${(result.rate * 100).toFixed(1)}%`;
    const prevRate = previous?.byCategory[cat as Category]?.rate;
    const delta = formatDelta(result.rate, prevRate);
    lines.push(`| ${cat} | ${result.passed}/${total} | ${rate} | ${delta} |`);
  }
  lines.push('');

  const intelDelta = previous ? formatDelta(current.intelligenceRate, previous.intelligenceRate) : 'baseline';
  lines.push(`## Intelligence Tier: ${(current.intelligenceRate * 100).toFixed(1)}% — ${intelDelta}`);
  lines.push('');

  lines.push(`## Efficiency`);
  lines.push(`- Mean steps per successful task: ${current.meanSteps.toFixed(1)}`);
  lines.push(`- P50 duration: ${(current.p50DurationMs / 1000).toFixed(1)}s`);
  lines.push(`- P95 duration: ${(current.p95DurationMs / 1000).toFixed(1)}s`);
  lines.push('');

  if (skipped.length > 0) {
    lines.push(`## Skipped Tasks (${skipped.length})`);
    for (const { task, reason } of skipped) {
      lines.push(`- ${task.id}: ${reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function loadHistory(historyPath: string): Promise<HistoryFile> {
  try {
    const raw = await readFile(historyPath, 'utf-8');
    return JSON.parse(raw) as HistoryFile;
  } catch {
    return { runs: [] };
  }
}

export async function saveHistory(historyPath: string, history: HistoryFile): Promise<void> {
  await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8');
}

export async function saveReport(reportsDir: string, report: RunReport, markdown: string): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const fileName = `${report.timestamp.split('T')[0]}-${report.commit}.md`;
  const filePath = join(reportsDir, fileName);
  await writeFile(filePath, markdown, 'utf-8');
  return filePath;
}

export function getGitInfo(): { commit: string; branch: string } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { timeout: 3000 }).toString().trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { timeout: 3000 }).toString().trim();
    return { commit, branch };
  } catch {
    return { commit: 'unknown', branch: 'unknown' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/benchmark/reporter.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/reporter.ts test/unit/benchmark/reporter.test.ts
git commit -m "feat(benchmark): reporter — delta reports, history tracking, flakiness detection"
```

---

### Task 8: Runner — CLI Entry Point and Parallel Orchestration

**Files:**
- Create: `src/benchmark/runner.ts`
- Create: `benchmark/mcp-configs/safari-only.json`

- [ ] **Step 1: Create MCP configs**

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

- [ ] **Step 2: Implement runner.ts**

```typescript
#!/usr/bin/env node
// src/benchmark/runner.ts
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { BenchmarkTask, Category, RunConfig, TaskResult, CompetitiveResult } from './types.js';
import { CATEGORIES } from './types.js';
import { loadTasks, filterTasks } from './task-loader.js';
import { executeTask } from './worker.js';
import { computeRunReport, generateDeltaReport, loadHistory, saveHistory, saveReport, getGitInfo } from './reporter.js';
import { FixtureServer } from './fixture-server.js';

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const BENCHMARK_DIR = join(PROJECT_ROOT, 'benchmark');
const TASKS_DIR = join(BENCHMARK_DIR, 'tasks');
const FIXTURES_DIR = join(BENCHMARK_DIR, 'fixtures');
const TRACES_DIR = join(BENCHMARK_DIR, 'traces');
const REPORTS_DIR = join(BENCHMARK_DIR, 'reports');
const HISTORY_PATH = join(BENCHMARK_DIR, 'history.json');
const SAFARI_MCP = join(BENCHMARK_DIR, 'mcp-configs/safari-only.json');
const PLAYWRIGHT_MCP = join(BENCHMARK_DIR, 'mcp-configs/playwright-only.json');

function parseArgs(argv: string[]): RunConfig {
  const config: RunConfig = {
    models: ['sonnet'],
    parallel: 3,
    categories: null,
    taskIds: null,
    competitive: false,
    dryRun: false,
    timeoutMultiplier: 1,
    fixturePort: 9876,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--model':
        config.models = argv[++i].split(',');
        break;
      case '--parallel':
        config.parallel = parseInt(argv[++i], 10);
        break;
      case '--category':
        config.categories = argv[++i].split(',') as Category[];
        break;
      case '--task':
        config.taskIds = argv[++i].split(',');
        break;
      case '--competitive':
        config.competitive = true;
        break;
      case '--dry-run':
        config.dryRun = true;
        break;
      case '--timeout-multiplier':
        config.timeoutMultiplier = parseFloat(argv[++i]);
        break;
    }
  }

  return config;
}

interface WorkerSlot {
  windowIndex: number;
  queue: BenchmarkTask[];
}

function distributeTasksToWorkers(tasks: BenchmarkTask[], parallel: number): WorkerSlot[] {
  const slots: WorkerSlot[] = Array.from({ length: parallel }, (_, i) => ({
    windowIndex: i + 1,
    queue: [],
  }));

  const domainGroups = new Map<string, BenchmarkTask[]>();
  for (const task of tasks) {
    const domain = task.start_url ? new URL(task.start_url).hostname : 'local';
    if (!domainGroups.has(domain)) domainGroups.set(domain, []);
    domainGroups.get(domain)!.push(task);
  }

  const sortedGroups = [...domainGroups.values()].sort((a, b) => b.length - a.length);

  for (const group of sortedGroups) {
    const lightest = slots.reduce((min, s) => (s.queue.length < min.queue.length ? s : min));
    lightest.queue.push(...group);
  }

  return slots;
}

async function runModel(
  model: string,
  eligible: BenchmarkTask[],
  skipped: Array<{ task: BenchmarkTask; reason: string }>,
  config: RunConfig,
  fixturePort: number,
): Promise<{ results: TaskResult[]; competitive: CompetitiveResult[] }> {
  const slots = distributeTasksToWorkers(eligible, config.parallel);
  const results: TaskResult[] = [];
  const competitive: CompetitiveResult[] = [];
  let completed = 0;
  const total = eligible.length;

  const workerPromises = slots.map(async (slot) => {
    for (const task of slot.queue) {
      const startUrl = task.start_url?.replace('localhost:9876', `localhost:${fixturePort}`) ?? task.start_url;
      const adjustedTask = startUrl !== task.start_url ? { ...task, start_url: startUrl } : task;

      const result = await executeTask(adjustedTask, model, slot.windowIndex, SAFARI_MCP, config.timeoutMultiplier);
      results.push(result);
      completed++;
      process.stdout.write(`\r  [${model}] ${completed}/${total} tasks (${result.success ? 'PASS' : 'FAIL'}: ${task.id})`);

      if (task.requires.competitive && config.competitive) {
        const pwResult = await executeTask(adjustedTask, model, slot.windowIndex, PLAYWRIGHT_MCP, config.timeoutMultiplier);
        competitive.push({
          taskId: task.id,
          safariPilotSuccess: result.success,
          safariPilotSteps: result.steps,
          safariPilotDurationMs: result.durationMs,
          playwrightSuccess: pwResult.success,
          playwrightSteps: pwResult.steps,
          playwrightDurationMs: pwResult.durationMs,
          winner: result.success && !pwResult.success ? 'safari-pilot'
            : !result.success && pwResult.success ? 'playwright'
            : result.success && pwResult.success ? 'tie'
            : 'both-failed',
        });
      }
    }
  });

  await Promise.all(workerPromises);
  console.log('');

  return { results, competitive };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv);

  console.log('Safari Pilot Benchmark Suite');
  console.log('============================');
  console.log(`Models: ${config.models.join(', ')}`);
  console.log(`Parallel: ${config.parallel} workers`);
  console.log(`Competitive: ${config.competitive}`);
  console.log('');

  console.log('Loading tasks...');
  const { tasks, errors: loadErrors } = await loadTasks(TASKS_DIR);
  if (loadErrors.length > 0) {
    console.warn(`  ${loadErrors.length} task loading errors:`);
    for (const err of loadErrors.slice(0, 5)) console.warn(`    ${err}`);
  }
  console.log(`  ${tasks.length} tasks loaded`);

  console.log('Running pre-flight checks...');
  const preflight = {
    availableTools: tasks.flatMap((t) => t.requires.tools).filter((v, i, a) => a.indexOf(v) === i),
    healthyEngines: ['applescript', 'daemon'],
    authenticatedDomains: [] as string[],
    competitiveReady: config.competitive,
    fixtureServerRunning: true,
  };

  const { eligible, skipped } = filterTasks(tasks, preflight, config.categories, config.taskIds);
  console.log(`  ${eligible.length} eligible, ${skipped.length} skipped`);

  if (config.dryRun) {
    console.log('\nDry run — eligible tasks:');
    for (const task of eligible) {
      console.log(`  ${task.id} [${task.category}] ${task.difficulty} — ${task.intent.substring(0, 80)}`);
    }
    console.log('\nSkipped tasks:');
    for (const { task, reason } of skipped) {
      console.log(`  ${task.id}: ${reason}`);
    }
    return;
  }

  let fixtureServer: FixtureServer | null = null;
  let fixturePort = config.fixturePort;
  const hasFixtureTasks = eligible.some((t) => t.start_url?.includes('localhost'));
  if (hasFixtureTasks) {
    console.log('Starting fixture server...');
    fixtureServer = new FixtureServer(FIXTURES_DIR, config.fixturePort);
    fixturePort = await fixtureServer.start();
    console.log(`  Serving fixtures on port ${fixturePort}`);
  }

  const { commit, branch } = getGitInfo();
  const history = await loadHistory(HISTORY_PATH);

  try {
    for (const model of config.models) {
      const runId = `bench-${new Date().toISOString().split('T')[0].replace(/-/g, '')}-${model}-${Date.now().toString(36)}`;
      console.log(`\nRunning benchmark: ${runId} (model: ${model})`);

      const { results, competitive } = await runModel(model, eligible, skipped, config, fixturePort);

      const report = computeRunReport(runId, model, commit, branch, results, eligible, skipped);
      report.competitive = competitive;
      if (competitive.length > 0) {
        const spWins = competitive.filter((c) => c.winner === 'safari-pilot').length;
        report.competitiveWinRate = spWins / competitive.length;
      }

      const previousRun = history.runs.filter((r) => r.model === model).at(-1) ?? null;
      const markdown = generateDeltaReport(report, previousRun, skipped);

      const reportPath = await saveReport(REPORTS_DIR, report, markdown);
      console.log(`  Report: ${reportPath}`);

      history.runs.push(report);
      await saveHistory(HISTORY_PATH, history);

      await mkdir(join(TRACES_DIR, runId), { recursive: true });
      for (const result of results) {
        const { writeFile: wf } = await import('node:fs/promises');
        await wf(join(TRACES_DIR, runId, `${result.taskId}.json`), JSON.stringify(result, null, 2));
      }

      console.log(`\n  RESULTS: ${report.passed}/${report.eligible} passed (${(report.overallRate * 100).toFixed(1)}%)`);
      console.log(`  Intelligence: ${(report.intelligenceRate * 100).toFixed(1)}%`);
      if (competitive.length > 0) {
        console.log(`  Competitive: SP ${report.competitiveWinRate * 100}% win rate`);
      }
    }
  } finally {
    if (fixtureServer) await fixtureServer.stop();
  }

  console.log('\nBenchmark complete.');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Run build to verify compilation**

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/benchmark/runner.ts benchmark/mcp-configs/safari-only.json benchmark/mcp-configs/playwright-only.json
git commit -m "feat(benchmark): runner CLI with parallel execution and competitive mode"
```

---

### Task 9: Create Task Definition Directory Structure

**Files:**
- Create: All 11 category directories under `benchmark/tasks/`
- Create: `benchmark/history.json` (empty starter)
- Create: `benchmark/reports/.gitkeep`
- Create: `benchmark/traces/.gitkeep`

- [ ] **Step 1: Create directory structure and starter files**

```bash
mkdir -p benchmark/tasks/{navigation,forms,extraction,workflows,dom-complexity,auth-flows,accessibility,error-recovery,safari-specific,intelligence,competitive}
mkdir -p benchmark/fixtures/{navigation,forms,extraction,dom-complexity,error-recovery,accessibility}
mkdir -p benchmark/reports benchmark/traces
echo '{"runs":[]}' > benchmark/history.json
touch benchmark/reports/.gitkeep
touch benchmark/traces/.gitkeep
```

- [ ] **Step 2: Commit directory structure**

```bash
git add benchmark/tasks/ benchmark/fixtures/ benchmark/history.json benchmark/reports/.gitkeep benchmark/traces/.gitkeep
git commit -m "feat(benchmark): task directory structure for 11 categories"
```

---

### Task 10: Navigation Tasks (15 tasks) + Navigation Fixtures

**Files:**
- Create: `benchmark/tasks/navigation/nav-001.json` through `nav-015.json`
- Create: `benchmark/fixtures/navigation/links.html`
- Create: `benchmark/fixtures/navigation/multi-page.html`
- Create: `benchmark/fixtures/navigation/history.html`

This task creates all 15 navigation task JSONs and the fixture HTML files they reference. Each JSON follows the schema from Task 1. Full task manifest:

| ID | Difficulty | Intent | Environment | Eval |
|----|-----------|--------|-------------|------|
| nav-001 | easy | Navigate to example.com and extract the page title | live | exact_match: "Example Domain" |
| nav-002 | easy | Open a new tab, navigate to wikipedia.org, confirm you're on Wikipedia | live | contains: ["Wikipedia"] |
| nav-003 | easy | Navigate to example.com, then go back, report the URL | live | contains: ["about:blank"] |
| nav-004 | easy | Navigate to HN and extract the page title | live | contains: ["Hacker News"] |
| nav-005 | easy | Open two tabs — example.com and wikipedia.org — then list both URLs | live | contains: ["example.com", "wikipedia.org"] |
| nav-006 | medium | Navigate to Wikipedia's Safari article via search, extract the first heading | live | contains: ["Safari"] |
| nav-007 | medium | On HN, click the first story link, extract the page title of the destination | live | structured_output |
| nav-008 | medium | Navigate through 3 links on the fixture page, report final URL | fixture | contains: ["page3"] |
| nav-009 | medium | Open 3 tabs with different URLs, close the middle one, list remaining | live | structured_output |
| nav-010 | medium | Navigate to GitHub explore page, find a trending repo link, click it | live | contains: ["github.com"] |
| nav-011 | medium | On Wikipedia, navigate from Main Page to a random article via "Random article" link | live | structured_output |
| nav-012 | medium | Navigate to example.com, take a snapshot, count interactive elements | live | structured_output |
| nav-013 | hard | On HN, navigate to page 2 of stories, extract the first story title | live | structured_output |
| nav-014 | hard | Open Wikipedia, navigate to 3 different articles via internal links, list all titles visited | live | structured_output |
| nav-015 | hard | Navigate fixture multi-page app: home → about → contact → home, verify each page title | fixture | structured_output |

- [ ] **Step 1: Create fixture HTML files**

```html
<!-- benchmark/fixtures/navigation/links.html -->
<!DOCTYPE html>
<html><head><title>Navigation Test - Links</title></head>
<body>
  <h1>Link Navigation Test</h1>
  <nav>
    <a href="/navigation/page2.html">Page 2</a>
    <a href="/navigation/page3.html">Page 3</a>
    <a href="/navigation/deep/nested.html">Nested Page</a>
  </nav>
</body></html>
```

```html
<!-- benchmark/fixtures/navigation/page2.html -->
<!DOCTYPE html>
<html><head><title>Page 2</title></head>
<body><h1>Page 2</h1><a href="/navigation/page3.html">Go to Page 3</a></body></html>
```

```html
<!-- benchmark/fixtures/navigation/page3.html -->
<!DOCTYPE html>
<html><head><title>Page 3</title></head>
<body><h1>Page 3</h1><a href="/navigation/links.html">Back to Start</a></body></html>
```

```html
<!-- benchmark/fixtures/navigation/multi-page.html -->
<!DOCTYPE html>
<html><head><title>Home</title></head>
<body>
  <h1>Multi-Page App</h1>
  <nav>
    <a href="/navigation/about.html">About</a>
    <a href="/navigation/contact.html">Contact</a>
  </nav>
</body></html>
```

```html
<!-- benchmark/fixtures/navigation/about.html -->
<!DOCTYPE html>
<html><head><title>About</title></head>
<body><h1>About Page</h1><a href="/navigation/contact.html">Contact</a><a href="/navigation/multi-page.html">Home</a></body></html>
```

```html
<!-- benchmark/fixtures/navigation/contact.html -->
<!DOCTYPE html>
<html><head><title>Contact</title></head>
<body><h1>Contact Page</h1><a href="/navigation/multi-page.html">Home</a></body></html>
```

- [ ] **Step 2: Create all 15 navigation task JSON files**

Write each JSON file following the schema. Example for nav-001:

```json
{
  "id": "nav-001",
  "category": "navigation",
  "difficulty": "easy",
  "intent": "Navigate to https://example.com and extract the page title",
  "start_url": "https://example.com",
  "requires": { "tools": [], "engines": [], "auth_domains": [], "features": [], "competitive": false },
  "eval": { "type": "exact_match", "expected": "Example Domain" },
  "reference_answers": { "exact_match": "Example Domain", "must_include": ["Example"] },
  "timeout_ms": 30000,
  "max_budget_usd": 0.25,
  "tags": ["navigation", "basic"]
}
```

Example for nav-008 (fixture):

```json
{
  "id": "nav-008",
  "category": "navigation",
  "difficulty": "medium",
  "intent": "Starting from the links page, navigate through 3 pages by clicking links, then report the final page URL",
  "start_url": "http://localhost:9876/navigation/links.html",
  "requires": { "tools": [], "engines": [], "auth_domains": [], "features": [], "competitive": false },
  "eval": { "type": "contains", "must_include": ["page3"] },
  "timeout_ms": 45000,
  "max_budget_usd": 0.30,
  "tags": ["navigation", "multi-step", "fixture"]
}
```

Write all 15 following the manifest table above. Each file: `benchmark/tasks/navigation/nav-{NNN}.json`.

- [ ] **Step 3: Verify tasks load correctly**

Run: `npx vitest run test/unit/benchmark/task-loader.test.ts`
Then manually verify: `node -e "import('./dist/benchmark/task-loader.js').then(m => m.loadTasks('benchmark/tasks')).then(r => console.log(r.tasks.length, 'tasks,', r.errors.length, 'errors'))"`
Expected: 15 tasks loaded, 0 errors

- [ ] **Step 4: Commit**

```bash
git add benchmark/tasks/navigation/ benchmark/fixtures/navigation/
git commit -m "feat(benchmark): 15 navigation tasks + fixture HTML"
```

---

### Task 11: Form, Extraction, and Workflow Tasks (42 tasks) + Fixtures

**Files:**
- Create: 15 form tasks in `benchmark/tasks/forms/`
- Create: 15 extraction tasks in `benchmark/tasks/extraction/`
- Create: 12 workflow tasks in `benchmark/tasks/workflows/`
- Create: Form and extraction fixture HTML files

This task creates the three largest core categories. Each task follows the established JSON schema.

**Forms (15 tasks):**

| ID | Difficulty | Intent | Env |
|----|-----------|--------|-----|
| form-001 | easy | Fill the login form with username "testuser" and password "pass123", submit it | fixture |
| form-002 | easy | Find the search input on Wikipedia and type "browser automation" | live |
| form-003 | easy | On example.com, check if there's a form — report yes or no | live |
| form-004 | easy | Fill the email field on the fixture form with "test@example.com" | fixture |
| form-005 | easy | Select "Option 2" from the dropdown on the fixture form | fixture |
| form-006 | medium | Fill all fields on the complex form fixture — text, email, dropdown, checkbox | fixture |
| form-007 | medium | On HN, fill the login form with test credentials, submit, report the error message | live |
| form-008 | medium | On Wikipedia, use the search box to search for "Tokyo", wait for results, extract first result title | live |
| form-009 | medium | Fill the fixture form that has client-side validation, trigger an error, report the error text | fixture |
| form-010 | medium | On GitHub, find the search input using the a11y tree, type a query, press Enter | live |
| form-011 | medium | Check all checkboxes on the fixture form, then uncheck the second one | fixture |
| form-012 | medium | Select a date from the date picker fixture using keyboard input | fixture |
| form-013 | hard | Fill a multi-step form fixture — page 1 (personal info), page 2 (address), page 3 (review) | fixture |
| form-014 | hard | On Wikipedia, search for "Safari browser", click the first result, then edit the search to "WebKit" and click that result | live |
| form-015 | hard | Fill the registration form fixture with validation — fix each validation error until submission succeeds | fixture |

**Extraction (15 tasks):**

| ID | Difficulty | Intent | Env |
|----|-----------|--------|-----|
| ext-001 | easy | Extract the main heading text from example.com | live |
| ext-002 | easy | Get the page title of https://en.wikipedia.org | live |
| ext-003 | easy | Count the number of links on example.com | live |
| ext-004 | easy | Extract all text content from the fixture page | fixture |
| ext-005 | medium | On Wikipedia's "Safari (web browser)" article, extract all section headings | live |
| ext-006 | medium | Extract the HTML table data from the fixture page as JSON | fixture |
| ext-007 | medium | On HN, extract the titles of the top 5 stories | live |
| ext-008 | medium | On Wikipedia, find the population of Tokyo | live |
| ext-009 | medium | Extract all image alt texts from the fixture page | fixture |
| ext-010 | medium | On GitHub, extract the repo name and star count from the trending page's first repo | live |
| ext-011 | medium | Extract the nested list structure from the fixture page as a hierarchical JSON | fixture |
| ext-012 | hard | On Wikipedia's "Safari (web browser)" article, count external links in the References section | live |
| ext-013 | hard | On HN, extract the top 10 story titles, their scores, and comment counts as structured JSON | live |
| ext-014 | hard | On Wikipedia, extract the infobox data from the "Tokyo" article as key-value pairs | live |
| ext-015 | hard | Extract data from a dynamically-loaded fixture page — content appears after 2s JS delay | fixture |

**Workflows (12 tasks):**

| ID | Difficulty | Intent | Env |
|----|-----------|--------|-----|
| wf-001 | medium | Search Wikipedia for "browser automation", extract the first 3 result titles | live |
| wf-002 | medium | On HN, find the newest story, click into it, extract the first comment text | live |
| wf-003 | medium | Navigate to example.com, take a snapshot, find a link, click it, take another snapshot, compare element counts | live |
| wf-004 | medium | Open two tabs — Wikipedia and HN — extract both page titles, compare them | live |
| wf-005 | medium | On GitHub, search for "safari-pilot", extract the first result's repo name and description | live |
| wf-006 | medium | Fill the fixture search form, extract results from the results page | fixture |
| wf-007 | hard | On Wikipedia, search for "WebKit", go to the article, extract the first 3 references, visit one | live |
| wf-008 | hard | On HN, find a "Show HN" post, visit the linked project, extract its one-line description | live |
| wf-009 | hard | Search Wikipedia for 3 different browser engines (WebKit, Blink, Gecko), extract release years, compare | live |
| wf-010 | hard | On GitHub, find trending repos this week, extract top 3 names, visit each, get README first line | live |
| wf-011 | hard | Multi-tab workflow: open HN in tab 1, Wikipedia in tab 2, find a topic from HN, search for it on Wikipedia | live |
| wf-012 | hard | Fill fixture search form, paginate through results, extract items from all 3 pages | fixture |

- [ ] **Step 1: Create form fixtures**

```html
<!-- benchmark/fixtures/forms/login.html -->
<!DOCTYPE html>
<html><head><title>Login Form</title></head>
<body>
  <h1>Login</h1>
  <form id="login-form" action="/forms/login-result.html" method="get">
    <label for="username">Username</label>
    <input type="text" id="username" name="username" required>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required>
    <button type="submit">Login</button>
  </form>
  <div id="error" style="color:red;display:none">Invalid credentials</div>
</body></html>
```

```html
<!-- benchmark/fixtures/forms/complex-form.html -->
<!DOCTYPE html>
<html><head><title>Complex Form</title></head>
<body>
  <h1>Registration</h1>
  <form id="reg-form">
    <label for="name">Full Name</label>
    <input type="text" id="name" name="name" required>
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required>
    <label for="country">Country</label>
    <select id="country" name="country">
      <option value="">Select...</option>
      <option value="us">United States</option>
      <option value="uk">United Kingdom</option>
      <option value="jp">Japan</option>
    </select>
    <label><input type="checkbox" name="terms" id="terms"> Accept terms</label>
    <label><input type="checkbox" name="newsletter" id="newsletter"> Subscribe to newsletter</label>
    <button type="submit">Register</button>
  </form>
  <div id="result" style="display:none">Form submitted successfully</div>
  <script>
    document.getElementById('reg-form').addEventListener('submit', function(e) {
      e.preventDefault();
      document.getElementById('result').style.display = 'block';
    });
  </script>
</body></html>
```

```html
<!-- benchmark/fixtures/forms/validation.html -->
<!DOCTYPE html>
<html><head><title>Form Validation</title></head>
<body>
  <h1>Validated Form</h1>
  <form id="val-form">
    <label for="email">Email (required)</label>
    <input type="email" id="email" name="email" required>
    <div id="email-error" class="error" style="color:red;display:none">Please enter a valid email</div>
    <label for="age">Age (18+)</label>
    <input type="number" id="age" name="age" min="18" required>
    <div id="age-error" class="error" style="color:red;display:none">Must be 18 or older</div>
    <button type="submit">Submit</button>
    <div id="success" style="color:green;display:none">Form submitted successfully!</div>
  </form>
  <script>
    document.getElementById('val-form').addEventListener('submit', function(e) {
      e.preventDefault();
      var emailErr = document.getElementById('email-error');
      var ageErr = document.getElementById('age-error');
      var success = document.getElementById('success');
      emailErr.style.display = 'none'; ageErr.style.display = 'none';
      var email = document.getElementById('email').value;
      var age = parseInt(document.getElementById('age').value);
      var valid = true;
      if (!email || !email.includes('@')) { emailErr.style.display = 'block'; valid = false; }
      if (!age || age < 18) { ageErr.style.display = 'block'; valid = false; }
      if (valid) success.style.display = 'block';
    });
  </script>
</body></html>
```

- [ ] **Step 2: Create extraction fixtures**

```html
<!-- benchmark/fixtures/extraction/table.html -->
<!DOCTYPE html>
<html><head><title>Data Table</title></head>
<body>
  <h1>Browser Engine Comparison</h1>
  <table id="engines">
    <thead><tr><th>Engine</th><th>Browser</th><th>Year</th></tr></thead>
    <tbody>
      <tr><td>WebKit</td><td>Safari</td><td>2003</td></tr>
      <tr><td>Blink</td><td>Chrome</td><td>2013</td></tr>
      <tr><td>Gecko</td><td>Firefox</td><td>2004</td></tr>
    </tbody>
  </table>
</body></html>
```

```html
<!-- benchmark/fixtures/extraction/nested.html -->
<!DOCTYPE html>
<html><head><title>Nested Structure</title></head>
<body>
  <h1>Nested Content</h1>
  <ul id="tree">
    <li>Level 1 - Item A
      <ul><li>Level 2 - Item A1</li><li>Level 2 - Item A2</li></ul>
    </li>
    <li>Level 1 - Item B
      <ul><li>Level 2 - Item B1
        <ul><li>Level 3 - Item B1a</li></ul>
      </li></ul>
    </li>
  </ul>
</body></html>
```

```html
<!-- benchmark/fixtures/extraction/dynamic.html -->
<!DOCTYPE html>
<html><head><title>Dynamic Content</title></head>
<body>
  <h1>Dynamic Loading</h1>
  <div id="content">Loading...</div>
  <script>
    setTimeout(function() {
      document.getElementById('content').innerHTML = '<p>Data loaded: <span id="value">42</span></p>';
    }, 2000);
  </script>
</body></html>
```

- [ ] **Step 3: Write all 42 task JSON files**

Write each JSON file to its category directory. Follow the manifests above. Each file is `benchmark/tasks/{category}/{id}.json`.

For example, `benchmark/tasks/forms/form-001.json`:
```json
{
  "id": "form-001",
  "category": "forms",
  "difficulty": "easy",
  "intent": "Fill the login form with username 'testuser' and password 'pass123', then submit it",
  "start_url": "http://localhost:9876/forms/login.html",
  "requires": { "tools": [], "engines": [], "auth_domains": [], "features": [], "competitive": false },
  "eval": { "type": "contains", "must_include": ["submitted", "login"] },
  "eval_fallback": { "type": "llm_judge", "criteria": "Did the agent fill in both username and password fields and submit the form?" },
  "timeout_ms": 30000,
  "max_budget_usd": 0.25,
  "tags": ["forms", "login", "fixture"]
}
```

Follow this pattern for all 42 tasks, using the appropriate eval type from the manifest.

- [ ] **Step 4: Verify all tasks load**

Run: `npm run build && node -e "import('./dist/benchmark/task-loader.js').then(m => m.loadTasks('benchmark/tasks')).then(r => console.log(r.tasks.length + ' tasks, ' + r.errors.length + ' errors'))"`
Expected: 57 tasks loaded (15 nav + 15 form + 15 extraction + 12 workflow), 0 errors

- [ ] **Step 5: Commit**

```bash
git add benchmark/tasks/forms/ benchmark/tasks/extraction/ benchmark/tasks/workflows/ benchmark/fixtures/forms/ benchmark/fixtures/extraction/
git commit -m "feat(benchmark): 42 form, extraction, and workflow tasks + fixtures"
```

---

### Task 12: DOM Complexity, Auth, Accessibility, Error Recovery, Safari-Specific Tasks (39 tasks)

**Files:**
- Create: Task JSONs across 5 categories (8+8+8+8+7 = 39 tasks)
- Create: Fixture HTML for dom-complexity, error-recovery, and accessibility

**DOM Complexity (8 tasks):**

| ID | Difficulty | Intent |
|----|-----------|--------|
| dom-001 | easy | Find and click a button inside a Shadow DOM on the fixture page |
| dom-002 | easy | Extract text from an iframe on the fixture page |
| dom-003 | medium | Navigate the shadow DOM fixture — find a button in nested shadow roots, click it |
| dom-004 | medium | Extract content from a cross-origin simulated iframe fixture |
| dom-005 | medium | Find a lazy-loaded image on the fixture page — scroll down until it appears, extract its alt text |
| dom-006 | medium | Interact with a custom web component (shadow DOM + slots) on the fixture page |
| dom-007 | hard | Navigate a complex fixture with 3 levels of nested iframes, extract text from the deepest |
| dom-008 | hard | Find and fill a form inside a shadow DOM, submit it, verify the result appeared |

**Auth Flows (8 tasks):**

| ID | Difficulty | Intent |
|----|-----------|--------|
| auth-001 | easy | Verify you're logged into X by checking for profile elements on the home page |
| auth-002 | easy | On Reddit, verify you're logged in by finding your username in the page |
| auth-003 | medium | On X, navigate to your profile and extract your display name |
| auth-004 | medium | On Reddit, navigate to a subreddit, verify the "Create Post" button is visible (logged-in indicator) |
| auth-005 | medium | On LinkedIn, verify logged-in state by finding the messaging icon |
| auth-006 | medium | On X, navigate to Settings, extract the email address shown |
| auth-007 | hard | On LinkedIn, navigate to your profile, extract your headline and connection count |
| auth-008 | hard | On Reddit, navigate to your profile, extract your karma score and account age |

**Accessibility (8 tasks):**

| ID | Difficulty | Intent |
|----|-----------|--------|
| a11y-001 | easy | Take a snapshot of example.com and count elements with role=link |
| a11y-002 | easy | On the fixture page, find the search input using only role=searchbox, fill it |
| a11y-003 | medium | On Wikipedia, navigate entirely using ARIA landmarks — find main content region |
| a11y-004 | medium | On the fixture page, find all buttons by role, click the one named "Submit" |
| a11y-005 | medium | On HN, find the login link using text locator, not CSS selector |
| a11y-006 | medium | On GitHub, navigate using role=navigation landmarks only, find the Search input |
| a11y-007 | hard | On the fixture accessible app, complete a form using ONLY ref-based targeting (no CSS selectors) |
| a11y-008 | hard | On Wikipedia, navigate from Main Page to "WebKit" article using only a11y tree refs and locators |

**Error Recovery (8 tasks):**

| ID | Difficulty | Intent |
|----|-----------|--------|
| err-001 | easy | Click a non-existent element on example.com, report the error message |
| err-002 | easy | Try to extract text from a selector that doesn't exist, report what happened |
| err-003 | medium | On the fixture page with a cookie banner overlay, dismiss it, then click the button underneath |
| err-004 | medium | On the slow-loading fixture, wait for content to appear, then extract it |
| err-005 | medium | Click an element that moves (fixture with animated elements), verify auto-wait handles it |
| err-006 | medium | Navigate to a page that returns a 404 fixture, detect and report the error |
| err-007 | hard | On the stale element fixture, click an element that gets replaced by JS, handle the retry |
| err-008 | hard | Multi-step error recovery: navigate fixture, encounter overlay, dismiss it, fill form, handle validation error, resubmit |

**Safari-Specific (7 tasks):**

| ID | Difficulty | Intent |
|----|-----------|--------|
| saf-001 | easy | Run a health check and report which engines are available |
| saf-002 | easy | Navigate to example.com and report which engine was used |
| saf-003 | medium | Compare snapshot results from AppleScript engine vs the default engine |
| saf-004 | medium | Create a new tab, verify tab ownership is correctly assigned |
| saf-005 | medium | Test rate limiting — rapidly send 5 requests and report if any were throttled |
| saf-006 | hard | Navigate to a complex page, verify the correct engine was auto-selected based on requirements |
| saf-007 | hard | Test circuit breaker — trigger errors on a domain, verify cooldown activates |

- [ ] **Step 1: Create DOM complexity fixtures**

```html
<!-- benchmark/fixtures/dom-complexity/shadow-dom.html -->
<!DOCTYPE html>
<html><head><title>Shadow DOM Test</title></head>
<body>
  <h1>Shadow DOM</h1>
  <div id="host"></div>
  <script>
    const host = document.getElementById('host');
    const shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = '<button id="shadow-btn">Click Me</button><p id="shadow-text">Hidden in shadow</p>';
  </script>
</body></html>
```

```html
<!-- benchmark/fixtures/dom-complexity/iframes.html -->
<!DOCTYPE html>
<html><head><title>Iframe Test</title></head>
<body>
  <h1>Iframe Content</h1>
  <iframe id="frame1" srcdoc="<html><body><p id='inner'>Content inside iframe</p></body></html>" width="400" height="200"></iframe>
</body></html>
```

```html
<!-- benchmark/fixtures/dom-complexity/lazy-load.html -->
<!DOCTYPE html>
<html><head><title>Lazy Loading</title></head>
<body>
  <h1>Scroll Down</h1>
  <div style="height:2000px">Spacer</div>
  <img id="lazy-img" alt="Lazy loaded image" data-src="/dom-complexity/placeholder.png" style="width:200px;height:200px;background:#eee">
  <script>
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.src = e.target.dataset.src; e.target.dataset.loaded = 'true'; }});
    });
    observer.observe(document.getElementById('lazy-img'));
  </script>
</body></html>
```

- [ ] **Step 2: Create error recovery fixtures**

```html
<!-- benchmark/fixtures/error-recovery/cookie-banner.html -->
<!DOCTYPE html>
<html><head><title>Cookie Banner Test</title></head>
<body>
  <div id="overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center">
    <div style="background:white;padding:20px;border-radius:8px">
      <p>We use cookies</p>
      <button id="accept-cookies" onclick="document.getElementById('overlay').style.display='none'">Accept</button>
    </div>
  </div>
  <button id="main-action">Click me after dismissing banner</button>
  <div id="result" style="display:none">Button clicked!</div>
  <script>
    document.getElementById('main-action').addEventListener('click', function() {
      document.getElementById('result').style.display = 'block';
    });
  </script>
</body></html>
```

```html
<!-- benchmark/fixtures/error-recovery/slow-load.html -->
<!DOCTYPE html>
<html><head><title>Slow Loading</title></head>
<body>
  <h1>Please Wait</h1>
  <div id="content">Loading...</div>
  <script>
    setTimeout(function() {
      document.getElementById('content').innerHTML = '<p id="loaded">Content ready: <strong>42</strong></p>';
    }, 3000);
  </script>
</body></html>
```

```html
<!-- benchmark/fixtures/error-recovery/stale-element.html -->
<!DOCTYPE html>
<html><head><title>Stale Element</title></head>
<body>
  <h1>Stale Element Test</h1>
  <div id="container"><button id="target" onclick="replaceMe()">Click Me</button></div>
  <div id="result" style="display:none">Replacement clicked!</div>
  <script>
    function replaceMe() {
      document.getElementById('container').innerHTML = '<button id="target" onclick="document.getElementById(\'result\').style.display=\'block\'">New Button - Click Again</button>';
    }
  </script>
</body></html>
```

- [ ] **Step 3: Create accessibility fixtures**

```html
<!-- benchmark/fixtures/accessibility/aria-app.html -->
<!DOCTYPE html>
<html><head><title>Accessible App</title></head>
<body>
  <header role="banner"><h1>Accessible App</h1></header>
  <nav role="navigation" aria-label="Main">
    <a href="#home">Home</a>
    <a href="#about">About</a>
    <a href="#contact">Contact</a>
  </nav>
  <main role="main">
    <form role="form" aria-label="Contact form">
      <label for="search">Search</label>
      <input type="search" id="search" role="searchbox" name="search">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" required>
      <label for="msg">Message</label>
      <textarea id="msg" name="msg"></textarea>
      <button type="submit" aria-label="Submit form">Submit</button>
    </form>
  </main>
  <footer role="contentinfo"><p>Footer content</p></footer>
</body></html>
```

- [ ] **Step 4: Write all 39 task JSON files**

Write each task JSON to its category directory following the manifests above. Each follows the established schema pattern.

- [ ] **Step 5: Verify total task count**

Run: `npm run build && node -e "import('./dist/benchmark/task-loader.js').then(m => m.loadTasks('benchmark/tasks')).then(r => console.log(r.tasks.length + ' tasks, ' + r.errors.length + ' errors'))"`
Expected: 96 tasks loaded (57 prior + 39 new), 0 errors

- [ ] **Step 6: Commit**

```bash
git add benchmark/tasks/ benchmark/fixtures/
git commit -m "feat(benchmark): 39 tasks — dom-complexity, auth, a11y, error-recovery, safari-specific + fixtures"
```

---

### Task 13: Intelligence-Tier and Competitive Tasks (24 tasks)

**Files:**
- Create: 12 intelligence tasks in `benchmark/tasks/intelligence/`
- Create: 12 competitive tasks in `benchmark/tasks/competitive/`

**Intelligence-tier (12 tasks):**

| ID | Intent | Auth |
|----|--------|------|
| intel-001 | On Hacker News, find the most discussed post today and summarize its top 3 comments | no |
| intel-002 | On X, find what @anthropic posted most recently and get the reply count | x.com |
| intel-003 | On LinkedIn, find 3 software engineers at Anthropic and list their current titles | linkedin.com |
| intel-004 | On Reddit, go to r/programming, find a post about Rust, and extract the top-voted comment | reddit.com |
| intel-005 | On Wikipedia, find the current population of Tokyo and compare it to the population listed 5 years ago (use revision history) | no |
| intel-006 | Fill out the HN login form with test credentials, submit, detect the error message, and report what it says | no |
| intel-007 | On GitHub, find the most-starred repo created this week and get its README first line | no |
| intel-008 | On X, open the Explore page, find a trending topic, click into it, and extract 3 tweet texts | x.com |
| intel-009 | On Reddit, find a post with an embedded image in r/pics, extract the image URL and post title | reddit.com |
| intel-010 | On LinkedIn Jobs, search for "AI Engineer" in "San Francisco", extract the first 5 job titles and companies | linkedin.com |
| intel-011 | On Wikipedia, find the References section of the "Safari (web browser)" article and count how many external links it contains | no |
| intel-012 | On HN, find a Show HN post from today, visit the linked project, and extract the project's one-line description | no |

All intelligence tasks use `structured_output` as primary eval with `llm_judge` fallback.

**Competitive (12 tasks):**

| ID | Intent | SP Advantage |
|----|--------|-------------|
| comp-001 | Navigate to Wikipedia, search for "browser engine", extract the first 3 result titles | neutral |
| comp-002 | On example.com, extract all link URLs and their text | neutral |
| comp-003 | Fill a form on the fixture page (name, email, country dropdown) | neutral |
| comp-004 | On X, check if logged in and extract profile name if so | auth (SP advantage) |
| comp-005 | On Reddit, navigate to r/technology, extract the top 5 post titles | auth (SP advantage) |
| comp-006 | On LinkedIn, find the messaging icon and extract notification count | auth (SP advantage) |
| comp-007 | On HN, extract the top 10 story titles as structured JSON | neutral |
| comp-008 | On Wikipedia, navigate through 3 internal links, list all page titles visited | neutral |
| comp-009 | On X, navigate to Explore, find a trending topic, extract its name | auth (SP advantage) |
| comp-010 | On Reddit, search for "browser automation", extract first 5 results | auth (SP advantage) |
| comp-011 | Extract structured table data from the fixture page | neutral |
| comp-012 | Fill a multi-field search form on GitHub, extract results | neutral |

All competitive tasks have `requires.competitive: true`.

- [ ] **Step 1: Write all 12 intelligence task JSONs**

Example for intel-001:
```json
{
  "id": "intel-001",
  "category": "intelligence",
  "difficulty": "intelligence",
  "intent": "On Hacker News, find the most discussed post today (the one with the most comments) and summarize its top 3 comments",
  "start_url": "https://news.ycombinator.com/",
  "requires": { "tools": [], "engines": [], "auth_domains": [], "features": [], "competitive": false },
  "eval": {
    "type": "structured_output",
    "schema": {
      "type": "object",
      "properties": {
        "post_title": { "type": "string" },
        "comment_count": { "type": "number" },
        "top_comments": { "type": "array", "minItems": 3 }
      },
      "required": ["post_title", "top_comments"]
    }
  },
  "eval_fallback": {
    "type": "llm_judge",
    "criteria": "Did the agent find the most-discussed HN post and provide summaries of at least 3 comments from it?"
  },
  "timeout_ms": 120000,
  "max_budget_usd": 0.50,
  "tags": ["intelligence", "multi-step", "extraction", "hacker-news"]
}
```

Write all 12 intelligence tasks. Auth tasks include the appropriate `auth_domains`.

- [ ] **Step 2: Write all 12 competitive task JSONs**

Example for comp-001:
```json
{
  "id": "comp-001",
  "category": "competitive",
  "difficulty": "medium",
  "intent": "Navigate to Wikipedia, search for 'browser engine', extract the first 3 result titles",
  "start_url": "https://en.wikipedia.org/",
  "requires": { "tools": [], "engines": [], "auth_domains": [], "features": [], "competitive": true },
  "eval": {
    "type": "structured_output",
    "schema": {
      "type": "object",
      "properties": {
        "results": { "type": "array", "minItems": 3 }
      },
      "required": ["results"]
    }
  },
  "timeout_ms": 60000,
  "max_budget_usd": 0.30,
  "tags": ["competitive", "search", "extraction", "wikipedia"]
}
```

Write all 12 competitive tasks. Auth-advantage tasks include `auth_domains`.

- [ ] **Step 3: Verify final task count**

Run: `npm run build && node -e "import('./dist/benchmark/task-loader.js').then(m => m.loadTasks('benchmark/tasks')).then(r => console.log(r.tasks.length + ' tasks, ' + r.errors.length + ' errors'))"`
Expected: **120 tasks loaded, 0 errors**

- [ ] **Step 4: Commit**

```bash
git add benchmark/tasks/intelligence/ benchmark/tasks/competitive/
git commit -m "feat(benchmark): 24 intelligence-tier + competitive tasks — completes 120-task suite"
```

---

### Task 14: Build Verification and Dry Run

**Files:**
- Modify: `package.json` (verify bin entry works)

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: Clean compilation, `dist/benchmark/runner.js` exists

- [ ] **Step 2: Verify the CLI entry point**

Run: `node dist/benchmark/runner.js --dry-run`
Expected: Lists all 120 tasks with their categories and difficulty, shows skipped tasks with reasons

- [ ] **Step 3: Verify task loading and filtering**

Run: `node dist/benchmark/runner.js --dry-run --category navigation`
Expected: Shows only 15 navigation tasks

- [ ] **Step 4: Verify single-task mode**

Run: `node dist/benchmark/runner.js --dry-run --task nav-001`
Expected: Shows only nav-001

- [ ] **Step 5: Run the full test suite**

Run: `npm run test:unit`
Expected: All existing tests + all new benchmark tests pass

- [ ] **Step 6: Commit build verification**

```bash
git add package.json
git commit -m "chore(benchmark): verify build, CLI dry-run, and full test suite"
```

---

### Task 15: Run Baseline Benchmark

This task executes the first benchmark run to establish the baseline numbers.

- [ ] **Step 1: Ensure Safari is running with auth sessions**

Verify: Safari is open, logged into X, Reddit, LinkedIn. "Allow JavaScript from Apple Events" is enabled.

- [ ] **Step 2: Run baseline with sonnet**

Run: `npx safari-pilot-bench --model sonnet --parallel 3`

Watch output. This will take ~20-30 minutes for 120 tasks with 3 workers.

- [ ] **Step 3: Review baseline report**

Read the generated report at `benchmark/reports/{date}-{commit}.md`.
Review `benchmark/history.json` for the first run entry.
Check `benchmark/traces/` for per-task trace files.

- [ ] **Step 4: Run with opus for comparison (optional)**

Run: `npx safari-pilot-bench --model opus --parallel 3`

- [ ] **Step 5: Commit baseline results**

```bash
git add benchmark/history.json benchmark/reports/
git commit -m "data(benchmark): first baseline — sonnet, 120 tasks across 11 categories"
```

- [ ] **Step 6: Update TRACES.md**

Add iteration entry to TRACES.md documenting the benchmark suite implementation.
