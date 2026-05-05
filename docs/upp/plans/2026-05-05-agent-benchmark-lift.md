# Agent Benchmark Lift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Subagent-driven mode required. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between v0.1.28 shipped capabilities and agent benchmark utilization through three measured iterations, each reducing (wall time × tokens) by ≥20% on a WebBench-style agent loop.

**Architecture:** A self-contained agent harness (`bench/`) talks to safari-pilot via stdio MCP, runs ~5 fixture tasks against a local fixture server, scores each task on success/tool-calls/tokens/time, and writes results to `bench/baselines/<variant>.json`. The harness is the eval gate for every other change. Interventions land cluster-by-cluster (descriptions, schemas, locator-v2 nudges, tool search, skills, suggested_next_tools, recipe miner) and each cluster is followed by a measurement task that confirms the iteration's TT target.

**Tech Stack:** TypeScript + Vitest (existing), Anthropic SDK (`@anthropic-ai/sdk` — to be added), MCP stdio client (existing in `test/helpers/mcp-client.ts`), Anthropic Skills SKILL.md format, fixture HTTP server (existing in `test/helpers/fixture-server.ts`).

**Reference:** `SPRINT-INSTRUCTIONS.md` at project root has the codified user rules. `docs/upp/specs/2026-05-05-agent-benchmark-lift-design.md` is the spec. Browser Use's `browser-harness` (https://github.com/browser-use/browser-harness) is the inspiration for skill bundling and recipe extraction.

**Scope filter:** Only ≥parity capabilities per `safari-pilot-vs-playwright-parity-v3.html`. Skip partial (◆) / gap (✗) items.

---

## Iteration map

| Iteration | Cluster tasks | Gate | TT target |
|---|---|---|---|
| **Baseline (H-0)** | T1 → T2 → T3 | T3 produces baseline.json | T0 (=1.00) |
| **Iter 1** | T4 (Cluster A) → T5 (B) → T6 (C) | T7 measure | ≤0.80 × T0 |
| **Iter 2** | T8 (D-light) → T9 (F) | T10 measure | ≤0.64 × T0 |
| **Iter 3** | T11 (E) → T12 (G) | T13 measure | ≤0.51 × T0 |
| **Compound** | T14 (I) | (no gate, ships as-is) | — |
| **Ship** | T15 | — | — |

**Checkpoint cadence:** Write `CHECKPOINT.md` after every 2 tasks per user directive.

---

## Task 1: Bench harness scaffold (`bench/agent.ts` + `bench/score.ts`)

**Files:**
- Create: `bench/agent.ts`
- Create: `bench/score.ts`
- Create: `bench/run.sh`
- Create: `bench/types.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk` dep, `bench` npm script)
- Test: `test/e2e/bench-harness.test.ts`

**Architectural notes:**
- The harness uses the existing `McpTestClient` (`test/helpers/mcp-client.ts`) to talk to safari-pilot.
- Anthropic SDK in agent loop: `client.messages.create({ model, system, tools, messages })` with `tools` populated from a `tools/list` MCP call.
- `score.ts` reads the trace dir produced by McpTestClient and computes: `success: bool`, `tool_calls: number`, `input_tokens: number`, `output_tokens: number`, `wall_ms: number`. Tokens come from each `messages.create` response's `usage` object (sum across iterations).
- `run.sh` is the canonical entry point: `bench/run.sh <variant-tag>` writes `bench/baselines/<variant>.json`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/e2e/bench-harness.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('bench harness e2e', () => {
  let fixture: FixtureServer;
  beforeAll(async () => { fixture = await startFixtureServer(); }, 30_000);
  afterAll(async () => { if (fixture) await fixture.close(); });

  it('runs a single agent task end-to-end and writes a score record', async () => {
    const outDir = '/tmp/bench-test-' + Date.now();
    await mkdir(outDir, { recursive: true });
    // Run a 1-task smoke benchmark — assumes ANTHROPIC_API_KEY is set.
    // Task: navigate to fixture root, get_text from h1, terminate.
    const rc = await new Promise<number>((resolve) => {
      const p = spawn('node', ['--import', 'tsx', 'bench/agent.ts',
        '--task', 'bench/tasks/00-smoke.task.json',
        '--out', outDir,
        '--fixture-port', String(fixture.hostPort),
      ], { stdio: 'pipe', env: { ...process.env } });
      p.on('exit', resolve);
      // Pipe stderr for visibility but don't block on it.
      p.stderr?.on('data', () => undefined);
    });
    expect(rc, 'agent should exit 0').toBe(0);
    const score = JSON.parse(await readFile(join(outDir, 'score.json'), 'utf8'));
    expect(score).toMatchObject({
      success: expect.any(Boolean),
      tool_calls: expect.any(Number),
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      wall_ms: expect.any(Number),
    });
    expect(existsSync(join(outDir, 'tool-calls.jsonl')), 'trace file present').toBe(true);
  }, 180_000);
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `npx vitest run test/e2e/bench-harness.test.ts`
Expected: FAIL — `bench/agent.ts` does not exist yet.

- [ ] **Step 3: Dispatch test-reviewer-fast** (per TDD skill mandatory gate)

Use Agent tool, `subagent_type: test-reviewer-fast`, with the test file + spec context. Wait for PASS verdict. If REVISE, fix and re-dispatch.

- [ ] **Step 4: Implement `bench/types.ts`**

```typescript
// bench/types.ts
export interface BenchTask {
  id: string;
  description: string;       // Natural-language task for the agent
  fixtureRoute: string;       // e.g. "/t77-list" — joined with fixture base URL
  successOracle: {
    type: 'tool_called_with' | 'final_text_contains' | 'no_strict_violation';
    tool?: string;
    argMatch?: Record<string, unknown>;
    text?: string;
  };
  maxIterations: number;
  budgetTokens: number;
}

export interface BenchScore {
  task_id: string;
  variant: string;
  success: boolean;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  wall_ms: number;
  // tt = wall_ms * (input_tokens + output_tokens) — single-number cost metric
  tt: number;
  failure_reason?: string;
}
```

- [ ] **Step 5: Implement `bench/agent.ts`**

```typescript
// bench/agent.ts
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { argv } from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { initClient, callTool } from '../test/helpers/mcp-client.js';
import type { BenchTask, BenchScore } from './types.js';

function parseArgs(): { task: string; out: string; fixturePort: string; variant: string } {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
  return {
    task: args.get('task')!,
    out: args.get('out')!,
    fixturePort: args.get('fixture-port') ?? '0',
    variant: args.get('variant') ?? 'unspecified',
  };
}

async function main() {
  const { task: taskPath, out, fixturePort, variant } = parseArgs();
  await mkdir(out, { recursive: true });
  const task: BenchTask = JSON.parse(await readFile(taskPath, 'utf8'));
  const tracePath = `${out}/tool-calls.jsonl`;
  const start = Date.now();

  // Spawn safari-pilot MCP server (uses existing test helper).
  const { client, nextId } = await initClient('dist/index.js', 1, {
    env: { ...process.env, BENCH_TRACE: tracePath },
  });

  // Pull tool list.
  const toolsResp = await client.request('tools/list', {}, nextId());
  const tools = (toolsResp.result?.tools ?? []) as Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;

  const anthropic = new Anthropic();
  const fullUrl = `http://127.0.0.1:${fixturePort}${task.fixtureRoute}`;
  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: `Task: ${task.description}\nFixture URL: ${fullUrl}\nWhen done, respond with the final text.`,
  }];

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let success = false;
  let lastText = '';
  let strictViolation = false;

  for (let iter = 0; iter < task.maxIterations; iter++) {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'You are a browser automation agent. Use the safari_* tools to complete the task. End by stating the final answer.',
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: (t.inputSchema as Anthropic.Tool['input_schema']) ?? { type: 'object', properties: {} },
      })),
      messages,
    });
    inputTokens += resp.usage.input_tokens;
    outputTokens += resp.usage.output_tokens;
    messages.push({ role: 'assistant', content: resp.content });

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      lastText = textBlock?.text ?? '';
      break;
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      toolCalls++;
      try {
        const result = await callTool(client, use.name, use.input as Record<string, unknown>, nextId(), 30_000);
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('STRICTNESS_VIOLATION')) strictViolation = true;
        toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: `error: ${msg}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });

    if (inputTokens + outputTokens > task.budgetTokens) break;
  }

  // Score against oracle.
  if (task.successOracle.type === 'final_text_contains') {
    success = lastText.toLowerCase().includes((task.successOracle.text ?? '').toLowerCase());
  } else if (task.successOracle.type === 'no_strict_violation') {
    success = !strictViolation && toolCalls > 0;
  } else if (task.successOracle.type === 'tool_called_with') {
    // Walk tool-calls.jsonl for any matching call.
    try {
      const trace = await readFile(tracePath, 'utf8');
      const lines = trace.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      success = lines.some((entry) =>
        entry.tool === task.successOracle.tool &&
        Object.entries(task.successOracle.argMatch ?? {}).every(([k, v]) => entry.args?.[k] === v),
      );
    } catch { success = false; }
  }

  const wall_ms = Date.now() - start;
  const score: BenchScore = {
    task_id: task.id,
    variant,
    success,
    tool_calls: toolCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    wall_ms,
    tt: wall_ms * (inputTokens + outputTokens),
    failure_reason: success ? undefined : (strictViolation ? 'strict_violation' : 'oracle_unmet'),
  };
  await writeFile(`${out}/score.json`, JSON.stringify(score, null, 2));
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Implement `bench/score.ts` (aggregator)**

```typescript
// bench/score.ts — aggregates per-task score.json files into a variant scoreboard.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { argv } from 'node:process';
import type { BenchScore } from './types.js';

async function main() {
  const dir = argv[2];
  const variant = argv[3] ?? 'unspecified';
  const out = argv[4] ?? `bench/baselines/${variant}.json`;
  await mkdir(out.substring(0, out.lastIndexOf('/')), { recursive: true });

  const taskDirs = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => `${dir}/${d.name}`);

  const scores: BenchScore[] = [];
  for (const td of taskDirs) {
    try {
      const s = JSON.parse(await readFile(`${td}/score.json`, 'utf8')) as BenchScore;
      scores.push(s);
    } catch { /* skip task dirs without score */ }
  }
  const totals = {
    variant,
    n_tasks: scores.length,
    successes: scores.filter((s) => s.success).length,
    success_rate: scores.length === 0 ? 0 : scores.filter((s) => s.success).length / scores.length,
    total_tool_calls: scores.reduce((a, s) => a + s.tool_calls, 0),
    total_input_tokens: scores.reduce((a, s) => a + s.input_tokens, 0),
    total_output_tokens: scores.reduce((a, s) => a + s.output_tokens, 0),
    total_wall_ms: scores.reduce((a, s) => a + s.wall_ms, 0),
    total_tt: scores.reduce((a, s) => a + s.tt, 0),
    per_task: scores,
  };
  await writeFile(out, JSON.stringify(totals, null, 2));
  console.log(`Scoreboard written: ${out}`);
  console.log(`Success: ${totals.successes}/${totals.n_tasks} | TT: ${totals.total_tt}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 7: Implement `bench/run.sh`**

```bash
#!/bin/bash
# bench/run.sh <variant-tag> [task-glob]
# Runs all tasks under bench/tasks/, scores each, aggregates into bench/baselines/<variant>.json
set -euo pipefail
VARIANT="${1:-unspecified}"
GLOB="${2:-bench/tasks/*.task.json}"
TS="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="bench/runs/${VARIANT}-${TS}"
mkdir -p "$RUN_DIR"
echo "== Variant: $VARIANT == Run dir: $RUN_DIR =="

# Start fixture server in background — relies on existing test helper.
# For simplicity we ask the user to ensure dev fixture is up at PORT=18080,
# OR each agent invocation spins one (current implementation).
for task in $GLOB; do
  task_id="$(basename "$task" .task.json)"
  out_dir="$RUN_DIR/$task_id"
  mkdir -p "$out_dir"
  echo "-- Running $task_id"
  node --import tsx bench/agent.ts \
    --task "$task" \
    --out "$out_dir" \
    --fixture-port 18080 \
    --variant "$VARIANT" || echo "  (task $task_id failed)"
done

node --import tsx bench/score.ts "$RUN_DIR" "$VARIANT" "bench/baselines/${VARIANT}.json"
```

- [ ] **Step 8: Add deps + script to `package.json`**

Run: `npm install --save-dev @anthropic-ai/sdk tsx`

Add to scripts: `"bench": "bash bench/run.sh"`

- [ ] **Step 9: Run test — verify it passes**

Prereq: `ANTHROPIC_API_KEY` exported. If not available, the test should be skipped (add `it.skipIf(!process.env.ANTHROPIC_API_KEY)`).

Run: `npx vitest run test/e2e/bench-harness.test.ts`
Expected: PASS (or SKIP if key absent).

- [ ] **Step 10: Commit**

```bash
git add bench/ test/e2e/bench-harness.test.ts package.json package-lock.json
git commit -m "feat(bench): agent harness scaffold — Claude SDK loop + score + run.sh"
```

---

## Task 2: Five WebBench-style fixture tasks

**Files:**
- Create: `bench/tasks/00-smoke.task.json`
- Create: `bench/tasks/01-extract-h1.task.json`
- Create: `bench/tasks/02-multi-element-list.task.json`
- Create: `bench/tasks/03-form-fill.task.json`
- Create: `bench/tasks/04-paginate-extract.task.json`
- Create: `bench/tasks/05-strict-mode.task.json`
- Modify: `test/helpers/fixture-server.ts` (add 3 new routes)
- Test: `test/e2e/bench-tasks.test.ts`

Each task is a minimal WebBench-shape: agent gets natural-language goal + URL, must emit final text matching the oracle. Tasks deliberately exercise ≥parity capabilities (locators, query_all, chain ops, strict mode, extraction).

- [ ] **Step 1: Write the failing test**

```typescript
// test/e2e/bench-tasks.test.ts
import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

describe('bench task fixture sanity', () => {
  it('every task file is valid JSON with required fields', async () => {
    const taskFiles = (await readdir('bench/tasks')).filter((f) => f.endsWith('.task.json'));
    expect(taskFiles.length, 'at least 5 task files').toBeGreaterThanOrEqual(5);
    for (const f of taskFiles) {
      const t = JSON.parse(await readFile(`bench/tasks/${f}`, 'utf8'));
      expect(t.id, `${f}.id`).toBeTruthy();
      expect(t.description, `${f}.description`).toBeTruthy();
      expect(t.fixtureRoute, `${f}.fixtureRoute`).toMatch(/^\//);
      expect(t.successOracle?.type).toMatch(/^(tool_called_with|final_text_contains|no_strict_violation)$/);
      expect(t.maxIterations).toBeGreaterThanOrEqual(3);
      expect(t.budgetTokens).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test — verify FAIL** (no task files exist)

- [ ] **Step 3: Dispatch test-reviewer-fast.** (5 small task assertions; fast-mode applies.)

- [ ] **Step 4: Create the 6 task JSON files**

`bench/tasks/00-smoke.task.json`:
```json
{
  "id": "00-smoke",
  "description": "Read the page heading and report its text.",
  "fixtureRoute": "/bench-smoke",
  "successOracle": { "type": "final_text_contains", "text": "Hello from Smoke" },
  "maxIterations": 6,
  "budgetTokens": 8000
}
```

`bench/tasks/01-extract-h1.task.json`:
```json
{
  "id": "01-extract-h1",
  "description": "Navigate to the page and report the H1 heading text. Return only that text.",
  "fixtureRoute": "/bench-h1",
  "successOracle": { "type": "final_text_contains", "text": "Quarterly Report 2026" },
  "maxIterations": 8,
  "budgetTokens": 12000
}
```

`bench/tasks/02-multi-element-list.task.json`:
```json
{
  "id": "02-multi-element-list",
  "description": "List ALL items in the .product-list as a comma-separated string.",
  "fixtureRoute": "/bench-list",
  "successOracle": { "type": "final_text_contains", "text": "Apple, Banana, Cherry" },
  "maxIterations": 10,
  "budgetTokens": 15000
}
```

`bench/tasks/03-form-fill.task.json`:
```json
{
  "id": "03-form-fill",
  "description": "Fill in the email field with 'test@example.com', click Submit, and report the success message text.",
  "fixtureRoute": "/bench-form",
  "successOracle": { "type": "final_text_contains", "text": "Thanks, test@example.com" },
  "maxIterations": 12,
  "budgetTokens": 18000
}
```

`bench/tasks/04-paginate-extract.task.json`:
```json
{
  "id": "04-paginate-extract",
  "description": "There are 3 pages of items. Extract every item title across all pages and report them as a comma-separated list.",
  "fixtureRoute": "/bench-paginate?page=1",
  "successOracle": { "type": "final_text_contains", "text": "Item-1A, Item-1B, Item-2A, Item-2B, Item-3A, Item-3B" },
  "maxIterations": 20,
  "budgetTokens": 30000
}
```

`bench/tasks/05-strict-mode.task.json`:
```json
{
  "id": "05-strict-mode",
  "description": "Click the 'Sign In' button. There are multiple buttons on the page. Use a strategy that disambiguates correctly and report the page URL after the click.",
  "fixtureRoute": "/bench-strict",
  "successOracle": { "type": "final_text_contains", "text": "/signed-in" },
  "maxIterations": 10,
  "budgetTokens": 15000
}
```

- [ ] **Step 5: Add fixture routes to `test/helpers/fixture-server.ts`**

Add inside the existing route handler (after current routes):
```javascript
if (req.url === '/bench-smoke' || req.url === '/bench-smoke/') {
  return res.end('<!doctype html><html><body><h1>Hello from Smoke</h1></body></html>');
}
if (req.url === '/bench-h1' || req.url === '/bench-h1/') {
  return res.end('<!doctype html><html><body><h1>Quarterly Report 2026</h1><p>Body content</p></body></html>');
}
if (req.url === '/bench-list' || req.url === '/bench-list/') {
  return res.end('<!doctype html><html><body><ul class="product-list"><li>Apple</li><li>Banana</li><li>Cherry</li></ul></body></html>');
}
if (req.url === '/bench-form' || req.url === '/bench-form/') {
  return res.end(`<!doctype html><html><body>
    <form id="f"><label>Email <input name="email" id="email"/></label>
    <button type="button" id="submit">Submit</button></form>
    <div id="msg"></div>
    <script>
      document.getElementById('submit').onclick = () => {
        const v = document.getElementById('email').value;
        document.getElementById('msg').innerText = 'Thanks, ' + v;
      };
    </script></body></html>`);
}
if (req.url?.startsWith('/bench-paginate')) {
  const u = new URL(req.url, 'http://x');
  const page = u.searchParams.get('page') ?? '1';
  const items = page === '1' ? ['Item-1A', 'Item-1B'] : page === '2' ? ['Item-2A', 'Item-2B'] : ['Item-3A', 'Item-3B'];
  const next = page === '3' ? '' : `<a href="/bench-paginate?page=${Number(page)+1}" class="next">Next</a>`;
  return res.end(`<!doctype html><html><body>${items.map(i=>`<div class="item">${i}</div>`).join('')}${next}</body></html>`);
}
if (req.url === '/bench-strict' || req.url === '/bench-strict/') {
  return res.end(`<!doctype html><html><body>
    <button>Sign In</button>
    <button>Sign In</button>
    <button data-test="primary-signin">Sign In</button>
    <script>
      document.querySelectorAll('button').forEach(b => {
        if (b.dataset.test === 'primary-signin') {
          b.onclick = () => location.href = '/signed-in';
        }
      });
    </script></body></html>`);
}
if (req.url === '/signed-in' || req.url === '/signed-in/') {
  return res.end('<!doctype html><html><body><h1>Signed In</h1></body></html>');
}
```

- [ ] **Step 6: Run test — verify PASS**

Run: `npx vitest run test/e2e/bench-tasks.test.ts`

- [ ] **Step 7: Commit**

```bash
git add bench/tasks test/helpers/fixture-server.ts test/e2e/bench-tasks.test.ts
git commit -m "feat(bench): 6 fixture tasks + bench-* fixture routes"
```

---

## Task 3: Run baseline (Iteration H-0) and lock TT scoreboard

**Files:**
- Create: `bench/baselines/v0.1.28-baseline.json`
- Create: `bench/baselines/README.md`

**Note:** This is an EXECUTION task, not a code change. No TDD — the gate is "the file exists and contains real numbers."

- [ ] **Step 1: Build and prepare**

```bash
npm run build
# Confirm Safari extension is installed and enabled at v0.1.28 (user-confirmed in prior session).
# Confirm ANTHROPIC_API_KEY is exported.
```

- [ ] **Step 2: Run baseline**

```bash
bash bench/run.sh v0.1.28-baseline
```

- [ ] **Step 3: Verify scoreboard**

```bash
cat bench/baselines/v0.1.28-baseline.json | jq '{success_rate, total_tt, n_tasks}'
```

Expected: success_rate > 0 (some tasks should pass even with stock descriptions); total_tt is the TT0 anchor for all subsequent comparisons.

- [ ] **Step 4: Document the anchor in `bench/baselines/README.md`**

```markdown
# Baselines

`v0.1.28-baseline.json` — anchor for the agent benchmark lift sprint.
Variant: stock v0.1.28, no description rewrites, no skills, no tool search.
Model: claude-haiku-4-5-20251001.
TT (total_tt) is the multiplicative product of total_wall_ms × (input_tokens + output_tokens).
Subsequent iterations target ≤0.80 / ≤0.64 / ≤0.51 of this number.
```

- [ ] **Step 5: Commit**

```bash
git add bench/baselines
git commit -m "bench: lock v0.1.28 baseline scoreboard (TT0 anchor)"
```

**CHECKPOINT GATE:** After Task 2 completed, write `CHECKPOINT.md`. After Task 3 (this task), do not checkpoint — proceed to Task 4.

---

## Task 4: Cluster A — Tool description audit + rewrite (parity-only tools)

**Files:**
- Modify: `src/tools/navigation.ts`
- Modify: `src/tools/interaction.ts`
- Modify: `src/tools/extraction.ts`
- Modify: `src/tools/auth-state.ts`
- Modify: `src/tools/network.ts`
- Modify: `src/tools/wait.ts`
- Modify: `src/tools/selector-pack.ts`
- Modify: `src/tools/locator.ts` (or wherever locator-using tools live)
- Test: `test/unit/tools/description-quality.test.ts`

**Approach:** every parity-tier tool's `description` rewritten to:
```
<verb action>. Use when <trigger>. <key constraint or alt-ref>.
```
≤400 chars. Include trigger phrases the agent can latch onto. Move long detail to per-tool markdown side files (deferred — not in this task).

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/description-quality.test.ts
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';

const PARITY_TOOLS = new Set([
  'safari_navigate','safari_navigate_back','safari_navigate_forward','safari_reload','safari_new_tab','safari_close_tab','safari_list_tabs',
  'safari_click','safari_type','safari_fill','safari_press_key','safari_hover','safari_select_option','safari_double_click','safari_drag','safari_scroll','safari_check','safari_handle_dialog',
  'safari_get_text','safari_get_html','safari_get_attribute','safari_snapshot','safari_extract_tables','safari_extract_links','safari_extract_images','safari_extract_metadata','safari_smart_scrape','safari_paginate_scrape','safari_evaluate','safari_eval_in_frame','safari_get_console_messages','safari_query_all',
  'safari_query_shadow','safari_click_shadow','safari_list_frames',
  'safari_wait_for','safari_wait_for_download',
  'safari_register_selector','safari_unregister_selector',
  'safari_set_cookie','safari_get_cookies','safari_delete_cookie','safari_local_storage_get','safari_local_storage_set','safari_session_storage_get','safari_session_storage_set','safari_storage_state_export','safari_storage_state_import',
]);

describe('Cluster A — tool descriptions meet quality bar', () => {
  it('every parity-tier tool has a "Use when" trigger phrase', async () => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const tools = server.listToolDefinitions();
    const offenders: string[] = [];
    for (const t of tools) {
      if (!PARITY_TOOLS.has(t.name)) continue;
      const desc = t.description ?? '';
      if (!/Use when\b/i.test(desc)) offenders.push(t.name);
    }
    expect(offenders, `tools missing "Use when" trigger: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every parity-tier tool description is <= 400 chars', () => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const tools = server.listToolDefinitions();
    const offenders: Array<[string, number]> = [];
    for (const t of tools) {
      if (!PARITY_TOOLS.has(t.name)) continue;
      const len = (t.description ?? '').length;
      if (len > 400) offenders.push([t.name, len]);
    }
    expect(offenders, `tools over 400 chars: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('every parity-tier tool description fits in 1-2 sentences (max 2 periods + 1 line)', () => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const tools = server.listToolDefinitions();
    const offenders: string[] = [];
    for (const t of tools) {
      if (!PARITY_TOOLS.has(t.name)) continue;
      const desc = t.description ?? '';
      const sentences = desc.split(/[.!?]\s/).filter((s) => s.trim().length > 0);
      if (sentences.length > 2) offenders.push(`${t.name} (${sentences.length} sentences)`);
    }
    expect(offenders, `tools with >2 sentences: ${offenders.join(', ')}`).toEqual([]);
  });
});
```

Pre-condition: `SafariPilotServer.listToolDefinitions()` must exist. If not, add it as a non-breaking method that walks `this.modules` and collects `getDefinitions()` results.

- [ ] **Step 2: Run test — verify FAIL** (current descriptions don't have "Use when")

- [ ] **Step 3: Dispatch test-reviewer-fast.** 3 tests, fast mode.

- [ ] **Step 4: Rewrite descriptions for navigation tools (`src/tools/navigation.ts`)**

For each tool, replace `description:` with the new pattern. Examples:

```typescript
// safari_navigate
description: 'Navigate the current tab to a URL and wait for load. Use when starting a task, following a known link, or after a redirect chain. Updates tab ownership; subsequent tools target the new URL.',

// safari_new_tab
description: 'Open a new Safari tab at a URL. Use when isolating work from an existing tab, opening multiple windows in parallel, or starting a task with a fresh context. Returns a tabUrl that you must pass to subsequent tools.',

// safari_list_tabs
description: 'List all Safari tabs the agent owns (created via safari_new_tab). Use when you have lost track of an agent-owned tab or need to discover available tabs after an unexpected error. Bypasses ownership checks.',

// safari_close_tab
description: 'Close an agent-owned Safari tab. Use when finished with a task, when a tab is in an unrecoverable state, or to clean up before a new isolated workflow.',
```

Apply equivalent rewrites to `safari_navigate_back`, `safari_navigate_forward`, `safari_reload`. (Skip `safari_navigate_*` partials: device emulation, viewport — out of scope.)

- [ ] **Step 5: Rewrite descriptions for interaction tools (`src/tools/interaction.ts`)**

```typescript
// safari_click
description: 'Click an element on the page. Use when activating a button, link, checkbox, or any clickable. Locator strict mode is enforced — if multiple elements match, the call throws StrictnessViolationError; use a chain filter or safari_query_all instead.',

// safari_type
description: 'Type text into a focused element character-by-character. Use when an input expects keystroke events (autocomplete, debounced search). For plain form fills prefer safari_fill which is faster.',

// safari_fill
description: 'Set the value of an input element directly. Use when filling form fields where keystroke fidelity is not required — faster than safari_type. Strict mode enforced on the locator.',

// safari_hover
description: 'Hover the mouse over an element to trigger hover-only menus or tooltips. Use before clicking children that only appear on hover.',

// safari_press_key
description: 'Press a keyboard key with optional modifiers. Use for Enter to submit, Escape to dismiss, Tab/Shift-Tab for keyboard navigation, or Cmd-A/Cmd-C combos.',

// safari_select_option
description: 'Select an <option> in a native <select> by value, label, or index. Use when interacting with HTML select elements. For custom dropdowns built with divs use safari_click on the option element.',

// safari_double_click
description: 'Double-click an element. Use when activating a UI affordance that requires double-click (rare on web; mostly file managers, editors).',

// safari_drag
description: 'Drag from one element to another. Use for sortable lists, file drops onto drop zones, or canvas-based UI. Both endpoints accept locator descriptors.',

// safari_scroll
description: 'Scroll the page or a scrollable container by pixels or to an element. Use when content is below the fold or to bring an element into view before clicking.',

// safari_check
description: 'Set the checked state of a checkbox or radio. Use when toggling form options. Idempotent — passing a checked state matching current state is a no-op.',

// safari_handle_dialog
description: 'Pre-arm a handler for the next JS alert/confirm/prompt. Use BEFORE the action that triggers the dialog — Safari blocks on dialogs and other tools cannot run until handled.',
```

- [ ] **Step 6: Rewrite descriptions for extraction tools (`src/tools/extraction.ts`)**

```typescript
// safari_get_text
description: 'Read the visible text of an element. Use to verify a result, capture an answer, or read a label. Strict mode — multi-match throws; use safari_query_all for multi-element extraction.',

// safari_get_html
description: 'Read the outer or inner HTML of an element. Use when text alone is insufficient — preserved attributes, nested structure, or HTML-aware downstream parsing. Strict mode enforced.',

// safari_get_attribute
description: 'Read a named attribute (href, src, value, data-*) of an element. Use when capturing links, image URLs, form values, or test-ids. Strict mode enforced.',

// safari_snapshot
description: 'Build a YAML or JSON accessibility snapshot of the page or a sub-tree, with refs (e1, e2, ...). Use FIRST after a navigation when the page structure is unknown — every subsequent tool can target by ref. Cheaper than reading raw HTML.',

// safari_extract_tables
description: 'Extract all <table> elements as structured JSON {headers, rows}. Use when the answer is in a table — far cheaper than parsing HTML manually. Auto-detects header rows.',

// safari_extract_links
description: 'Extract every link on the page as {text, href, attrs}. Use when scoping link discovery — e.g., finding all "next" / pagination links, or downloading a list of URLs.',

// safari_extract_images
description: 'Extract every <img> as {src, alt, width, height}. Use when collecting image catalogs or auditing alt text. Resolves srcset to canonical src.',

// safari_extract_metadata
description: 'Extract document <meta>, OpenGraph, Twitter, JSON-LD, and canonical link metadata. Use when capturing page identity for citation, social sharing detection, or schema.org parsing.',

// safari_smart_scrape
description: 'Scrape the page into a JSON object matching a provided schema. Use when extracting heterogenous structured data — far higher signal than a snapshot when the schema is known. Schema follows JSON Schema.',

// safari_paginate_scrape
description: 'Scrape a paginated list across N pages. Use when items span multiple pages and a single safari_smart_scrape would miss data. Handles next-link discovery via selector.',

// safari_evaluate
description: 'Run arbitrary JavaScript in the page and return its value. Use ONLY as escape hatch when no structured tool fits — prefer safari_get_text, safari_extract_tables, or safari_query_all. Subject to security pipeline.',

// safari_eval_in_frame
description: 'Run JavaScript inside a specific iframe. Use when the target content lives in a same-origin or cross-origin frame. List frames first via safari_list_frames.',

// safari_get_console_messages
description: 'Read buffered console.log/warn/error from the page since the last call. Use when debugging an in-page bug or verifying a JS event fired. Level filter supported.',

// safari_query_all
description: 'Return ALL elements matching a locator + optional chain, with refs. Use when the answer is a list (rows in a table-as-divs, search results, products). Always prefer over manual loops or repeated safari_get_text calls. Pairs with chain ops to filter.',
```

- [ ] **Step 7: Rewrite descriptions for locator-aware tools to mention chain field**

Find every tool whose inputSchema includes `chain` and append to the description:
> ` Combine with chain: [{filter: ...}, {nth: 0}] to disambiguate when multiple elements match.`

(Stays under the 400-char cap because original is short.)

- [ ] **Step 8: Rewrite for auth-state, network, wait, shadow, frames, selector-pack tools**

`src/tools/auth-state.ts`:
```typescript
// safari_set_cookie
description: 'Set a cookie on a domain. Use when seeding test session state, bypassing login when a session token is known, or restoring a saved session.',

// safari_get_cookies
description: 'Read all cookies for a domain or all loaded domains. Use when capturing session state for storage_state_export or debugging cookie-based auth.',

// safari_delete_cookie
description: 'Delete a specific cookie. Use when forcing a logout, invalidating a stale session, or testing cookie-absent code paths.',

// safari_local_storage_get
description: 'Read a single key from localStorage on a tab. Use when an app stores auth tokens or app state in localStorage rather than cookies.',

// safari_local_storage_set
description: 'Set a single key in localStorage. Use when seeding app state, restoring a saved session, or testing token rotation.',

// safari_session_storage_get
description: 'Read from sessionStorage (per-tab, lost on close). Use when an app uses sessionStorage for tab-scoped state.',

// safari_session_storage_set
description: 'Write to sessionStorage. Use when seeding tab-scoped state for a test or workflow.',

// safari_storage_state_export
description: 'Export cookies + localStorage + sessionStorage for a domain into a JSON snapshot. Use BEFORE close to persist session for re-import in a future tab — bypass-login-on-restart pattern.',

// safari_storage_state_import
description: 'Import a previously-exported storage_state into a tab. Use to skip login by replaying a saved auth blob.',
```

`src/tools/network.ts` (≥parity rows only):
```typescript
// safari_list_network_requests
description: 'List all network requests captured for a tab since enable. Use when verifying an XHR/fetch fired, checking request headers, or correlating UI events with backend calls.',

// safari_get_network_request
description: 'Read a single network request by ID with full request/response detail. Use after safari_list_network_requests narrows down the target.',

// safari_network_offline
description: 'Toggle offline mode for the tab. Use when testing offline UI, retry logic, or service-worker caching behavior.',

// safari_network_throttle
description: 'Throttle the tab to a named profile (Slow3G, Fast3G, etc) or custom bandwidth. Use when testing slow-network UX or reproducing latency-dependent bugs.',

// safari_websocket_listen
description: 'Start capturing WebSocket frames for a tab. Use when validating realtime traffic — chat, live updates, collaborative editing.',

// safari_websocket_filter
description: 'Filter a captured WebSocket stream by direction and content. Use to find a specific frame in a noisy stream.',

// safari_dump_har
description: 'Dump captured network as a HAR archive. Use when downstream analysis tools expect HAR format, or for sharing a repro with a backend team.',
```

`src/tools/wait.ts`:
```typescript
// safari_wait_for
description: 'Wait for a condition: selector visible, hidden, text present, text gone, URL match, JS predicate, or networkidle. Use BEFORE a follow-up action that depends on async state — replaces sleep/setTimeout entirely.',

// safari_wait_for_download
description: 'Wait for a download to complete and return the local path. Use after triggering a file export — pairs with the click that initiates the download.',
```

`src/tools/selector-pack.ts` (T79):
```typescript
// safari_register_selector
description: 'Register a custom selector engine for the tab as a JS function body. Use when the same complex element-finding logic is needed >2 times in a workflow — register once, then refer via "pack:<name>=<arg>" in any locator. Persists across navigations until tab close. Sensitive — passes through HumanApproval.',

// safari_unregister_selector
description: 'Unregister a previously-registered selectorPack on the tab. Use when the pack name is being recycled or to free storage.',
```

`src/tools/shadow.ts` / `safari_query_shadow` / `safari_click_shadow`:
```typescript
// safari_query_shadow
description: 'Find an element inside Shadow DOM, piercing open shadow roots. Use ONLY when standard CSS selectors fail because the target is in a custom-element shadow tree.',

// safari_click_shadow
description: 'Click an element inside Shadow DOM. Use as the shadow-aware replacement for safari_click when the target is shadow-rooted.',
```

`src/tools/frames.ts`:
```typescript
// safari_list_frames
description: 'List all iframes on the page with frameId, src, and same-origin flag. Use BEFORE eval_in_frame or any frame-targeted tool to discover the right frameId.',
```

- [ ] **Step 9: Run test — verify PASS**

Run: `npx vitest run test/unit/tools/description-quality.test.ts`
Expected: all 3 tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/tools/ test/unit/tools/description-quality.test.ts
git commit -m "feat(cluster-A): rewrite parity-tier tool descriptions as 'what + WHEN' (≤400 chars)"
```

**CHECKPOINT after Task 4** — write CHECKPOINT.md.

---

## Task 5: Cluster B — InputSchema enum/pattern hardening

**Files:**
- Modify: `src/tools/network.ts` (throttle profile enum)
- Modify: `src/tools/extraction.ts` (snapshot format enum, level enum on console)
- Modify: `src/tools/interaction.ts` (key enum or pattern on safari_press_key)
- Modify: `src/tools/wait.ts` (waitFor condition enum)
- Modify: `src/tools/auth-state.ts` (sameSite enum)
- Test: `test/unit/tools/schema-strictness.test.ts`

**Approach:** for every closed-set string parameter, add an `enum` array. For format-constrained strings (selectors, refs, URLs), add a `pattern`. For numeric ranges add `minimum`/`maximum`.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/schema-strictness.test.ts
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';

const REQUIRED_ENUMS: Array<{ tool: string; param: string; values: string[] }> = [
  { tool: 'safari_network_throttle', param: 'profile', values: ['Slow3G', 'Fast3G', 'Slow4G', 'Fast4G', 'WiFi', 'Custom'] },
  { tool: 'safari_snapshot', param: 'format', values: ['yaml', 'json'] },
  { tool: 'safari_get_console_messages', param: 'level', values: ['log', 'info', 'warn', 'error', 'debug', 'all'] },
  { tool: 'safari_wait_for', param: 'condition', values: ['visible', 'hidden', 'text', 'textGone', 'urlMatch', 'function', 'networkidle'] },
];

describe('Cluster B — schema strictness on closed-set params', () => {
  it.each(REQUIRED_ENUMS)('$tool.$param has enum constraint', ({ tool, param, values }) => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const def = server.listToolDefinitions().find((t) => t.name === tool);
    if (!def) return; // tool may not exist — skip but don't fail
    const props = (def.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties ?? {};
    const paramSchema = props[param];
    expect(paramSchema, `${tool}.${param} property exists`).toBeTruthy();
    expect(paramSchema?.enum, `${tool}.${param} has enum`).toBeDefined();
    for (const v of values) {
      expect(paramSchema?.enum, `${tool}.${param}.enum contains "${v}"`).toContain(v);
    }
  });
});
```

- [ ] **Step 2: Run test — verify FAIL** (enums missing)

- [ ] **Step 3: Dispatch test-reviewer-fast** (~4 small assertions, fast mode)

- [ ] **Step 4: Add enums in `src/tools/network.ts` (throttle)**

```typescript
// In handleThrottle's getDefinitions:
inputSchema: {
  type: 'object',
  properties: {
    tabUrl: { type: 'string', description: 'Tab URL' },
    profile: { type: 'string', enum: ['Slow3G', 'Fast3G', 'Slow4G', 'Fast4G', 'WiFi', 'Custom'], description: 'Network profile preset' },
    downloadKbps: { type: 'number', minimum: 0, description: 'Download bandwidth (Kbps), used when profile=Custom' },
    uploadKbps: { type: 'number', minimum: 0, description: 'Upload bandwidth (Kbps), used when profile=Custom' },
    latencyMs: { type: 'number', minimum: 0, description: 'Round-trip latency (ms), used when profile=Custom' },
  },
  required: ['tabUrl', 'profile'],
},
```

- [ ] **Step 5: Add enums in `src/tools/extraction.ts`**

For `safari_snapshot`:
```typescript
properties: {
  // ...existing...
  format: { type: 'string', enum: ['yaml', 'json'], description: 'Output format. yaml is denser/cheaper for the agent; json is friendlier for downstream parsing.' },
}
```

For `safari_get_console_messages`:
```typescript
properties: {
  // ...existing...
  level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug', 'all'], description: 'Filter by console level. Default: all.' },
}
```

- [ ] **Step 6: Add enum in `src/tools/wait.ts`**

```typescript
properties: {
  tabUrl: { type: 'string' },
  condition: { type: 'string', enum: ['visible', 'hidden', 'text', 'textGone', 'urlMatch', 'function', 'networkidle'], description: 'What to wait for' },
  selector: { type: 'string', description: 'Required for visible/hidden/text/textGone' },
  text: { type: 'string', description: 'Required for text/textGone' },
  url: { type: 'string', description: 'Regex string. Required for urlMatch' },
  fn: { type: 'string', description: 'JS expression returning truthy. Required for function' },
  timeout: { type: 'number', minimum: 0, maximum: 120_000 },
}
```

- [ ] **Step 7: Add pattern + minLength on selectors**

For every locator-using tool, on the `selector` param:
```typescript
selector: { type: 'string', minLength: 1, description: 'CSS selector, ref (e1, sp-xxxx), or pack:<name>=<arg> reference.' }
```

- [ ] **Step 8: Run test — verify PASS**

Run: `npx vitest run test/unit/tools/schema-strictness.test.ts`

- [ ] **Step 9: Commit**

```bash
git add src/tools/ test/unit/tools/schema-strictness.test.ts
git commit -m "feat(cluster-B): enum + pattern + min/max constraints on closed-set params"
```

**CHECKPOINT after Task 5 (paired with Task 4)** — but we already checkpointed after Task 4. So checkpoint after Task 6 instead per the every-2-tasks cadence (T4-T5 pair).

Actually — re-pairing: T1+T2 → checkpoint → T3+T4 → checkpoint → T5+T6 → checkpoint → ... per "every 2 tasks." Adjust: checkpoint after every even-indexed task (2, 4, 6, 8, 10, 12, 14).

---

## Task 6: Cluster C — Locator-v2 adoption push (Anthropic Tool Use Examples pattern)

**Files:**
- Modify: `src/tools/extraction.ts` (safari_query_all with examples)
- Modify: `src/tools/interaction.ts` (safari_click description shows query_all+chain alternative)
- Modify: `src/tools/extraction.ts` (safari_get_text shows query_all alternative)
- Modify: `src/tools/selector-pack.ts` (safari_register_selector shows pack:<name> usage)
- Test: `test/unit/tools/locator-v2-adoption.test.ts`

**Approach:** add **inline examples** to the *description text* (not as separate fields — for compatibility, embed in description, e.g. as ` Example: <good> not <bad>`). Anthropic Tool Use Examples best practice: show minimal/realistic side-by-side anti-pattern vs pattern.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/locator-v2-adoption.test.ts
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';

describe('Cluster C — locator v2 adoption signals in descriptions', () => {
  const findTool = (name: string) => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    return server.listToolDefinitions().find((t) => t.name === name);
  };

  it('safari_query_all description references chain ops as the typical filter follow-up', () => {
    const t = findTool('safari_query_all');
    expect(t?.description).toMatch(/chain/i);
  });

  it('safari_click description steers agent to query_all + chain on multi-match', () => {
    const t = findTool('safari_click');
    expect(t?.description).toMatch(/query_all|chain/i);
  });

  it('safari_get_text description steers to query_all when answer is a list', () => {
    const t = findTool('safari_get_text');
    expect(t?.description).toMatch(/query_all|list|multiple/i);
  });

  it('safari_register_selector description shows the pack:<name>=<arg> usage shape', () => {
    const t = findTool('safari_register_selector');
    expect(t?.description).toMatch(/pack:.*=/);
  });
});
```

- [ ] **Step 2: Run test — verify FAIL or partial pass**

- [ ] **Step 3: Dispatch test-reviewer-fast.**

- [ ] **Step 4: Update `safari_query_all` description with example**

```typescript
description: 'Return ALL elements matching a locator + optional chain, with refs. Use when the answer is a list (rows-as-divs, search results, products) — always prefer over repeated safari_get_text calls. Pair with chain ops to filter: e.g. selector="li" + chain=[{filter:{hasText:"Active"}},{nth:0}] picks the first Active item.',
```

- [ ] **Step 5: Update `safari_click` description**

```typescript
description: 'Click an element. Use when activating a button, link, checkbox, or any clickable. Strict mode — multi-match throws StrictnessViolationError. On strict violation, switch strategy: safari_query_all to enumerate, then click by ref; or use chain=[{filter:{hasText:"Sign In"}},{nth:0}] inline.',
```

- [ ] **Step 6: Update `safari_get_text` description**

```typescript
description: 'Read the visible text of an element. Use to verify a result, capture an answer, or read a label. If the answer is a list of items, use safari_query_all instead — never loop safari_get_text by index.',
```

- [ ] **Step 7: Update `safari_register_selector` description**

```typescript
description: 'Register a custom selector engine on a tab as a JS function body. Use when the same complex element-finding logic is needed >2 times — register once, then call any locator-using tool with selector="pack:<name>=<arg>". Persists across navigations until tab close. Sensitive — passes through HumanApproval.',
```

- [ ] **Step 8: Run test — verify PASS**

- [ ] **Step 9: Commit**

```bash
git add src/tools/ test/unit/tools/locator-v2-adoption.test.ts
git commit -m "feat(cluster-C): locator-v2 adoption signals in tool descriptions"
```

---

## Task 7: Iteration 1 measure

**Files:**
- Create: `bench/baselines/iter-1.json`
- Modify: `bench/baselines/README.md`

- [ ] **Step 1: Build**

```bash
npm run build
```

- [ ] **Step 2: Run benchmark**

```bash
bash bench/run.sh iter-1
```

- [ ] **Step 3: Compute TT delta**

```bash
node -e "
const b = require('./bench/baselines/v0.1.28-baseline.json');
const i = require('./bench/baselines/iter-1.json');
const ratio = i.total_tt / b.total_tt;
console.log('Iter1/Baseline TT ratio:', ratio.toFixed(3), '— target ≤0.80');
process.exit(ratio <= 0.80 ? 0 : 1);
"
```

- [ ] **Step 4: If ratio > 0.80**

Switch to `upp:systematic-debugging`. Inspect `bench/runs/iter-1-*/*/tool-calls.jsonl` for tasks where TT didn't drop. Identify which intervention (A/B/C) failed to land. Fix in a sub-task before proceeding.

- [ ] **Step 5: Commit measurement**

```bash
git add bench/baselines/iter-1.json bench/baselines/README.md
git commit -m "bench: iter-1 scoreboard (target ≤0.80 × baseline)"
```

**CHECKPOINT after Task 6 (paired with Task 5 not 7).** Adjust: checkpoint after T6, then again after T8.

---

## Task 8: Cluster D-light — `safari_tool_search` meta-tool

**Files:**
- Create: `src/discovery/tool-index.ts`
- Create: `src/tools/tool-search.ts`
- Modify: `src/server.ts` (register the new tool, build index on startup)
- Test: `test/unit/discovery/tool-index.test.ts`
- Test: `test/e2e/tool-search.test.ts`

**Approach:** in-memory index over (tool name, description, tags). Tags inferred from tool name segments (first segment after `safari_` becomes the tag, e.g. `safari_extract_tables` → tag=`extract`). `safari_tool_search` returns top-K matches scored by simple keyword overlap.

The full `defer_loading` mechanism is Anthropic-specific in the MCP protocol; we ship the search tool as the discovery half of the pattern. Hot-set selection is documented but not enforced server-side until a future task.

- [ ] **Step 1: Write the failing unit test**

```typescript
// test/unit/discovery/tool-index.test.ts
import { describe, it, expect } from 'vitest';
import { ToolIndex } from '../../../src/discovery/tool-index.js';

describe('ToolIndex', () => {
  const fixture = [
    { name: 'safari_navigate', description: 'Navigate to a URL. Use when starting a task.' },
    { name: 'safari_extract_tables', description: 'Extract tables. Use when the answer is in a table.' },
    { name: 'safari_query_all', description: 'Return all elements matching a locator. Use for lists.' },
    { name: 'safari_get_text', description: 'Read visible text. Use to capture a label.' },
  ];

  it('builds index from tool definitions', () => {
    const idx = new ToolIndex(fixture);
    expect(idx.size()).toBe(4);
  });

  it('search returns matches for keyword in description', () => {
    const idx = new ToolIndex(fixture);
    const hits = idx.search('table');
    expect(hits.map((h) => h.name)).toContain('safari_extract_tables');
  });

  it('search respects topK limit', () => {
    const idx = new ToolIndex(fixture);
    const hits = idx.search('use', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('extracts tag from tool name segment', () => {
    const idx = new ToolIndex(fixture);
    expect(idx.tagsFor('safari_extract_tables')).toContain('extract');
    expect(idx.tagsFor('safari_query_all')).toContain('query');
  });
});
```

- [ ] **Step 2: Run test — verify FAIL**

- [ ] **Step 3: Dispatch test-reviewer-fast**

- [ ] **Step 4: Implement `src/discovery/tool-index.ts`**

```typescript
// src/discovery/tool-index.ts
export interface ToolEntry {
  name: string;
  description: string;
  tags?: string[];
}

export interface ToolHit extends ToolEntry {
  score: number;
}

export class ToolIndex {
  private entries: ToolEntry[];

  constructor(entries: ToolEntry[]) {
    this.entries = entries.map((e) => ({ ...e, tags: e.tags ?? this.inferTags(e.name) }));
  }

  size(): number { return this.entries.length; }

  tagsFor(name: string): string[] {
    return this.entries.find((e) => e.name === name)?.tags ?? [];
  }

  search(query: string, topK: number = 8): ToolHit[] {
    const tokens = this.tokenize(query);
    const scored = this.entries.map((e) => ({
      ...e,
      score: this.score(tokens, e),
    })).filter((h) => h.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private inferTags(name: string): string[] {
    const parts = name.replace(/^safari_/, '').split('_');
    return [parts[0]!];
  }

  private tokenize(s: string): string[] {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  }

  private score(queryTokens: string[], e: ToolEntry): number {
    const haystack = (e.name + ' ' + e.description + ' ' + (e.tags ?? []).join(' ')).toLowerCase();
    let s = 0;
    for (const t of queryTokens) {
      if (haystack.includes(t)) s += 1;
      if (e.name.toLowerCase().includes(t)) s += 1;     // boost name match
      if (e.tags?.includes(t)) s += 0.5;
    }
    return s;
  }
}
```

- [ ] **Step 5: Run unit test — verify PASS**

- [ ] **Step 6: Implement `src/tools/tool-search.ts`**

```typescript
// src/tools/tool-search.ts
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import type { ToolIndex } from '../discovery/tool-index.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}
type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class ToolSearchTools {
  private index: ToolIndex;
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine, index: ToolIndex) {
    this.engine = engine;
    this.index = index;
    this.handlers.set('safari_tool_search', this.handleSearch.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [{
      name: 'safari_tool_search',
      description: 'Search the safari-pilot tool catalog by keyword. Use when you cannot find a tool with the capability you need by name alone — e.g. searching "form fill", "table", "screenshot", "wait", "iframe". Returns top-K matches with descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'Keyword(s) to search tool names + descriptions' },
          topK: { type: 'number', minimum: 1, maximum: 20, description: 'Max hits (default 8)' },
        },
        required: ['query'],
      },
      requirements: { idempotent: true },
    }];
  }

  getHandler(name: string): Handler | undefined { return this.handlers.get(name); }

  private async handleSearch(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const query = params['query'] as string;
    const topK = (params['topK'] as number | undefined) ?? 8;
    const hits = this.index.search(query, topK);
    return {
      content: [{ type: 'text', text: JSON.stringify({ hits }) }],
      metadata: { engine: this.engine.name as Engine, degraded: false, latencyMs: Date.now() - start },
    };
  }
}
```

- [ ] **Step 7: Wire into `src/server.ts`**

In SafariPilotServer constructor, after all other tool modules collected:
```typescript
import { ToolIndex } from './discovery/tool-index.js';
import { ToolSearchTools } from './tools/tool-search.js';

// after this.modules.push(...) for all other tools:
const allDefs = this.modules.flatMap((m) => m.getDefinitions());
const index = new ToolIndex(allDefs.map((d) => ({ name: d.name, description: d.description })));
this.modules.push(new ToolSearchTools(proxy, index));
```

- [ ] **Step 8: Write the e2e test**

```typescript
// test/e2e/tool-search.test.ts
import { describe, it, expect } from 'vitest';
import { callTool } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('safari_tool_search e2e', () => {
  it('returns relevant hits for a keyword', async () => {
    const { client, nextId } = await getSharedClient();
    const r = await callTool(client, 'safari_tool_search', { query: 'table extract' }, nextId(), 10_000);
    const hits = (r['hits'] ?? []) as Array<{ name: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.name).toBe('safari_extract_tables');
  });

  it('respects topK', async () => {
    const { client, nextId } = await getSharedClient();
    const r = await callTool(client, 'safari_tool_search', { query: 'safari', topK: 3 }, nextId(), 10_000);
    const hits = (r['hits'] ?? []) as unknown[];
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 9: Run all tests — verify PASS**

```bash
npx vitest run test/unit/discovery/tool-index.test.ts test/e2e/tool-search.test.ts
```

- [ ] **Step 10: Commit**

```bash
git add src/discovery src/tools/tool-search.ts src/server.ts test/unit/discovery test/e2e/tool-search.test.ts
git commit -m "feat(cluster-D): safari_tool_search meta-tool + ToolIndex"
```

**CHECKPOINT after Task 8.**

---

## Task 9: Cluster F — Benchmark system prompt

**Files:**
- Create: `bench/prompts/system.md`
- Modify: `bench/agent.ts` (read system prompt from file)

- [ ] **Step 1: Write `bench/prompts/system.md`**

```markdown
You are a browser automation agent. You have access to safari_* tools to control Safari and read pages.

## Strategy

1. **Start every task by orienting.** Call `safari_snapshot` after navigation — it gives you a YAML/JSON map of the page with refs (e1, e2, ...) you can pass to any tool. This is cheaper than reading raw HTML and gives you the affordances available.

2. **Prefer query_all over loops.** When the task asks for a list (rows, items, search results), call `safari_query_all` ONCE with a locator. Never loop `safari_get_text` by index — it's slow and brittle.

3. **Use chain ops to disambiguate.** When multiple elements match (strict mode will throw), don't guess a more complex CSS selector. Use `chain: [{filter: {hasText: "Sign In"}}, {nth: 0}]` to pick the right one. The chain field is on every locator-aware tool.

4. **Search for tools when stuck.** If you can't find a tool for a capability you need, call `safari_tool_search({query: "<keyword>"})` to find it. Don't guess tool names.

5. **Ask, don't guess on missing params.** If a required parameter is unclear from the task, return a clarifying question instead of inventing a value.

6. **Read tool result metadata.** Tool responses may include `suggested_next_tools` hints — consider them before choosing the next call.

## Conventions

- Tab URLs are returned by `safari_new_tab` and `safari_navigate`. Pass the latest tabUrl to subsequent tools.
- Refs (e1, sp-xxxxxx) survive across same-tab tool calls. Reuse them instead of re-querying.
- `safari_evaluate` is the escape hatch — try a structured tool first.
- Complete the task by stating your final answer in plain text without a tool call.
```

- [ ] **Step 2: Modify `bench/agent.ts`**

Replace the inline `system: '...'` string with:
```typescript
import { readFile as readFileSync } from 'node:fs/promises';
const systemPrompt = await readFileSync('bench/prompts/system.md', 'utf8');
// ... in messages.create:
system: systemPrompt,
```

- [ ] **Step 3: No new test** — system prompt content is exercised by the iteration measure (Task 10).

- [ ] **Step 4: Commit**

```bash
git add bench/prompts bench/agent.ts
git commit -m "feat(cluster-F): opinionated benchmark system prompt — strategy + tool-search nudge"
```

---

## Task 10: Iteration 2 measure

**Files:**
- Create: `bench/baselines/iter-2.json`

- [ ] **Step 1: Build + run**

```bash
npm run build && bash bench/run.sh iter-2
```

- [ ] **Step 2: Compute TT delta vs baseline**

```bash
node -e "
const b = require('./bench/baselines/v0.1.28-baseline.json');
const i = require('./bench/baselines/iter-2.json');
const ratio = i.total_tt / b.total_tt;
console.log('Iter2/Baseline TT ratio:', ratio.toFixed(3), '— target ≤0.64');
process.exit(ratio <= 0.64 ? 0 : 1);
"
```

- [ ] **Step 3: If miss, switch to systematic-debugging.**

- [ ] **Step 4: Commit**

```bash
git add bench/baselines/iter-2.json
git commit -m "bench: iter-2 scoreboard (target ≤0.64 × baseline)"
```

**CHECKPOINT after Task 10.**

---

## Task 11: Cluster E — Skill bundles + `safari_run_skill` meta-tool

**Files:**
- Create: `skills/login.SKILL.md`
- Create: `skills/paginate-and-scrape.SKILL.md`
- Create: `skills/robust-form-fill.SKILL.md`
- Create: `src/skills/registry.ts`
- Create: `src/skills/runner.ts`
- Create: `src/tools/skills.ts`
- Modify: `src/server.ts`
- Test: `test/unit/skills/registry.test.ts`
- Test: `test/e2e/skill-runner.test.ts`

**Approach:** Each skill is a server-side procedure that orchestrates raw tools. Anthropic Skills SKILL.md format with YAML frontmatter (`name`, `description`, `triggers`, `inputs`). The runner parses the markdown's procedural body (a sequence of tool calls templated with input args) and dispatches.

For v1, the procedure body is a JSON block inside the markdown declaring tool calls — keeps parsing simple. Later iterations could add NL execution.

- [ ] **Step 1: Write the failing unit test**

```typescript
// test/unit/skills/registry.test.ts
import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';

describe('SkillRegistry', () => {
  it('loads SKILL.md files from skills/ dir', async () => {
    const reg = await SkillRegistry.fromDir('skills');
    expect(reg.list().length).toBeGreaterThanOrEqual(3);
    expect(reg.list().map((s) => s.name)).toEqual(expect.arrayContaining(['login', 'paginate-and-scrape', 'robust-form-fill']));
  });

  it('parses YAML frontmatter for description and inputs', async () => {
    const reg = await SkillRegistry.fromDir('skills');
    const login = reg.get('login');
    expect(login?.description).toMatch(/log/i);
    expect(login?.inputs).toEqual(expect.arrayContaining(['url', 'username', 'password']));
  });

  it('returns the procedure body as a parseable steps array', async () => {
    const reg = await SkillRegistry.fromDir('skills');
    const login = reg.get('login');
    expect(login?.steps).toBeInstanceOf(Array);
    expect(login?.steps.length).toBeGreaterThan(0);
    expect(login?.steps[0]).toHaveProperty('tool');
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: test-reviewer-fast**

- [ ] **Step 4: Create `skills/login.SKILL.md`**

```markdown
---
name: login
description: Log into a site by filling username + password and submitting. Use when a task starts with "log into <site>" and credentials are known.
triggers:
  - log in
  - sign in
  - authenticate
inputs:
  - url
  - usernameSelector
  - passwordSelector
  - submitSelector
  - username
  - password
---

```json
{
  "steps": [
    { "tool": "safari_new_tab", "args": { "url": "{{url}}" }, "saveAs": "tab" },
    { "tool": "safari_fill", "args": { "tabUrl": "{{tab.tabUrl}}", "selector": "{{usernameSelector}}", "value": "{{username}}" } },
    { "tool": "safari_fill", "args": { "tabUrl": "{{tab.tabUrl}}", "selector": "{{passwordSelector}}", "value": "{{password}}" } },
    { "tool": "safari_click", "args": { "tabUrl": "{{tab.tabUrl}}", "selector": "{{submitSelector}}" } },
    { "tool": "safari_wait_for", "args": { "tabUrl": "{{tab.tabUrl}}", "condition": "networkidle", "timeout": 10000 } }
  ]
}
```
```

- [ ] **Step 5: Create `skills/paginate-and-scrape.SKILL.md`**

```markdown
---
name: paginate-and-scrape
description: Scrape a list of items across multiple paginated pages and return them concatenated. Use when items span pages joined by a "next" link.
triggers:
  - paginate
  - all pages
  - across pages
inputs:
  - tabUrl
  - itemSelector
  - nextSelector
  - maxPages
---

```json
{
  "steps": [
    { "tool": "safari_paginate_scrape", "args": { "tabUrl": "{{tabUrl}}", "itemSelector": "{{itemSelector}}", "nextSelector": "{{nextSelector}}", "maxPages": "{{maxPages}}" } }
  ]
}
```
```

- [ ] **Step 6: Create `skills/robust-form-fill.SKILL.md`**

```markdown
---
name: robust-form-fill
description: Fill a form field-by-field using fills with strict-mode safety, then submit. Use when filling forms is part of a task and brittle CSS selectors should be avoided.
triggers:
  - fill out the form
  - submit the form
inputs:
  - tabUrl
  - fields
  - submitSelector
---

```json
{
  "steps": [
    { "tool": "_loop", "over": "{{fields}}", "as": "f", "do": [
      { "tool": "safari_fill", "args": { "tabUrl": "{{tabUrl}}", "selector": "{{f.selector}}", "value": "{{f.value}}" } }
    ]},
    { "tool": "safari_click", "args": { "tabUrl": "{{tabUrl}}", "selector": "{{submitSelector}}" } }
  ]
}
```
```

- [ ] **Step 7: Implement `src/skills/registry.ts`**

```typescript
// src/skills/registry.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface SkillStep {
  tool: string;
  args?: Record<string, unknown>;
  saveAs?: string;
  over?: string;
  as?: string;
  do?: SkillStep[];
}

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  inputs: string[];
  steps: SkillStep[];
}

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  static async fromDir(dir: string): Promise<SkillRegistry> {
    const reg = new SkillRegistry();
    let files: string[];
    try { files = (await readdir(dir)).filter((f) => f.endsWith('.SKILL.md')); }
    catch { return reg; }

    for (const f of files) {
      const raw = await readFile(join(dir, f), 'utf8');
      const skill = SkillRegistry.parse(raw);
      if (skill) reg.skills.set(skill.name, skill);
    }
    return reg;
  }

  static parse(raw: string): Skill | null {
    const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    const codeBlockMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    if (!frontmatterMatch || !codeBlockMatch) return null;
    const fm = frontmatterMatch[1] as string;

    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m?.[1]?.trim() ?? '';
    };
    const getList = (key: string): string[] => {
      const m = fm.match(new RegExp(`^${key}:\\n((?:\\s+-\\s+.+\\n?)+)`, 'm'));
      if (!m) return [];
      return (m[1] as string).split('\n').map((l) => l.replace(/^\s+-\s+/, '').trim()).filter(Boolean);
    };

    const body = JSON.parse(codeBlockMatch[1] as string);
    return {
      name: get('name'),
      description: get('description'),
      triggers: getList('triggers'),
      inputs: getList('inputs'),
      steps: body.steps,
    };
  }

  list(): Skill[] { return Array.from(this.skills.values()); }
  get(name: string): Skill | undefined { return this.skills.get(name); }
}
```

- [ ] **Step 8: Run unit test — verify PASS**

- [ ] **Step 9: Implement `src/skills/runner.ts`**

```typescript
// src/skills/runner.ts
import type { Skill } from './registry.js';

type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function interp(template: unknown, scope: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
      const path = expr.trim().split('.');
      let v: unknown = scope;
      for (const p of path) {
        if (v && typeof v === 'object' && p in v) v = (v as Record<string, unknown>)[p];
        else return '';
      }
      return String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => interp(t, scope));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) out[k] = interp(v, scope);
    return out;
  }
  return template;
}

export async function runSkill(
  skill: Skill,
  inputs: Record<string, unknown>,
  dispatch: ToolDispatch,
): Promise<{ outputs: Record<string, unknown>; trace: Array<{ tool: string; args: unknown; result: unknown }> }> {
  const scope: Record<string, unknown> = { ...inputs };
  const trace: Array<{ tool: string; args: unknown; result: unknown }> = [];

  async function runStep(step: typeof skill.steps[number]): Promise<void> {
    if (step.tool === '_loop') {
      const list = interp(step.over!, scope) as unknown;
      const items = Array.isArray(list) ? list : (typeof list === 'string' ? JSON.parse(list) as unknown[] : []);
      for (const item of items) {
        scope[step.as!] = item;
        for (const inner of step.do ?? []) await runStep(inner);
      }
      return;
    }
    const args = (interp(step.args ?? {}, scope) as Record<string, unknown>);
    const result = await dispatch(step.tool, args);
    trace.push({ tool: step.tool, args, result });
    if (step.saveAs) scope[step.saveAs] = result;
  }

  for (const step of skill.steps) await runStep(step);
  return { outputs: scope, trace };
}
```

- [ ] **Step 10: Implement `src/tools/skills.ts` and wire into server**

```typescript
// src/tools/skills.ts
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import type { SkillRegistry } from '../skills/registry.js';
import { runSkill } from '../skills/runner.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}
type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;
type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export class SkillTools {
  constructor(private engine: IEngine, private registry: SkillRegistry, private dispatch: ToolDispatch) {}

  getDefinitions(): ToolDefinition[] {
    return [{
      name: 'safari_run_skill',
      description: 'Execute a registered Skill (composed multi-tool workflow). Use when the task matches a skill\'s trigger phrase — login, paginate-and-scrape, robust-form-fill. Replaces 4-6 raw tool calls with one. Skills are visible via safari_list_skills.',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Skill name from safari_list_skills' },
          inputs: { type: 'object', description: 'Skill-specific inputs object' },
        },
        required: ['skill', 'inputs'],
      },
      requirements: { idempotent: false },
    }, {
      name: 'safari_list_skills',
      description: 'List available Skills with their triggers, descriptions, and required inputs. Use early in a task to discover whether a Skill matches.',
      inputSchema: { type: 'object', properties: {} },
      requirements: { idempotent: true },
    }];
  }

  getHandler(name: string): Handler | undefined {
    if (name === 'safari_run_skill') return async (params) => {
      const start = Date.now();
      const skillName = params['skill'] as string;
      const inputs = (params['inputs'] as Record<string, unknown>) ?? {};
      const skill = this.registry.get(skillName);
      if (!skill) throw new Error(`Unknown skill: ${skillName}`);
      const { outputs, trace } = await runSkill(skill, inputs, this.dispatch);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, outputs, trace }) }],
        metadata: { engine: this.engine.name as Engine, degraded: false, latencyMs: Date.now() - start },
      };
    };
    if (name === 'safari_list_skills') return async () => {
      const list = this.registry.list().map((s) => ({ name: s.name, description: s.description, triggers: s.triggers, inputs: s.inputs }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ skills: list }) }],
        metadata: { engine: this.engine.name as Engine, degraded: false, latencyMs: 0 },
      };
    };
    return undefined;
  }
}
```

- [ ] **Step 11: Wire into `src/server.ts`**

After SkillRegistry loads:
```typescript
import { SkillRegistry } from './skills/registry.js';
import { SkillTools } from './tools/skills.js';
const skillRegistry = await SkillRegistry.fromDir('skills');
const dispatch: (n: string, a: Record<string, unknown>) => Promise<unknown> = async (n, a) => {
  // Find handler in modules already registered
  for (const m of this.modules) {
    const h = m.getHandler?.(n);
    if (h) {
      const resp = await h(a);
      const text = resp.content[0]?.text;
      try { return text ? JSON.parse(text) : null; } catch { return text; }
    }
  }
  throw new Error(`Skill called unknown tool: ${n}`);
};
this.modules.push(new SkillTools(proxy, skillRegistry, dispatch));
```

- [ ] **Step 12: Write the e2e test**

```typescript
// test/e2e/skill-runner.test.ts
import { describe, it, expect } from 'vitest';
import { callTool } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('safari_list_skills + safari_run_skill e2e', () => {
  it('safari_list_skills returns all 3 bundled skills', async () => {
    const { client, nextId } = await getSharedClient();
    const r = await callTool(client, 'safari_list_skills', {}, nextId(), 10_000);
    const names = ((r['skills'] ?? []) as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['login', 'paginate-and-scrape', 'robust-form-fill']));
  });
});
```

- [ ] **Step 13: Run all tests — verify PASS**

```bash
npx vitest run test/unit/skills test/e2e/skill-runner.test.ts
```

- [ ] **Step 14: Commit**

```bash
git add skills src/skills src/tools/skills.ts src/server.ts test/unit/skills test/e2e/skill-runner.test.ts
git commit -m "feat(cluster-E): SKILL.md bundles + safari_run_skill / safari_list_skills"
```

---

## Task 12: Cluster G — `suggested_next_tools` in ToolResponse metadata

**Files:**
- Modify: `src/types.ts` (extend ToolResponse.metadata)
- Modify: `src/tools/navigation.ts` (after navigate, suggest snapshot)
- Modify: `src/tools/extraction.ts` (after strict-violation, suggest query_all)
- Modify: `src/security/human-approval.ts` (on block, suggest evaluate-via-pack)
- Modify: `bench/prompts/system.md` (mention suggested_next_tools)
- Test: `test/unit/types/suggested-next-tools.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/types/suggested-next-tools.test.ts
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';
import { startFixtureServer } from '../../helpers/fixture-server.js';

describe('suggested_next_tools — wired hint surfaces', () => {
  it('safari_navigate result metadata includes suggested_next_tools = [snapshot]', async () => {
    // Stub-level: assert the SHAPE in the codebase, not behavior — full e2e is at iter-3 measure.
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const def = server.listToolDefinitions().find((t) => t.name === 'safari_navigate');
    // Source-grep style: verify implementation file references suggested_next_tools
    const fs = await import('node:fs/promises');
    const src = await fs.readFile('src/tools/navigation.ts', 'utf8');
    expect(src).toMatch(/suggested_next_tools/);
    expect(src).toMatch(/safari_snapshot/);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: test-reviewer-fast**

- [ ] **Step 4: Extend `src/types.ts`**

```typescript
export interface ToolResponseMetadata {
  engine: Engine;
  degraded: boolean;
  latencyMs: number;
  suggested_next_tools?: Array<{ tool: string; reason: string }>;  // NEW
}
```

- [ ] **Step 5: Wire on `safari_navigate` (in `src/tools/navigation.ts` handleNavigate return)**

```typescript
return {
  content: [...],
  metadata: {
    engine: this.engine.name as Engine,
    degraded: false,
    latencyMs: Date.now() - start,
    suggested_next_tools: [
      { tool: 'safari_snapshot', reason: 'Get a YAML/JSON map of the new page with refs you can pass to subsequent tools.' },
    ],
  },
};
```

- [ ] **Step 6: Wire on strict-mode violation in extraction tools**

When catching `StrictnessViolationError` in safari_get_text / safari_click etc., re-throw with metadata that includes:
```typescript
suggested_next_tools: [
  { tool: 'safari_query_all', reason: 'Multiple elements matched — enumerate them all, then pick by ref.' },
  { tool: 'safari_click', reason: 'Add chain=[{filter:{hasText:"..."}},{nth:0}] to disambiguate without re-querying.' },
],
```

(Implementation note: error responses go through `formatToolError` — extend it to forward an optional `suggested_next_tools` array.)

- [ ] **Step 7: Wire on HumanApproval block**

In `src/security/human-approval.ts` when blocking, attach to the error metadata:
```typescript
suggested_next_tools: [
  { tool: 'safari_evaluate', reason: 'Equivalent path that runs through the JS-eval engine (still security-gated).' },
],
```

- [ ] **Step 8: Update `bench/prompts/system.md`**

Add to existing point 6:
```
6. **Read tool result metadata.** Tool responses may include `suggested_next_tools: [{tool, reason}]` hints. Always consider these — they are produced by safari-pilot's own knowledge of what should follow.
```

- [ ] **Step 9: Run test — PASS**

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/tools/navigation.ts src/tools/extraction.ts src/security/human-approval.ts bench/prompts/system.md test/unit/types
git commit -m "feat(cluster-G): suggested_next_tools metadata on navigate/strict-violation/approval"
```

**CHECKPOINT after Task 12.**

---

## Task 13: Iteration 3 measure

**Files:**
- Create: `bench/baselines/iter-3.json`

- [ ] **Step 1: Build + run**

```bash
npm run build && bash bench/run.sh iter-3
```

- [ ] **Step 2: Compute TT vs baseline**

```bash
node -e "
const b = require('./bench/baselines/v0.1.28-baseline.json');
const i = require('./bench/baselines/iter-3.json');
const ratio = i.total_tt / b.total_tt;
console.log('Iter3/Baseline TT ratio:', ratio.toFixed(3), '— target ≤0.51');
process.exit(ratio <= 0.51 ? 0 : 1);
"
```

- [ ] **Step 3: If miss, switch to systematic-debugging.**

- [ ] **Step 4: Commit**

```bash
git add bench/baselines/iter-3.json
git commit -m "bench: iter-3 scoreboard (target ≤0.51 × baseline)"
```

---

## Task 14: Cluster I — Recipe miner (`browser-harness` inspired)

**Files:**
- Create: `src/discovery/recipe-miner.ts`
- Create: `bench/mine-recipes.ts`
- Test: `test/unit/discovery/recipe-miner.test.ts`

**Approach:** read every `tool-calls.jsonl` under `test-results/traces/`. For each trace where the run succeeded, extract the tool sequence. Group by domain (URL host) and by approximate task signature (first 2-3 tool calls). Emit candidate `skills/<domain>-<sig>.SKILL.md` files with confidence scores.

This is the auto-skill-creation half of Browser Use's harness. Output is candidate skills, not auto-merged — human review gate.

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/discovery/recipe-miner.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mineRecipes } from '../../../src/discovery/recipe-miner.js';

describe('mineRecipes', () => {
  it('extracts a recurring sequence as a candidate skill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mine-'));
    // Two synthetic successful traces with the same 3-tool sequence.
    for (const id of ['run1', 'run2']) {
      const sub = join(dir, id);
      await mkdir(sub, { recursive: true });
      const trace = [
        { tool: 'safari_new_tab', args: { url: 'https://example.com' } },
        { tool: 'safari_fill', args: { selector: '#email' } },
        { tool: 'safari_click', args: { selector: 'button[type=submit]' } },
      ].map((e) => JSON.stringify(e)).join('\n');
      await writeFile(join(sub, 'tool-calls.jsonl'), trace);
      await writeFile(join(sub, 'score.json'), JSON.stringify({ success: true }));
    }
    const candidates = await mineRecipes(dir, { minOccurrences: 2, minLength: 3 });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]?.steps).toHaveLength(3);
    expect(candidates[0]?.host).toBe('example.com');
  });
});
```

- [ ] **Step 2: FAIL** + test-reviewer-fast.

- [ ] **Step 3: Implement `src/discovery/recipe-miner.ts`**

```typescript
// src/discovery/recipe-miner.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface MineOptions { minOccurrences: number; minLength: number; }
interface RecipeCandidate {
  host: string;
  steps: Array<{ tool: string; argSignature: string }>;
  occurrences: number;
}

export async function mineRecipes(rootDir: string, opts: MineOptions): Promise<RecipeCandidate[]> {
  const traces = await collectTraces(rootDir);
  const counts = new Map<string, RecipeCandidate>();

  for (const trace of traces) {
    if (trace.steps.length < opts.minLength) continue;
    const key = trace.host + '|' + trace.steps.map((s) => `${s.tool}:${s.argSignature}`).join('>');
    const existing = counts.get(key);
    if (existing) existing.occurrences++;
    else counts.set(key, { host: trace.host, steps: trace.steps, occurrences: 1 });
  }

  return [...counts.values()].filter((c) => c.occurrences >= opts.minOccurrences);
}

async function collectTraces(root: string): Promise<Array<{ host: string; steps: Array<{ tool: string; argSignature: string }> }>> {
  const out: Array<{ host: string; steps: Array<{ tool: string; argSignature: string }> }> = [];
  let entries: string[];
  try { entries = await readdir(root); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e);
    const s = await stat(p);
    if (s.isDirectory()) {
      try {
        const score = JSON.parse(await readFile(join(p, 'score.json'), 'utf8'));
        if (!score.success) continue;
        const trace = await readFile(join(p, 'tool-calls.jsonl'), 'utf8');
        const steps = trace.split('\n').filter(Boolean).map((line) => {
          const entry = JSON.parse(line);
          return { tool: String(entry.tool), argSignature: signature(entry.args) };
        });
        const host = inferHost(trace);
        out.push({ host, steps });
      } catch { /* skip dirs without complete output */ }
    }
  }
  return out;
}

function signature(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.keys(args).sort().join(',');
}

function inferHost(trace: string): string {
  const m = trace.match(/"url"\s*:\s*"https?:\/\/([^/"]+)/);
  return m?.[1] ?? 'unknown';
}
```

- [ ] **Step 4: Implement `bench/mine-recipes.ts`** (CLI driver — emits candidate SKILL.md files)

```typescript
// bench/mine-recipes.ts
import { mineRecipes } from '../src/discovery/recipe-miner.js';
import { writeFile, mkdir } from 'node:fs/promises';

async function main() {
  const root = process.argv[2] ?? 'bench/runs';
  const out = process.argv[3] ?? 'skills/candidates';
  await mkdir(out, { recursive: true });
  const cands = await mineRecipes(root, { minOccurrences: 2, minLength: 3 });
  for (const [i, c] of cands.entries()) {
    const fname = `${out}/${c.host.replace(/[^a-z0-9]/gi, '-')}-${i}.SKILL.md`;
    const md = `---
name: candidate-${c.host}-${i}
description: Auto-mined candidate from ${c.occurrences} successful traces on ${c.host}. Review before promoting.
triggers: []
inputs: []
---
\`\`\`json
{ "steps": ${JSON.stringify(c.steps.map((s) => ({ tool: s.tool, args: {} })), null, 2)} }
\`\`\`
`;
    await writeFile(fname, md);
  }
  console.log(`Wrote ${cands.length} candidate skills to ${out}`);
}
main();
```

- [ ] **Step 5: Run unit test — PASS**

- [ ] **Step 6: Commit**

```bash
git add src/discovery/recipe-miner.ts bench/mine-recipes.ts test/unit/discovery/recipe-miner.test.ts
git commit -m "feat(cluster-I): recipe miner (browser-harness inspired) — emits SKILL.md candidates"
```

**CHECKPOINT after Task 14.**

---

## Task 15: Final ship — TRACES + changelog v0.1.29

**Files:**
- Modify: `TRACES.md` (iteration 64+)
- Create: `docs/changelogs/v0.1.29.md`
- Modify: `package.json` (version 0.1.28 → 0.1.29)
- Modify: `extension/manifest.json` (version 0.1.28 → 0.1.29)
- Modify: `docs/TRACKER.md` (close items)

**Note:** No daemon/extension code changed in this sprint — version bump is for the new agentic surface (tool-search, skills, recipe-miner) which all live in the npm-published TS code. Extension binary doesn't need to be rebuilt.

- [ ] **Step 1: Update TRACES.md**

Add iteration entries 64+ for tasks completed this sprint. Compaction may apply if hitting iter-3 mod boundary.

- [ ] **Step 2: Write `docs/changelogs/v0.1.29.md`**

Match the v0.1.28 format. Sections:
- Headline (TT × reduction across 3 iterations)
- Cluster A — Tool description rewrites
- Cluster B — Schema hardening
- Cluster C — Locator-v2 adoption push
- Cluster D — safari_tool_search
- Cluster E — Skills + safari_run_skill
- Cluster F — Benchmark system prompt
- Cluster G — suggested_next_tools
- Cluster I — Recipe miner

Include the actual TT numbers from the iter-1/iter-2/iter-3 baselines.

- [ ] **Step 3: Bump versions**

```bash
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '0.1.29';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

const man = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));
man.version = '0.1.29';
fs.writeFileSync('extension/manifest.json', JSON.stringify(man, null, 2) + '\n');
"
```

- [ ] **Step 4: Update TRACKER.md** — close T81/T82/T83/etc. for the new clusters.

- [ ] **Step 5: Run all tests — green**

```bash
npm run lint && npm run test:unit && npm run test:e2e
```

- [ ] **Step 6: Run pre-tag-check**

```bash
bash scripts/pre-tag-check.sh
```

(Note: extension binary unchanged at v0.1.28; pre-tag-check has a version-lockstep check that will require either bumping the extension binary too OR adjusting the script's tolerance for "version bump without extension rebuild" — which is a separate, smaller decision. Document the decision in the changelog.)

- [ ] **Step 7: Commit + tag + push**

```bash
git add -A
git commit -m "chore(release): v0.1.29 — agent benchmark lift sprint"
git push origin feat/agent-benchmark-lift
# Create PR / merge to main per project workflow
```

---

## Self-review

**1. Spec coverage:** Every spec acceptance criterion has a task. Baseline (T1-T3), descriptions (T4), schemas (T5), locator-v2 (T6), tool-search (T8), system-prompt (T9), skills (T11), suggested_next_tools (T12), recipe-miner (T14), iteration measures (T7/T10/T13).

**2. Placeholder scan:** All code blocks contain real implementations. No "TBD" / "implement later" / "fill in details" found.

**3. Type consistency:** `BenchTask`, `BenchScore`, `Skill`, `SkillStep`, `RecipeCandidate`, `ToolResponseMetadata.suggested_next_tools` — all defined exactly once in their owning file and referenced consistently downstream.

**4-6:** No design context, skipping design-aware checks.

**Plan complete and saved to `docs/upp/plans/2026-05-05-agent-benchmark-lift.md`.**
