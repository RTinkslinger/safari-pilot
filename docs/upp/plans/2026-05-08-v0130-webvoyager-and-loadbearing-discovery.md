# v0.1.30: WebVoyager Baseline + Load-Bearing Discovery — Implementation Plan (REVISED)

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish WebVoyager as the canonical Safari Pilot benchmark, baseline v0.1.29 against it, then ship v0.1.30 with a load-bearing dynamic-discovery surface (small default tool list + `safari_tool_search` as the gateway to the long tail) plus an `orient-plan-execute` companion skill, and re-baseline.

**Architecture:** Two layers. (1) **Bench infrastructure**: a WebVoyager adapter that drives each task through `claude -p` (Max subscription); a separate harness call captures the final screenshot via direct MCP after `claude -p` exits (decoupled from agent compliance); WebVoyager's verbatim eval prompt + gpt-4o judge. (2) **Plugin architecture change**: `src/server.ts` filters `tools/list` to a small default surface based on `SAFARI_PILOT_SURFACE` env (`hotset` / `midset` / `full`); long-tail tools stay registered server-side and remain callable by name. Discovery via `safari_tool_search` (already shipped, made load-bearing by hiding the long tail from default `tools/list`). Companion skill `plugin/skills/safari-orient-plan-execute.md` instructs the calling agent. Post-tool hook (Node-based, opt-in) records traces for recipe miner.

**Tech Stack:** TypeScript (existing), bash (driver), Node 20+, `openai` SDK for gpt-4o judge, MinorJerry/WebVoyager dataset verbatim including their eval prompt.

**Cost metric:** `wall_ms` only. Token counts cannot be reliably extracted from `claude -p` output (Max subscription doesn't surface them per-invocation), so the previous `tt = wall_ms × tokens` metric is dropped from all WebVoyager scoring. Fixture suite continues to use `tt` since it uses direct SDK.

**Surface filter location:** server-side (`src/server.ts`'s `tools/list` handler), not client-side. Means one daemon = one surface mode per process. Client-side filtering was considered and rejected because it would require every MCP client to implement filtering; server-side keeps the semantics consistent regardless of client.

---

## Pre-flight (gates the entire plan)

- [ ] **PF-1: Production stack live.**
  Run: `curl -s http://127.0.0.1:19474/status | head -1`. Expected: 200 + status JSON. Run: `bin/SafariPilotd --version`. Expected: a version string. Verify Safari is open and `Safari → Develop → Allow JavaScript from Apple Events` is checked. Verify the v0.1.29 extension is installed and enabled in `Safari → Settings → Extensions`.

- [ ] **PF-2: Verify `claude -p` can reach safari-pilot MCP and execute a tool.**

```bash
claude --dangerously-skip-permissions -p "Call the safari_health_check tool and tell me whether the extension is reported as healthy. End your response with: STATUS: <healthy|unhealthy>"
```

  Expected: response includes `STATUS: healthy` and at least one log line showing the tool was actually invoked. If response is text-only with no MCP tool call, the safari-pilot plugin is not loading in `claude -p` — abort plan and debug `~/.claude/plugins/` and `claude config list` first.

- [ ] **PF-3: Verify OpenAI key.**
  Run: `source ~/.secrets.zsh && echo "${OPENAI_API_KEY:0:10}..."`. Expected: prefix shown. If empty, abort and add via `add-secret env OPENAI_API_KEY <value>`.

- [ ] **PF-4: Create feature branch.**

```bash
git checkout main && git pull && git checkout -b feat/v0130-webvoyager-and-discovery
```

- [ ] **PF-5: Clone WebVoyager dataset, lock SHA, verify ACTUAL paths, extract VERBATIM judge prompt.**

```bash
mkdir -p bench/webvoyager
cd bench/webvoyager
git clone --depth 1 https://github.com/MinorJerry/WebVoyager.git data
cd data && git rev-parse HEAD > ../DATASET_COMMIT && cd ..

# Verify the actual file layout — DO NOT proceed until paths are confirmed.
echo "=== Looking for tasks file ==="
find data -maxdepth 4 -name "*.jsonl" -o -name "*.json" | head -20
echo "=== Looking for eval prompt ==="
find data -maxdepth 4 -type f \( -name "*.py" -o -name "*.txt" -o -name "*.md" \) | xargs grep -l -i "evaluat\|judge\|verdict\|success.*failure" 2>/dev/null | head -5

# Resolve the actual paths (DO NOT GUESS — verify before continuing)
TASKS_PATH=$(find data -maxdepth 4 -name "WebVoyager_data.jsonl" | head -1)
if [[ -z "${TASKS_PATH}" ]]; then
  TASKS_PATH=$(find data -maxdepth 4 -name "*.jsonl" | head -1)
fi
echo "TASKS_PATH=${TASKS_PATH}"
test -f "${TASKS_PATH}" || { echo "ABORT: tasks file not found"; exit 1; }
echo "${TASKS_PATH}" > TASKS_PATH

# Extract the verbatim eval prompt from their auto-eval script
EVAL_SCRIPT=$(find data -maxdepth 4 -name "auto_eval.py" | head -1)
echo "EVAL_SCRIPT=${EVAL_SCRIPT}"
test -f "${EVAL_SCRIPT}" || { echo "ABORT: auto_eval.py not found — investigate WebVoyager repo layout"; exit 1; }

# Copy eval prompt + the model used by upstream into our adapter dir
cp "${EVAL_SCRIPT}" judge-upstream.py

cd ../..
```

  After running this:

  - **Gate PF-5a:** the printed `TASKS_PATH` MUST be a real file on disk. If not, the upstream repo layout has changed; the agent must adjust subsequent tasks (any reference to `bench/webvoyager/data/...`) to use the actual path. Update `bench/webvoyager/TASKS_PATH` so all downstream scripts read from one source of truth.
  - **Gate PF-5b:** `bench/webvoyager/judge-upstream.py` MUST contain a recognizable judge/eval prompt (look for "SUCCESS", "FAILURE", or evaluator instructions). If it doesn't, the upstream eval has been restructured — escalate to user before proceeding to T4.

- [ ] **PF-6: Concurrency capability check (cheap test, prevents 12hr wasted run).**

```bash
# Quick smoke: spawn 8 concurrent claude -p invocations against safari_health_check
# and check the daemon trace timestamps for serialization gaps.
TRACE_BEFORE=$(wc -l < ~/.safari-pilot/daemon-trace.ndjson 2>/dev/null || echo 0)
for i in 1 2 3 4 5 6 7 8; do
  (claude --dangerously-skip-permissions -p "Call safari_health_check, end with PING_${i}" > /tmp/pf6-${i}.log 2>&1) &
done
wait
TRACE_AFTER=$(wc -l < ~/.safari-pilot/daemon-trace.ndjson 2>/dev/null || echo 0)
echo "Daemon trace lines added: $((TRACE_AFTER - TRACE_BEFORE))"
echo "All 8 invocations finished:"
ls /tmp/pf6-*.log | wc -l

# Inspect daemon-trace for inter-command gaps
tail -50 ~/.safari-pilot/daemon-trace.ndjson | jq -r 'select(.event=="dispatched" or .event=="received") | "\(.ts) \(.event) \(.id // .commandId // "")"' | head -30
```

  - **Gate PF-6:** if 8 invocations completed within ~3× the time of 1 invocation, concurrency is healthy → use **CONCURRENCY=8** in run.sh. If the daemon serializes (8 invocations took ~8× the time, or daemon-trace shows long gaps between received and dispatched), set **CONCURRENCY=4** and write the rationale into `bench/webvoyager/CONCURRENCY_DECISION` for future reference.

```bash
# Whichever was decided
echo "8" > bench/webvoyager/CONCURRENCY  # OR echo "4" if serialization detected
```

---

## Phase 1 — WebVoyager Harness Infrastructure

### Task 1: Adapter README + .gitignore

**Files:**
- Create: `bench/webvoyager/README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.gitignore` entry for the cloned dataset.**

```bash
echo "" >> .gitignore
echo "# WebVoyager dataset — externally sourced, see bench/webvoyager/DATASET_COMMIT" >> .gitignore
echo "bench/webvoyager/data/" >> .gitignore
echo "bench/webvoyager/judge-upstream.py" >> .gitignore
```

- [ ] **Step 2: Write `bench/webvoyager/README.md`.**

```markdown
# WebVoyager Adapter

Canonical benchmark for Safari Pilot v0.1.x ship gates.

- **Source:** github.com/MinorJerry/WebVoyager (commit pinned in `DATASET_COMMIT`)
- **Dataset path:** see `TASKS_PATH` (resolved at PF-5)
- **Tasks:** 643 across 15 sites
- **Eval:** gpt-4o judge with WebVoyager-verbatim prompt extracted to `judge-upstream.py`
- **Driver:** `claude -p` per task (Max subscription)
- **Concurrency:** see `CONCURRENCY` (decided at PF-6)
- **Cadence:** dev sample (175 tasks, fixed seed) weekly; full N=3 at ship gates
- **Cost metric:** `wall_ms` (token telemetry not available via claude -p)

Full protocol: `docs/benchmarking.md`.

Run dev sample: `bash bench/webvoyager/run.sh --variant <tag> --sample dev`
Run full ship gate: `bash bench/webvoyager/run.sh --variant <tag> --sample full --runs 3`
```

- [ ] **Step 3: Commit.**

```bash
git add .gitignore bench/webvoyager/DATASET_COMMIT bench/webvoyager/TASKS_PATH bench/webvoyager/CONCURRENCY bench/webvoyager/README.md
git commit -m "chore(bench): vendor WebVoyager dataset reference + adapter README"
```

---

### Task 2: WebVoyager types

**Files:**
- Create: `bench/webvoyager/types.ts`
- Test: `test/unit/webvoyager/types.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
// test/unit/webvoyager/types.test.ts
import { describe, it, expect } from 'vitest';
import type { WebVoyagerTask, WebVoyagerScore, JudgeVerdict } from '../../../bench/webvoyager/types.js';
import { parseWebVoyagerTask } from '../../../bench/webvoyager/types.js';

describe('WebVoyager types', () => {
  it('parses a canonical WebVoyager task line into WebVoyagerTask', () => {
    const raw = JSON.stringify({
      web_name: 'Allrecipes',
      id: 'Allrecipes--12',
      ques: 'Find a vegetarian lasagna recipe with at least 4-star rating.',
      web: 'https://www.allrecipes.com',
    });
    const task: WebVoyagerTask = parseWebVoyagerTask(raw);
    expect(task.id).toBe('Allrecipes--12');
    expect(task.site).toBe('Allrecipes');
    expect(task.url).toBe('https://www.allrecipes.com');
    expect(task.question).toBe('Find a vegetarian lasagna recipe with at least 4-star rating.');
  });

  it('throws on malformed task JSON', () => {
    expect(() => parseWebVoyagerTask('{not json')).toThrow(/parse/i);
    expect(() => parseWebVoyagerTask(JSON.stringify({ id: 'x' }))).toThrow(/missing/i);
  });

  it('JudgeVerdict has the three required values', () => {
    const verdicts: JudgeVerdict[] = ['SUCCESS', 'FAILURE', 'UNKNOWN'];
    expect(verdicts.length).toBe(3);
  });

  it('WebVoyagerScore uses wall_ms as cost metric (no tt)', () => {
    const score: WebVoyagerScore = {
      task_id: 'Allrecipes--12',
      variant: 'v0.1.29',
      verdict: 'SUCCESS',
      judge_reasoning: 'Agent returned a valid recipe URL',
      agent_final_text: 'Found: Classic Vegetarian Lasagna at allrecipes.com/recipe/45323',
      run_seq: 1,
      wall_ms: 18420,
      screenshot_path: '/tmp/wv-Allrecipes--12.png',
    };
    expect(score.wall_ms).toBeGreaterThan(0);
    // Compile-time check: tt should NOT be in the type
    expect('tt' in score).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

Run: `npx vitest run test/unit/webvoyager/types.test.ts --no-coverage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types.**

```typescript
// bench/webvoyager/types.ts

export type JudgeVerdict = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

export interface WebVoyagerTask {
  id: string;            // e.g. "Allrecipes--12"
  site: string;          // e.g. "Allrecipes" (from web_name)
  url: string;           // starting URL (from web)
  question: string;      // user-facing instruction (from ques)
}

export interface WebVoyagerScore {
  task_id: string;
  variant: string;       // e.g. "v0.1.29", "v0.1.30"
  verdict: JudgeVerdict;
  judge_reasoning: string;
  agent_final_text: string;
  run_seq: number;       // 1, 2, 3 for N=3 runs
  wall_ms: number;       // primary cost metric for WebVoyager (token counts not available via claude -p)
  screenshot_path: string;
  failure_reason?: string;
}

interface RawTask {
  web_name?: string;
  id?: string;
  ques?: string;
  web?: string;
}

export function parseWebVoyagerTask(line: string): WebVoyagerTask {
  let raw: RawTask;
  try {
    raw = JSON.parse(line) as RawTask;
  } catch (e) {
    throw new Error(`Failed to parse WebVoyager task line: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw.id || !raw.web_name || !raw.ques || !raw.web) {
    throw new Error(`Missing required fields in task: ${JSON.stringify(raw)}`);
  }
  return {
    id: raw.id,
    site: raw.web_name,
    url: raw.web,
    question: raw.ques,
  };
}
```

- [ ] **Step 4: Run test — verify it passes.**

Run: `npx vitest run test/unit/webvoyager/types.test.ts --no-coverage`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit.**

```bash
git add bench/webvoyager/types.ts test/unit/webvoyager/types.test.ts
git commit -m "feat(webvoyager): types — wall_ms cost metric, no tt field"
```

---

### Task 3: Stratified task sampler

**Files:**
- Create: `bench/webvoyager/sample.ts`
- Test: `test/unit/webvoyager/sample.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
// test/unit/webvoyager/sample.test.ts
import { describe, it, expect } from 'vitest';
import { stratifiedSample, sampleSeed } from '../../../bench/webvoyager/sample.js';
import type { WebVoyagerTask } from '../../../bench/webvoyager/types.js';

const tasks: WebVoyagerTask[] = [];
const sites = ['Allrecipes', 'Amazon', 'Apple'];
for (const site of sites) {
  for (let i = 0; i < 30; i++) {
    tasks.push({ id: `${site}--${i}`, site, url: `https://${site.toLowerCase()}.com`, question: `q${i}` });
  }
}

describe('stratifiedSample', () => {
  it('returns approximately n items, proportionally across sites', () => {
    const sample = stratifiedSample(tasks, 30, sampleSeed('v1'));
    expect(sample.length).toBeGreaterThanOrEqual(28);
    expect(sample.length).toBeLessThanOrEqual(32);
    const counts: Record<string, number> = {};
    for (const t of sample) counts[t.site] = (counts[t.site] ?? 0) + 1;
    expect(Object.keys(counts).length).toBe(3);
    for (const c of Object.values(counts)) {
      expect(c).toBeGreaterThanOrEqual(8);
      expect(c).toBeLessThanOrEqual(12);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = stratifiedSample(tasks, 30, sampleSeed('v1'));
    const b = stratifiedSample(tasks, 30, sampleSeed('v1'));
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('produces different orderings for different seeds', () => {
    const a = stratifiedSample(tasks, 30, sampleSeed('v1'));
    const b = stratifiedSample(tasks, 30, sampleSeed('v2'));
    expect(a.map((t) => t.id)).not.toEqual(b.map((t) => t.id));
  });

  it('handles small sites gracefully (takes all available)', () => {
    const small: WebVoyagerTask[] = [
      { id: 'Big--1', site: 'Big', url: 'x', question: 'x' },
      { id: 'Big--2', site: 'Big', url: 'x', question: 'x' },
      { id: 'Big--3', site: 'Big', url: 'x', question: 'x' },
      { id: 'Tiny--1', site: 'Tiny', url: 'x', question: 'x' },
    ];
    const sample = stratifiedSample(small, 4, sampleSeed('v1'));
    // Tiny only has 1 task; sampler must not crash and must include it
    expect(sample.find((t) => t.site === 'Tiny')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

Run: `npx vitest run test/unit/webvoyager/sample.test.ts --no-coverage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

```typescript
// bench/webvoyager/sample.ts
import type { WebVoyagerTask } from './types.js';

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleSeed(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stratifiedSample(tasks: WebVoyagerTask[], n: number, seed: number): WebVoyagerTask[] {
  const bySite = new Map<string, WebVoyagerTask[]>();
  for (const t of tasks) {
    const arr = bySite.get(t.site) ?? [];
    arr.push(t);
    bySite.set(t.site, arr);
  }

  const sites = [...bySite.keys()].sort();
  const perSite = Math.floor(n / sites.length);
  const remainder = n - perSite * sites.length;

  const rand = mulberry32(seed);
  const result: WebVoyagerTask[] = [];

  for (let s = 0; s < sites.length; s++) {
    const siteTasks = bySite.get(sites[s]!)!.slice();
    for (let i = siteTasks.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [siteTasks[i], siteTasks[j]] = [siteTasks[j]!, siteTasks[i]!];
    }
    const want = perSite + (s < remainder ? 1 : 0);
    const take = Math.min(want, siteTasks.length);  // graceful: small sites take what they have
    result.push(...siteTasks.slice(0, take));
  }

  return result;
}
```

- [ ] **Step 4: Run test — verify it passes.**

Run: `npx vitest run test/unit/webvoyager/sample.test.ts --no-coverage`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit.**

```bash
git add bench/webvoyager/sample.ts test/unit/webvoyager/sample.test.ts
git commit -m "feat(webvoyager): stratified deterministic sampler"
```

---

### Task 4: GPT-4o judge (using VERBATIM WebVoyager prompt)

**Files:**
- Create: `bench/webvoyager/judge.ts`
- Create: `bench/webvoyager/judge-prompt.txt` (extracted from upstream)
- Test: `test/unit/webvoyager/judge.test.ts`
- Test: `test/e2e/webvoyager-judge-real.test.ts`

- [ ] **Step 1: Extract verbatim eval prompt from `bench/webvoyager/judge-upstream.py`.**

Read `bench/webvoyager/judge-upstream.py`. Find the SYSTEM_PROMPT or USER_PROMPT constant used for evaluation. Copy it byte-for-byte into `bench/webvoyager/judge-prompt.txt`. The upstream file has it as a Python string literal — strip the quotes, preserve whitespace, preserve the placeholder for question + answer + screenshot reference.

```bash
cat bench/webvoyager/judge-upstream.py | grep -A 200 "SYSTEM_PROMPT\|EVAL_PROMPT\|prompt = " | head -250
# Identify the prompt block, then manually copy to judge-prompt.txt
```

  - **Gate T4:** before continuing, the contents of `bench/webvoyager/judge-prompt.txt` must be a 1:1 copy of the upstream eval prompt. If the upstream uses placeholders like `{task}` or `{answer}`, our file must use the same placeholders so we can string-replace them at runtime. If the upstream prompt structure is incompatible with single-screenshot input (e.g. they pass screenshot trajectory frames), document the divergence in `bench/webvoyager/JUDGE_DEVIATION.md` and use the closest single-screenshot variant they offer. Do not paraphrase to "make it work."

- [ ] **Step 2: Write the failing test.**

```typescript
// test/unit/webvoyager/judge.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildJudgePrompt, parseJudgeResponse } from '../../../bench/webvoyager/judge.js';

describe('buildJudgePrompt', () => {
  it('uses the verbatim WebVoyager prompt template from judge-prompt.txt', () => {
    const template = readFileSync(join(__dirname, '../../../bench/webvoyager/judge-prompt.txt'), 'utf-8');
    const built = buildJudgePrompt('TaskQ', 'AgentAnswer');
    // Critical assertion: the built prompt must contain the upstream template (post-substitution)
    // We check for a unique substring from the upstream prompt that survives substitution.
    // Since we don't know the exact text, this test asserts the structure: template was used.
    expect(template.length).toBeGreaterThan(100);  // template loaded successfully
    expect(built).toContain('TaskQ');               // task substituted
    expect(built).toContain('AgentAnswer');         // answer substituted
  });
});

describe('parseJudgeResponse', () => {
  it('extracts SUCCESS verdict (case-insensitive)', () => {
    const r = parseJudgeResponse('Reasoning: agent returned valid recipe.\nVerdict: SUCCESS');
    expect(r.verdict).toBe('SUCCESS');
  });

  it('extracts FAILURE verdict', () => {
    const r = parseJudgeResponse('Reasoning: agent gave wrong answer.\nVerdict: FAILURE');
    expect(r.verdict).toBe('FAILURE');
  });

  it('extracts UNKNOWN verdict when judge says NOT SURE / UNKNOWN / ambiguous', () => {
    const r = parseJudgeResponse('Reasoning: ambiguous.\nVerdict: UNKNOWN');
    expect(r.verdict).toBe('UNKNOWN');
  });

  it('falls back to FAILURE (conservative) when no Verdict line present', () => {
    // Conservative fallback: no parsed verdict = treat as failure, not success
    const r = parseJudgeResponse('I think it worked');
    expect(r.verdict).toBe('FAILURE');
  });

  it('handles WebVoyager-style verdict labels (SUCCESS / NOT SUCCESS)', () => {
    // WebVoyager upstream may use "NOT SUCCESS" instead of "FAILURE"
    const r = parseJudgeResponse('The answer is not correct.\nVerdict: NOT SUCCESS');
    expect(r.verdict).toBe('FAILURE');
  });
});
```

- [ ] **Step 3: Run test — verify it fails.**

Run: `npx vitest run test/unit/webvoyager/judge.test.ts --no-coverage`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement.**

```typescript
// bench/webvoyager/judge.ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import type { JudgeVerdict } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedTemplate: string | null = null;
function loadTemplate(): string {
  if (cachedTemplate !== null) return cachedTemplate;
  cachedTemplate = readFileSync(join(__dirname, 'judge-prompt.txt'), 'utf-8');
  return cachedTemplate;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  reasoning: string;
}

/**
 * Builds the eval prompt by substituting the question and agent answer into
 * the WebVoyager-verbatim template. Placeholder names match upstream.
 */
export function buildJudgePrompt(question: string, agentFinalText: string): string {
  let p = loadTemplate();
  // WebVoyager uses {task}/{answer} or similar — adjust here once PF-5 reveals exact placeholders.
  p = p.replace(/\{task\}|\{question\}|\{ques\}/g, question);
  p = p.replace(/\{answer\}|\{agent_answer\}|\{result_response\}/g, agentFinalText);
  // If upstream had no placeholders (rare), we append the substitution context
  if (!p.includes(question)) {
    p = p + `\n\nTask: ${question}\nAgent answer: ${agentFinalText}`;
  }
  return p;
}

export function parseJudgeResponse(text: string): JudgeResult {
  const verdictMatch = text.match(/Verdict\s*:\s*(SUCCESS|FAILURE|UNKNOWN|NOT\s*SUCCESS)/i);
  const reasoningMatch = text.match(/Reasoning\s*:\s*([^\n]+)/i);
  let verdict: JudgeVerdict;
  if (verdictMatch) {
    const raw = verdictMatch[1]!.toUpperCase();
    verdict = raw === 'SUCCESS' ? 'SUCCESS' : raw === 'UNKNOWN' ? 'UNKNOWN' : 'FAILURE';
  } else {
    verdict = 'FAILURE';  // Conservative fallback per engineering review
  }
  const reasoning = reasoningMatch?.[1]?.trim() ?? text.trim().slice(0, 240);
  return { verdict, reasoning };
}

export async function runJudge(
  question: string,
  agentFinalText: string,
  screenshotPath: string,
  client?: OpenAI,
): Promise<JudgeResult> {
  const c = client ?? new OpenAI();
  const imageB64 = readFileSync(screenshotPath).toString('base64');
  const prompt = buildJudgePrompt(question, agentFinalText);
  const response = await c.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '';
  return parseJudgeResponse(text);
}
```

- [ ] **Step 5: Add `openai` dep + run unit tests.**

```bash
npm install --save-dev openai
npx vitest run test/unit/webvoyager/judge.test.ts --no-coverage
```

Expected: PASS, 6 tests.

- [ ] **Step 6: Write a real e2e test that hits the OpenAI API once.**

```typescript
// test/e2e/webvoyager-judge-real.test.ts
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJudge } from '../../bench/webvoyager/judge.js';

describe('runJudge — real OpenAI gpt-4o', () => {
  it('returns a parseable verdict against a trivial known-good case', async () => {
    // Write a tiny 1x1 white PNG (the smallest valid image) to disk
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8ffff3f0005fe02fec3eaaae40000000049454e44ae426082',
      'hex',
    );
    const path = join(tmpdir(), 'wv-judge-smoke.png');
    writeFileSync(path, png);

    const r = await runJudge('What does the user see?', 'A blank white screen', path);
    expect(['SUCCESS', 'FAILURE', 'UNKNOWN']).toContain(r.verdict);
    expect(r.reasoning.length).toBeGreaterThan(0);
  }, 60_000);
});
```

  Run: `npx vitest run test/e2e/webvoyager-judge-real.test.ts --no-coverage`
  Expected: PASS — 1 test, costs ~$0.01 in OpenAI API.

- [ ] **Step 7: Commit.**

```bash
git add bench/webvoyager/judge.ts bench/webvoyager/judge-prompt.txt \
        test/unit/webvoyager/judge.test.ts test/e2e/webvoyager-judge-real.test.ts \
        package.json package-lock.json
git commit -m "feat(webvoyager): gpt-4o judge using verbatim upstream prompt"
```

---

### Task 5: Adapter — drive one task via `claude -p`, post-hoc screenshot capture

**Files:**
- Create: `bench/webvoyager/adapter.ts`
- Create: `bench/webvoyager/mcp-direct.ts` (helper: tiny MCP client to call safari_take_screenshot post-hoc)
- Test: `test/e2e/webvoyager-adapter.test.ts`

- [ ] **Step 1: Write the helper for post-hoc screenshot.**

```typescript
// bench/webvoyager/mcp-direct.ts
// Direct MCP client to call safari_take_screenshot after `claude -p` exits.
// We don't try to receive the agent's last tab; instead we screenshot the FRONTMOST Safari tab,
// which is the agent's tab (because the agent doesn't return until done, and our hook closes
// no tabs in the post-hoc path).
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DIST_INDEX = resolve(REPO_ROOT, 'dist/index.js');

class TinyMcpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor() {
    // Spawn with SAFARI_PILOT_SURFACE=full so safari_take_screenshot is in the default surface
    // even after Phase 3 lands (the screenshot tool is in midset, not hotset).
    this.proc = spawn('node', [DIST_INDEX], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: { ...process.env, SAFARI_PILOT_SURFACE: 'full' },
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg['id'] as number | undefined;
          if (id !== undefined && this.pending.has(id)) {
            this.pending.get(id)!.resolve(msg);
            this.pending.delete(id);
          }
        } catch { /* skip */ }
      }
    });
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout for ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v as Record<string, unknown>); },
        reject,
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init(): Promise<void> {
    await this.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wv-adapter', version: '1.0' } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async takeScreenshotOfActiveTab(path: string): Promise<boolean> {
    try {
      // First, list tabs to find the most-recently-created (the agent's tab)
      const tabsRes = await this.send('tools/call', { name: 'safari_list_tabs', arguments: {} });
      const tabsContent = ((tabsRes['result'] as Record<string, unknown> | undefined)?.['content'] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '[]';
      let activeTabUrl: string | undefined;
      try {
        const parsed = JSON.parse(tabsContent) as Array<{ url?: string; createdByPilot?: boolean }>;
        const owned = parsed.filter((t) => t.createdByPilot);
        activeTabUrl = owned.length > 0 ? owned[owned.length - 1]!.url : parsed[0]?.url;
      } catch { /* fall through */ }
      if (!activeTabUrl) return false;
      await this.send('tools/call', { name: 'safari_take_screenshot', arguments: { tabUrl: activeTabUrl, path } });
      return true;
    } catch {
      return false;
    }
  }

  async closeAllOwnedTabs(): Promise<void> {
    try {
      const tabsRes = await this.send('tools/call', { name: 'safari_list_tabs', arguments: {} });
      const tabsContent = ((tabsRes['result'] as Record<string, unknown> | undefined)?.['content'] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '[]';
      const parsed = JSON.parse(tabsContent) as Array<{ url?: string; createdByPilot?: boolean }>;
      for (const tab of parsed.filter((t) => t.createdByPilot && t.url)) {
        try {
          await this.send('tools/call', { name: 'safari_close_tab', arguments: { tabUrl: tab.url! } });
        } catch { /* best effort */ }
      }
    } catch { /* best effort */ }
  }

  close(): void {
    this.proc.kill('SIGTERM');
  }
}

export async function captureScreenshotPostHoc(path: string): Promise<boolean> {
  const c = new TinyMcpClient();
  try {
    await c.init();
    return await c.takeScreenshotOfActiveTab(path);
  } finally {
    setTimeout(() => c.close(), 500);
  }
}

export async function cleanupOwnedTabs(): Promise<void> {
  const c = new TinyMcpClient();
  try {
    await c.init();
    await c.closeAllOwnedTabs();
  } finally {
    setTimeout(() => c.close(), 500);
  }
}
```

- [ ] **Step 2: Write the failing adapter test.**

```typescript
// test/e2e/webvoyager-adapter.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebVoyagerTask } from '../../bench/webvoyager/adapter.js';
import type { WebVoyagerTask } from '../../bench/webvoyager/types.js';

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'wv-test-'));
});

afterAll(() => {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

describe('WebVoyager adapter — e2e (real claude -p, real Safari, post-hoc screenshot)', () => {
  it('drives a trivial task and returns final text + screenshot path captured by harness', async () => {
    const task: WebVoyagerTask = {
      id: 'TEST--smoke',
      site: 'Test',
      url: 'http://127.0.0.1:18080/bench-smoke',
      question: 'What is the H1 text on this page?',
    };
    const result = await runWebVoyagerTask(task, {
      variant: 'adapter-smoke-test',
      outDir,
      runSeq: 1,
      timeoutMs: 180_000,
    });
    expect(result.task_id).toBe('TEST--smoke');
    expect(result.agent_final_text.length).toBeGreaterThan(0);
    expect(result.screenshot_path).toMatch(/\.png$/);
    expect(existsSync(result.screenshot_path)).toBe(true);
    expect(statSync(result.screenshot_path).size).toBeGreaterThan(1000);
    expect(result.wall_ms).toBeGreaterThan(0);
  }, 240_000);
});
```

- [ ] **Step 3: Run test — verify it fails.**

Run: `npx vitest run test/e2e/webvoyager-adapter.test.ts --no-coverage`
Expected: FAIL — adapter module not found.

- [ ] **Step 4: Implement adapter.**

```typescript
// bench/webvoyager/adapter.ts
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebVoyagerTask } from './types.js';
import { captureScreenshotPostHoc, cleanupOwnedTabs } from './mcp-direct.js';

export interface RunOptions {
  variant: string;
  outDir: string;
  runSeq: number;
  timeoutMs?: number;
}

export interface RawAdapterResult {
  task_id: string;
  agent_final_text: string;
  screenshot_path: string;
  wall_ms: number;
  exit_code: number;
  stderr_tail: string;
}

const FINAL_ANSWER_MARKER = 'FINAL_ANSWER:';

function buildPrompt(task: WebVoyagerTask): string {
  // The harness handles screenshots post-hoc, so we don't burden the agent with screenshot duty.
  return [
    `You are an autonomous browser agent driven by the safari-pilot MCP plugin.`,
    ``,
    `Task: ${task.question}`,
    `Starting URL: ${task.url}`,
    ``,
    `Steps:`,
    `1. Open a new tab to the starting URL using safari_new_tab.`,
    `2. Use safari_snapshot to orient on the page.`,
    `3. Use safari_tool_search if you need a capability not in your default tool list.`,
    `4. Solve the task. Use the simplest tool sequence that works.`,
    `5. End your response with: "${FINAL_ANSWER_MARKER} <your concise answer>"`,
    ``,
    `Do not ask for clarification — make your best attempt and answer.`,
    `Do not switch user-owned tabs. Operate only on tabs you opened.`,
    `Do NOT close your tab — the harness will clean up after evaluation.`,
  ].join('\n');
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function extractFinalAnswer(out: string): string {
  const idx = out.lastIndexOf(FINAL_ANSWER_MARKER);
  if (idx === -1) {
    // Fallback: last 500 chars of stdout (per engineering review)
    return out.slice(-500).trim();
  }
  return out.slice(idx + FINAL_ANSWER_MARKER.length).trim();
}

export async function runWebVoyagerTask(
  task: WebVoyagerTask,
  opts: RunOptions,
): Promise<RawAdapterResult> {
  const screenshotPath = `/tmp/wv-${sanitizeId(task.id)}-r${opts.runSeq}.png`;
  const prompt = buildPrompt(task);
  const startedAt = Date.now();

  let stderrBuf = '';
  let stdoutBuf = '';

  const child = spawn(
    'claude',
    ['--dangerously-skip-permissions', '-p', prompt],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (b: Buffer) => { stdoutBuf += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderrBuf += b.toString(); });

  let timedOut = false;
  const exitCode: number = await new Promise((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, opts.timeoutMs ?? 240_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code ?? -1);
    });
  });

  const wallMs = Date.now() - startedAt;
  const finalText = extractFinalAnswer(stdoutBuf);

  // Persist transcript
  writeFileSync(
    join(opts.outDir, `${sanitizeId(task.id)}-r${opts.runSeq}.transcript.txt`),
    `EXIT=${exitCode}\nTIMED_OUT=${timedOut}\nWALL_MS=${wallMs}\n=== STDOUT ===\n${stdoutBuf}\n=== STDERR ===\n${stderrBuf}`,
  );

  // Post-hoc screenshot capture (independent of agent compliance)
  await captureScreenshotPostHoc(screenshotPath);

  // Always clean up owned tabs (so subsequent tasks start clean)
  await cleanupOwnedTabs();

  return {
    task_id: task.id,
    agent_final_text: finalText,
    screenshot_path: screenshotPath,
    wall_ms: wallMs,
    exit_code: exitCode,
    stderr_tail: stderrBuf.slice(-2000),
  };
}
```

- [ ] **Step 5: Build dist + start fixture + run e2e.**

```bash
npm run build
SAFARI_PILOT_FIXTURE_PORT_HOST=18080 node --import tsx bench/start-fixture.mjs > /tmp/fixture.log 2>&1 &
FIXTURE_PID=$!
sleep 3
npx vitest run test/e2e/webvoyager-adapter.test.ts --no-coverage --testTimeout=300000
kill $FIXTURE_PID
```

Expected: PASS, 1 test. Wall time ~30-90s.

- [ ] **Step 6: Commit.**

```bash
git add bench/webvoyager/adapter.ts bench/webvoyager/mcp-direct.ts test/e2e/webvoyager-adapter.test.ts
git commit -m "feat(webvoyager): adapter with post-hoc screenshot + tab cleanup"
```

---

### Task 6: Score aggregator (FAILURE on ties; per-site median over all runs)

**Files:**
- Create: `bench/webvoyager/score.ts`
- Test: `test/unit/webvoyager/score.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
// test/unit/webvoyager/score.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateScoreboard } from '../../../bench/webvoyager/score.js';
import type { WebVoyagerScore } from '../../../bench/webvoyager/types.js';

function s(taskId: string, verdict: 'SUCCESS' | 'FAILURE' | 'UNKNOWN', wall: number, run = 1): WebVoyagerScore {
  return {
    task_id: taskId, variant: 'v0.1.29', verdict, judge_reasoning: 'r',
    agent_final_text: 'a', run_seq: run, wall_ms: wall, screenshot_path: '/tmp/x.png',
  };
}

describe('aggregateScoreboard', () => {
  it('majority verdict per task — 2 SUCCESS 1 FAILURE → SUCCESS', () => {
    const scores = [s('A--1', 'SUCCESS', 5000, 1), s('A--1', 'SUCCESS', 5500, 2), s('A--1', 'FAILURE', 6000, 3)];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_task['A--1']!.median_verdict).toBe('SUCCESS');
  });

  it('FAILURE on ties (conservative tiebreak)', () => {
    const scores = [s('B--1', 'SUCCESS', 5000, 1), s('B--1', 'FAILURE', 5000, 2)];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_task['B--1']!.median_verdict).toBe('FAILURE');
  });

  it('per-site wall_ms_median computed over ALL runs in that site (not median of medians)', () => {
    const scores = [
      // Site A: 4 runs total — wall values 1000, 2000, 3000, 4000 → true median 2500
      s('A--1', 'SUCCESS', 1000, 1), s('A--1', 'SUCCESS', 4000, 2),
      s('A--2', 'SUCCESS', 2000, 1), s('A--2', 'SUCCESS', 3000, 2),
    ];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_site['A']!.wall_ms_median).toBe(2500);
  });

  it('per-site success_rate uses task-level majority verdict', () => {
    const scores = [
      s('S--1', 'SUCCESS', 1000), s('S--1', 'SUCCESS', 1000),  // task 1: SUCCESS
      s('S--2', 'FAILURE', 1000), s('S--2', 'FAILURE', 1000),  // task 2: FAILURE
    ];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_site['S']!.tasks_total).toBe(2);
    expect(sb.per_site['S']!.tasks_success).toBe(1);
    expect(sb.per_site['S']!.success_rate).toBeCloseTo(0.5);
  });

  it('overall aggregates correctly across sites', () => {
    const scores = [
      s('A--1', 'SUCCESS', 1000), s('B--1', 'FAILURE', 2000),
    ];
    const sb = aggregateScoreboard(scores);
    expect(sb.overall.tasks_total).toBe(2);
    expect(sb.overall.tasks_success).toBe(1);
    expect(sb.overall.success_rate).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

Run: `npx vitest run test/unit/webvoyager/score.test.ts --no-coverage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

```typescript
// bench/webvoyager/score.ts
import type { WebVoyagerScore, JudgeVerdict } from './types.js';

export interface SiteAggregate {
  tasks_total: number;
  tasks_success: number;
  success_rate: number;
  wall_ms_median: number;
}

export interface TaskAggregate {
  task_id: string;
  site: string;
  runs: number;
  successes: number;
  failures: number;
  unknowns: number;
  median_verdict: JudgeVerdict;
  wall_ms_median: number;
}

export interface Scoreboard {
  variant: string;
  generated_at: string;
  overall: SiteAggregate;
  per_site: Record<string, SiteAggregate>;
  per_task: Record<string, TaskAggregate>;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function siteFromTaskId(id: string): string {
  return id.split('--')[0] ?? 'Unknown';
}

/**
 * Conservative tiebreak: if SUCCESS and FAILURE counts are equal, return FAILURE.
 * Per engineering review — optimistic tiebreak inflates scores in noisy regimes.
 */
function majorityVerdict(scores: WebVoyagerScore[]): JudgeVerdict {
  const counts = { SUCCESS: 0, FAILURE: 0, UNKNOWN: 0 };
  for (const s of scores) counts[s.verdict]++;
  if (counts.SUCCESS > counts.FAILURE && counts.SUCCESS > counts.UNKNOWN) return 'SUCCESS';
  if (counts.FAILURE >= counts.SUCCESS && counts.FAILURE >= counts.UNKNOWN) return 'FAILURE';
  return 'UNKNOWN';
}

export function aggregateScoreboard(scores: WebVoyagerScore[]): Scoreboard {
  const variant = scores[0]?.variant ?? 'unknown';
  const byTask = new Map<string, WebVoyagerScore[]>();
  for (const s of scores) {
    const arr = byTask.get(s.task_id) ?? [];
    arr.push(s);
    byTask.set(s.task_id, arr);
  }

  const taskAggs: Record<string, TaskAggregate> = {};
  for (const [id, runs] of byTask) {
    const successes = runs.filter((r) => r.verdict === 'SUCCESS').length;
    const failures = runs.filter((r) => r.verdict === 'FAILURE').length;
    const unknowns = runs.filter((r) => r.verdict === 'UNKNOWN').length;
    taskAggs[id] = {
      task_id: id,
      site: siteFromTaskId(id),
      runs: runs.length,
      successes,
      failures,
      unknowns,
      median_verdict: majorityVerdict(runs),
      wall_ms_median: median(runs.map((r) => r.wall_ms)),
    };
  }

  // Per-site aggregates: success_rate from task-level majority verdict;
  // wall_ms_median from ALL runs in the site (not median of medians).
  const tasksBySite = new Map<string, TaskAggregate[]>();
  const allRunsBySite = new Map<string, number[]>();
  for (const t of Object.values(taskAggs)) {
    const arr = tasksBySite.get(t.site) ?? [];
    arr.push(t);
    tasksBySite.set(t.site, arr);
  }
  for (const s of scores) {
    const site = siteFromTaskId(s.task_id);
    const arr = allRunsBySite.get(site) ?? [];
    arr.push(s.wall_ms);
    allRunsBySite.set(site, arr);
  }

  const perSite: Record<string, SiteAggregate> = {};
  for (const [site, ts] of tasksBySite) {
    const succ = ts.filter((t) => t.median_verdict === 'SUCCESS').length;
    perSite[site] = {
      tasks_total: ts.length,
      tasks_success: succ,
      success_rate: ts.length > 0 ? succ / ts.length : 0,
      wall_ms_median: median(allRunsBySite.get(site) ?? []),
    };
  }

  const allTasks = Object.values(taskAggs);
  const overallSucc = allTasks.filter((t) => t.median_verdict === 'SUCCESS').length;
  const overall: SiteAggregate = {
    tasks_total: allTasks.length,
    tasks_success: overallSucc,
    success_rate: allTasks.length > 0 ? overallSucc / allTasks.length : 0,
    wall_ms_median: median(scores.map((s) => s.wall_ms)),
  };

  return { variant, generated_at: new Date().toISOString(), overall, per_site: perSite, per_task: taskAggs };
}
```

- [ ] **Step 4: Run test — verify it passes.**

Run: `npx vitest run test/unit/webvoyager/score.test.ts --no-coverage`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit.**

```bash
git add bench/webvoyager/score.ts test/unit/webvoyager/score.test.ts
git commit -m "feat(webvoyager): scoreboard — FAILURE on ties; per-site wall_ms_median over all runs"
```

---

### Task 7: Runner with RESUME capability + per-task error isolation

**Files:**
- Create: `bench/webvoyager/runner.ts`
- Test: `test/e2e/webvoyager-runner.test.ts`
- Create: `test/e2e/fixtures/wv-2-tasks.jsonl`

- [ ] **Step 1: Write the fixture file.**

```bash
mkdir -p test/e2e/fixtures
cat > test/e2e/fixtures/wv-2-tasks.jsonl <<'EOF'
{"id":"FIX--smoke","web_name":"FIX","ques":"What is the H1?","web":"http://127.0.0.1:18080/bench-smoke"}
{"id":"FIX--list","web_name":"FIX","ques":"List the items","web":"http://127.0.0.1:18080/bench-list"}
EOF
```

- [ ] **Step 2: Write the failing e2e test (covers RESUME).**

```typescript
// test/e2e/webvoyager-runner.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runDir: string;

beforeAll(() => { runDir = mkdtempSync(join(tmpdir(), 'wv-runner-')); });
afterAll(() => { if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true }); });

describe('WebVoyager runner — e2e', () => {
  it('runs 2 tasks, writes scoreboard.json (with --skip-judge to keep cheap)', () => {
    const r = spawnSync(
      'node',
      [
        '--import', 'tsx',
        'bench/webvoyager/runner.ts',
        '--tasks-file', join(__dirname, 'fixtures/wv-2-tasks.jsonl'),
        '--variant', 'runner-smoke',
        '--out-dir', runDir,
        '--runs', '1',
        '--concurrency', '1',
        '--skip-judge',
      ],
      { stdio: 'pipe', cwd: process.cwd() },
    );
    expect(r.status).toBe(0);
    const sbPath = join(runDir, 'scoreboard.json');
    expect(existsSync(sbPath)).toBe(true);
    const sb = JSON.parse(readFileSync(sbPath, 'utf-8'));
    expect(sb.overall.tasks_total).toBe(2);
  }, 600_000);

  it('RESUMES — pre-existing score.json files are honored, runner skips them', () => {
    // Pre-write a fake score for one task; runner should detect and skip it.
    const fakeScore = {
      task_id: 'FIX--smoke', variant: 'resume-test',
      verdict: 'SUCCESS', judge_reasoning: 'pre-existing',
      agent_final_text: 'cached', run_seq: 1, wall_ms: 999,
      screenshot_path: '/tmp/cached.png',
    };
    writeFileSync(join(runDir, 'FIX_-smoke-r1.score.json'), JSON.stringify(fakeScore));
    const r = spawnSync(
      'node',
      [
        '--import', 'tsx',
        'bench/webvoyager/runner.ts',
        '--tasks-file', join(__dirname, 'fixtures/wv-2-tasks.jsonl'),
        '--variant', 'resume-test',
        '--out-dir', runDir,
        '--runs', '1',
        '--concurrency', '1',
        '--skip-judge',
        '--resume',
      ],
      { stdio: 'pipe', cwd: process.cwd() },
    );
    expect(r.status).toBe(0);
    const stdout = r.stdout.toString();
    expect(stdout).toMatch(/skipping.*FIX--smoke|resume.*1.*existing/i);
  }, 600_000);
});
```

- [ ] **Step 3: Run test — verify it fails.**

Run: `npx vitest run test/e2e/webvoyager-runner.test.ts --no-coverage --testTimeout=600000`
Expected: FAIL — runner.ts not found.

- [ ] **Step 4: Implement runner.**

```typescript
// bench/webvoyager/runner.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseWebVoyagerTask, type WebVoyagerScore, type WebVoyagerTask } from './types.js';
import { runWebVoyagerTask } from './adapter.js';
import { runJudge } from './judge.js';
import { aggregateScoreboard } from './score.js';

interface CliArgs {
  tasksFile: string;
  variant: string;
  outDir: string;
  runs: number;
  concurrency: number;
  skipJudge: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  for (const req of ['tasks-file', 'variant', 'out-dir']) {
    if (!args[req]) throw new Error(`--${req} required`);
  }
  return {
    tasksFile: args['tasks-file'] as string,
    variant: args['variant'] as string,
    outDir: args['out-dir'] as string,
    runs: parseInt((args['runs'] as string) ?? '1', 10),
    concurrency: parseInt((args['concurrency'] as string) ?? '8', 10),
    skipJudge: args['skip-judge'] === true,
    resume: args['resume'] === true,
  };
}

function sanitize(id: string): string { return id.replace(/[^A-Za-z0-9_-]/g, '_'); }

function scorePath(outDir: string, task: WebVoyagerTask, runSeq: number): string {
  return join(outDir, `${sanitize(task.id)}-r${runSeq}.score.json`);
}

async function workerLoop<I, O>(items: I[], concurrency: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const results: O[] = [];
  let cursor = 0;
  async function take(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx]!);
      } catch (e) {
        // Per-item error isolation: log but don't kill the whole run
        process.stderr.write(`[wv-runner] task ${idx} threw: ${e instanceof Error ? e.message : String(e)}\n`);
        results[idx] = undefined as unknown as O;
      }
    }
  }
  await Promise.all(Array(Math.min(concurrency, items.length)).fill(0).map(() => take()));
  return results.filter((r) => r !== undefined);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const tasks = readFileSync(args.tasksFile, 'utf-8')
    .split('\n').filter((l) => l.trim()).map(parseWebVoyagerTask);

  const allScores: WebVoyagerScore[] = [];
  let resumedCount = 0;

  for (let runSeq = 1; runSeq <= args.runs; runSeq++) {
    process.stdout.write(`[wv-runner] run ${runSeq}/${args.runs} starting (${tasks.length} tasks, c=${args.concurrency})\n`);

    // RESUME: load pre-existing score.json files for this run
    const todo: WebVoyagerTask[] = [];
    for (const task of tasks) {
      const sp = scorePath(args.outDir, task, runSeq);
      if (args.resume && existsSync(sp)) {
        try {
          const existing = JSON.parse(readFileSync(sp, 'utf-8')) as WebVoyagerScore;
          allScores.push(existing);
          resumedCount++;
          process.stdout.write(`[wv-runner] resume — skipping ${task.id} r${runSeq} (already scored: ${existing.verdict})\n`);
          continue;
        } catch { /* corrupt, re-run */ }
      }
      todo.push(task);
    }

    const runResults = await workerLoop(todo, args.concurrency, async (task) => {
      const adapterResult = await runWebVoyagerTask(task, {
        variant: args.variant,
        outDir: args.outDir,
        runSeq,
        timeoutMs: 240_000,
      });

      let verdict: 'SUCCESS' | 'FAILURE' | 'UNKNOWN' = 'UNKNOWN';
      let reasoning = '(judge skipped)';
      if (!args.skipJudge) {
        try {
          const j = await runJudge(task.question, adapterResult.agent_final_text, adapterResult.screenshot_path);
          verdict = j.verdict;
          reasoning = j.reasoning;
        } catch (e) {
          reasoning = `judge error: ${e instanceof Error ? e.message : String(e)}`;
          verdict = 'FAILURE';  // conservative — judge failure → conservative score
        }
      }

      const score: WebVoyagerScore = {
        task_id: task.id,
        variant: args.variant,
        verdict,
        judge_reasoning: reasoning,
        agent_final_text: adapterResult.agent_final_text,
        run_seq: runSeq,
        wall_ms: adapterResult.wall_ms,
        screenshot_path: adapterResult.screenshot_path,
      };

      // Write score immediately for crash-resume safety
      writeFileSync(scorePath(args.outDir, task, runSeq), JSON.stringify(score, null, 2));
      process.stdout.write(`[wv-runner] ${task.id} r${runSeq} ${verdict} ${score.wall_ms}ms\n`);
      return score;
    });

    allScores.push(...runResults);
  }

  const scoreboard = aggregateScoreboard(allScores);
  writeFileSync(join(args.outDir, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));
  process.stdout.write(`[wv-runner] done — ${scoreboard.overall.tasks_success}/${scoreboard.overall.tasks_total} success (${resumedCount} resumed)\n`);
}

main().catch((err) => {
  process.stderr.write(`[wv-runner] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 5: Run e2e tests.**

```bash
npm run build
SAFARI_PILOT_FIXTURE_PORT_HOST=18080 node --import tsx bench/start-fixture.mjs > /tmp/fixture.log 2>&1 &
FIXTURE_PID=$!
sleep 3
npx vitest run test/e2e/webvoyager-runner.test.ts --no-coverage --testTimeout=600000
kill $FIXTURE_PID
```

Expected: PASS, 2 tests (basic + resume).

- [ ] **Step 6: Commit.**

```bash
git add bench/webvoyager/runner.ts test/e2e/webvoyager-runner.test.ts test/e2e/fixtures/wv-2-tasks.jsonl
git commit -m "feat(webvoyager): runner with --resume + per-task error isolation"
```

---

### Task 8: Bash driver + sample CLI

**Files:**
- Create: `bench/webvoyager/run.sh`
- Create: `bench/webvoyager/sample-cli.ts`

- [ ] **Step 1: Implement bash driver.**

```bash
#!/usr/bin/env bash
# bench/webvoyager/run.sh — driver for WebVoyager bench runs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WV_DIR="${REPO_ROOT}/bench/webvoyager"

VARIANT=""
SAMPLE="dev"
RUNS=1
SKIP_JUDGE=""
RESUME=""

# Read concurrency from PF-6 decision
CONCURRENCY=$(cat "${WV_DIR}/CONCURRENCY" 2>/dev/null || echo 8)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)      VARIANT="$2";     shift 2 ;;
    --sample)       SAMPLE="$2";      shift 2 ;;
    --runs)         RUNS="$2";        shift 2 ;;
    --concurrency)  CONCURRENCY="$2"; shift 2 ;;
    --skip-judge)   SKIP_JUDGE="--skip-judge"; shift ;;
    --resume)       RESUME="--resume"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -z "${VARIANT}" ]] && { echo "ERROR: --variant required" >&2; exit 1; }

# Read TASKS_PATH from PF-5 (locked at pre-flight)
TASKS_FULL=$(cat "${WV_DIR}/TASKS_PATH")
[[ -f "${TASKS_FULL}" ]] || { echo "ERROR: tasks file missing: ${TASKS_FULL}" >&2; exit 1; }

case "${SAMPLE}" in
  dev)
    SAMPLE_N=175
    SAMPLED_FILE="$(mktemp -t wv-sampled-XXXXXX.jsonl)"
    node --import tsx "${WV_DIR}/sample-cli.ts" \
      --in "${TASKS_FULL}" \
      --n "${SAMPLE_N}" \
      --seed "v0.1.x-dev-sample" \
      --out "${SAMPLED_FILE}"
    TASKS_FILE="${SAMPLED_FILE}"
    ;;
  full)
    TASKS_FILE="${TASKS_FULL}"
    ;;
  *) echo "Unknown sample: ${SAMPLE} (use dev|full)" >&2; exit 1 ;;
esac

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${REPO_ROOT}/bench-runs/webvoyager-${VARIANT}-${TIMESTAMP}"
mkdir -p "${OUT_DIR}"

echo "[wv] variant=${VARIANT} sample=${SAMPLE} runs=${RUNS} concurrency=${CONCURRENCY} out=${OUT_DIR}"

node --import tsx "${WV_DIR}/runner.ts" \
  --tasks-file "${TASKS_FILE}" \
  --variant "${VARIANT}" \
  --out-dir "${OUT_DIR}" \
  --runs "${RUNS}" \
  --concurrency "${CONCURRENCY}" \
  ${SKIP_JUDGE} ${RESUME}

echo "[wv] done. scoreboard: ${OUT_DIR}/scoreboard.json"
```

- [ ] **Step 2: Implement sample CLI.**

```typescript
// bench/webvoyager/sample-cli.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { parseWebVoyagerTask } from './types.js';
import { stratifiedSample, sampleSeed } from './sample.js';

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a && a.startsWith('--') && i + 1 < process.argv.length) {
    args[a.slice(2)] = process.argv[i + 1] as string;
    i++;
  }
}

const tasks = readFileSync(args['in']!, 'utf-8')
  .split('\n').filter((l) => l.trim()).map(parseWebVoyagerTask);

const n = parseInt(args['n']!, 10);
const seed = sampleSeed(args['seed'] ?? 'default');
const sampled = stratifiedSample(tasks, n, seed);

writeFileSync(
  args['out']!,
  sampled.map((t) => JSON.stringify({ id: t.id, web_name: t.site, ques: t.question, web: t.url })).join('\n') + '\n',
);
process.stdout.write(`[sample-cli] wrote ${sampled.length} tasks to ${args['out']}\n`);
```

- [ ] **Step 3: Make executable + smoke-test driver.**

```bash
chmod +x bench/webvoyager/run.sh
# Smoke against fixture
SAFARI_PILOT_FIXTURE_PORT_HOST=18080 node --import tsx bench/start-fixture.mjs > /tmp/fixture.log 2>&1 &
FIXTURE_PID=$!
sleep 3
# Make a 2-task fixture as the "tasks file" temporarily, drive end-to-end with --skip-judge
cp test/e2e/fixtures/wv-2-tasks.jsonl bench/webvoyager/_smoke-tasks.jsonl
# Override TASKS_PATH for this smoke
echo "$(pwd)/bench/webvoyager/_smoke-tasks.jsonl" > bench/webvoyager/TASKS_PATH.bak
mv bench/webvoyager/TASKS_PATH.bak bench/webvoyager/TASKS_PATH
bash bench/webvoyager/run.sh --variant driver-smoke --sample full --runs 1 --concurrency 1 --skip-judge
# Restore TASKS_PATH (will be reset by user for real bench)
kill $FIXTURE_PID
```

  - **Gate T8:** the smoke must produce a `scoreboard.json` with 2 tasks scored. If not, the driver-runner-adapter chain is broken; fix before continuing.

- [ ] **Step 4: Restore TASKS_PATH to point to real WebVoyager file.**

```bash
# Re-run PF-5 path resolution to put the real path back
TASKS_PATH=$(find bench/webvoyager/data -maxdepth 4 -name "WebVoyager_data.jsonl" | head -1)
[[ -z "${TASKS_PATH}" ]] && TASKS_PATH=$(find bench/webvoyager/data -maxdepth 4 -name "*.jsonl" | head -1)
echo "${TASKS_PATH}" > bench/webvoyager/TASKS_PATH
rm -f bench/webvoyager/_smoke-tasks.jsonl
```

- [ ] **Step 5: Commit.**

```bash
git add bench/webvoyager/run.sh bench/webvoyager/sample-cli.ts
git commit -m "feat(webvoyager): bash driver + sample CLI (concurrency from PF-6)"
```

---

> ## **Gate A — Harness validated**
>
> Before proceeding to Phase 2 (real WebVoyager run), confirm:
>
> 1. All Phase 1 unit tests pass: `npx vitest run test/unit/webvoyager/ --no-coverage`
> 2. All Phase 1 e2e tests pass: `npx vitest run test/e2e/webvoyager-{adapter,runner,judge-real}.test.ts --no-coverage --testTimeout=300000`
> 3. End-to-end smoke at PF-6 concurrency completed: `bash bench/webvoyager/run.sh --variant gate-a-smoke --sample dev --runs 1 --skip-judge` produces a scoreboard with `tasks_total` matching the dev sample size.
>
> If any of these fail, return to the failing task. **Do not proceed to Phase 2 with broken harness.**

---

## Phase 2 — v0.1.29 Baseline Capture

### Task 9: v0.1.29 dev-sample baseline (175 tasks, N=1)

> **Operational task** — runs against live web. Schedule overnight. Cost ~$15-30 OpenAI judge.

- [ ] **Step 1: Verify v0.1.29 is the currently-shipped surface.**

```bash
git status                      # should be clean on feat branch
node -e "console.log(require('./package.json').version)"  # 0.1.29
```

- [ ] **Step 2: Production stack live + Caffeinate.**

```bash
caffeinate -dimsu &
CAFFEINATE_PID=$!
echo "CAFFEINATE_PID=${CAFFEINATE_PID}"  # save to kill after run
curl -s http://127.0.0.1:19474/status | head -1
```

- [ ] **Step 3: Schedule run.**

```bash
nohup bash bench/webvoyager/run.sh \
  --variant v0.1.29-baseline \
  --sample dev \
  --runs 1 \
  --resume \
  > /tmp/wv-v0129-baseline.log 2>&1 &
echo "RUN_PID=$!"
```

- [ ] **Step 4: When complete (check log), copy scoreboard to baselines dir.**

```bash
LATEST=$(ls -td bench-runs/webvoyager-v0.1.29-baseline-* | head -1)
TODAY=$(date +%Y-%m-%d)
mkdir -p bench/baselines/v0.1.x/${TODAY}
cp "${LATEST}/scoreboard.json" "bench/baselines/v0.1.x/${TODAY}/v0.1.29-webvoyager-dev.json"
kill ${CAFFEINATE_PID} 2>/dev/null || true
```

- [ ] **Step 5: Inspect.**

```bash
jq '.overall, (.per_site | to_entries | map({site: .key, success_rate: .value.success_rate, wall_ms_median: .value.wall_ms_median}))' \
   bench/baselines/v0.1.x/${TODAY}/v0.1.29-webvoyager-dev.json
```

  - Sanity check: `overall.tasks_total ≈ 175`, success rate plausible (0.30–0.70 is the expected range for haiku-on-WebVoyager-via-CC; outside that range investigate before proceeding).

- [ ] **Step 6: Commit.**

```bash
git add bench/baselines/v0.1.x/${TODAY}/v0.1.29-webvoyager-dev.json
git commit -m "bench(webvoyager): lock v0.1.29 dev-sample baseline (${TODAY})"
```

---

## Phase 3 — Architecture: Load-Bearing Discovery

### Task 10: Surface registry

**Files:**
- Create: `src/surface.ts`
- Test: `test/unit/surface/surface.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
// test/unit/surface/surface.test.ts
import { describe, it, expect } from 'vitest';
import { getSurfaceTools, surfaceMode, HOTSET_TOOLS, MIDSET_TOOLS } from '../../../src/surface.js';

describe('surface', () => {
  it('hotset includes the empirically-used + defensive tools (~14)', () => {
    expect(HOTSET_TOOLS.has('safari_snapshot')).toBe(true);
    expect(HOTSET_TOOLS.has('safari_navigate')).toBe(true);
    expect(HOTSET_TOOLS.has('safari_tool_search')).toBe(true);
    expect(HOTSET_TOOLS.has('safari_wait_for')).toBe(true);
    expect(HOTSET_TOOLS.size).toBeGreaterThanOrEqual(13);
    expect(HOTSET_TOOLS.size).toBeLessThanOrEqual(16);
  });

  it('midset is a strict superset of hotset', () => {
    for (const t of HOTSET_TOOLS) expect(MIDSET_TOOLS.has(t)).toBe(true);
    expect(MIDSET_TOOLS.size).toBeGreaterThan(HOTSET_TOOLS.size);
  });

  it('surfaceMode reads SAFARI_PILOT_SURFACE env, defaults to hotset', () => {
    const original = process.env['SAFARI_PILOT_SURFACE'];
    delete process.env['SAFARI_PILOT_SURFACE'];
    expect(surfaceMode()).toBe('hotset');
    process.env['SAFARI_PILOT_SURFACE'] = 'midset';
    expect(surfaceMode()).toBe('midset');
    process.env['SAFARI_PILOT_SURFACE'] = 'full';
    expect(surfaceMode()).toBe('full');
    process.env['SAFARI_PILOT_SURFACE'] = 'invalid';
    expect(surfaceMode()).toBe('hotset');
    if (original === undefined) delete process.env['SAFARI_PILOT_SURFACE'];
    else process.env['SAFARI_PILOT_SURFACE'] = original;
  });

  it('getSurfaceTools filters a tool list by current surface', () => {
    const all = [
      { name: 'safari_snapshot' },
      { name: 'safari_navigate' },
      { name: 'safari_dump_har' },
      { name: 'safari_tool_search' },
    ];
    const filtered = getSurfaceTools(all, 'hotset');
    expect(filtered.map((t) => t.name)).toContain('safari_snapshot');
    expect(filtered.map((t) => t.name)).toContain('safari_tool_search');
    expect(filtered.map((t) => t.name)).not.toContain('safari_dump_har');
  });

  it('getSurfaceTools with mode=full returns all tools unchanged', () => {
    const all = [{ name: 'safari_snapshot' }, { name: 'safari_dump_har' }];
    const filtered = getSurfaceTools(all, 'full');
    expect(filtered.length).toBe(all.length);
  });
});
```

- [ ] **Step 2: Run test — verify it fails.**

Run: `npx vitest run test/unit/surface/surface.test.ts --no-coverage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

```typescript
// src/surface.ts

export type SurfaceMode = 'hotset' | 'midset' | 'full';

export const HOTSET_TOOLS: ReadonlySet<string> = new Set([
  'safari_snapshot',
  'safari_new_tab',
  'safari_navigate',
  'safari_click',
  'safari_fill',
  'safari_get_text',
  'safari_get_html',
  'safari_query_all',
  'safari_evaluate',
  'safari_paginate_scrape',
  'safari_list_tabs',
  'safari_close_tab',
  'safari_health_check',
  'safari_wait_for',
  'safari_tool_search',
]);

export const MIDSET_TOOLS: ReadonlySet<string> = new Set([
  ...HOTSET_TOOLS,
  'safari_hover',
  'safari_type',
  'safari_press_key',
  'safari_scroll',
  'safari_double_click',
  'safari_select_option',
  'safari_check',
  'safari_drag',
  'safari_file_upload',
  'safari_get_attribute',
  'safari_extract_links',
  'safari_extract_tables',
  'safari_extract_metadata',
  'safari_navigate_back',
  'safari_navigate_forward',
  'safari_take_screenshot',
]);

export function surfaceMode(): SurfaceMode {
  const v = process.env['SAFARI_PILOT_SURFACE'];
  if (v === 'midset' || v === 'full') return v;
  return 'hotset';
}

export interface ToolNamed { name: string; }

export function getSurfaceTools<T extends ToolNamed>(tools: T[], mode: SurfaceMode = surfaceMode()): T[] {
  if (mode === 'full') return tools;
  const filter = mode === 'hotset' ? HOTSET_TOOLS : MIDSET_TOOLS;
  return tools.filter((t) => filter.has(t.name));
}
```

- [ ] **Step 4: Run test — verify it passes.**

Run: `npx vitest run test/unit/surface/surface.test.ts --no-coverage`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit.**

```bash
git add src/surface.ts test/unit/surface/surface.test.ts
git commit -m "feat(surface): hotset/midset/full registry with env-driven mode selection"
```

---

### Task 11: Wire surface filter into `tools/list` MCP response

**Files:**
- Modify: `src/server.ts`
- Test: `test/unit/server/listtools-filter.test.ts`

- [ ] **Step 1: Write the failing test (asserts against constants, not magic numbers).**

```typescript
// test/unit/server/listtools-filter.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';
import { HOTSET_TOOLS, MIDSET_TOOLS } from '../../../src/surface.js';

describe('SafariPilotServer.listToolDefinitions — surface filter', () => {
  let savedEnv: string | undefined;

  beforeEach(() => { savedEnv = process.env['SAFARI_PILOT_SURFACE']; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['SAFARI_PILOT_SURFACE'];
    else process.env['SAFARI_PILOT_SURFACE'] = savedEnv;
  });

  it('default (hotset) returns exactly the HOTSET_TOOLS that exist in the registered set', () => {
    delete process.env['SAFARI_PILOT_SURFACE'];
    const server = new SafariPilotServer(loadConfig());
    const tools = server.listToolDefinitions();
    const names = new Set(tools.map((t) => t.name));
    for (const t of names) expect(HOTSET_TOOLS.has(t)).toBe(true);
    // Verify safari_tool_search is in the hotset response
    expect(names.has('safari_tool_search')).toBe(true);
    // Verify a long-tail tool is NOT in the response
    expect(names.has('safari_dump_har')).toBe(false);
  });

  it('midset returns the MIDSET_TOOLS that exist in the registered set', () => {
    process.env['SAFARI_PILOT_SURFACE'] = 'midset';
    const server = new SafariPilotServer(loadConfig());
    const tools = server.listToolDefinitions();
    const names = new Set(tools.map((t) => t.name));
    for (const t of names) expect(MIDSET_TOOLS.has(t)).toBe(true);
    expect(names.has('safari_take_screenshot')).toBe(true);
  });

  it('full returns all registered tools (~86)', () => {
    process.env['SAFARI_PILOT_SURFACE'] = 'full';
    const server = new SafariPilotServer(loadConfig());
    const tools = server.listToolDefinitions();
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.map((t) => t.name)).toContain('safari_dump_har');
  });

  it('hotset preserves correct schema for kept tools', () => {
    delete process.env['SAFARI_PILOT_SURFACE'];
    const server = new SafariPilotServer(loadConfig());
    const tools = server.listToolDefinitions();
    const snapshot = tools.find((t) => t.name === 'safari_snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.inputSchema).toBeDefined();
  });
});
```

- [ ] **Step 2: Locate `listToolDefinitions` and the MCP `tools/list` handler.**

```bash
grep -n 'listToolDefinitions\|tools/list\|ListToolsRequestSchema' src/server.ts
```

- [ ] **Step 3: Run test — verify it fails.**

Run: `npx vitest run test/unit/server/listtools-filter.test.ts --no-coverage`
Expected: FAIL.

- [ ] **Step 4: Modify `src/server.ts` — wrap `listToolDefinitions()` return.**

Add at top of file:
```typescript
import { getSurfaceTools } from './surface.js';
```

Find the `listToolDefinitions()` method — wrap return:
```typescript
listToolDefinitions(): ToolDefinition[] {
  const allTools: ToolDefinition[] = [
    /* ...same body as before... */
  ];
  return getSurfaceTools(allTools);
}
```

If a separate `setRequestHandler(ListToolsRequestSchema, ...)` callback exists, change it to call `this.listToolDefinitions()` (which is now filtered).

  - **Critical:** if any other test in the existing suite asserts a specific tool count on `listToolDefinitions()`, those tests must be updated to either set `SAFARI_PILOT_SURFACE=full` for their expectation OR be updated to the new hotset/midset count.

- [ ] **Step 5: Run test + full unit suite.**

```bash
npm run build && npm test
```

Expected: surface tests PASS; all other tests PASS (or list any test that needs updating).

- [ ] **Step 6: Commit.**

```bash
git add src/server.ts test/unit/server/listtools-filter.test.ts
git commit -m "feat(server): tools/list filtered by SAFARI_PILOT_SURFACE (default hotset)"
```

---

### Task 12: e2e — load-bearing tool_search reaches the long tail

**Files:**
- Test: `test/e2e/safari-tool-search-loadbearing.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
// test/e2e/safari-tool-search-loadbearing.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { join } from 'node:path';

let client: McpTestClient;

beforeAll(async () => {
  delete process.env['SAFARI_PILOT_SURFACE'];
  client = new McpTestClient(join(__dirname, '../../dist/index.js'));
  await client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
}, 60_000);

afterAll(async () => { await client.close(); });

describe('Load-bearing safari_tool_search — long tail accessible via search', () => {
  it('default tools/list returns hotset only (no safari_dump_har)', async () => {
    const r = await client.send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }) as { result?: { tools?: Array<{ name: string }> } };
    const names = (r.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('safari_snapshot');
    expect(names).toContain('safari_tool_search');
    expect(names).not.toContain('safari_dump_har');
  }, 30_000);

  it('safari_tool_search returns long-tail candidates by query', async () => {
    const r = await client.send({
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'safari_tool_search', arguments: { query: 'capture network HAR', topK: 8 } },
    }) as { result?: { content?: Array<{ text: string }> } };
    const text = r.result?.content?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { hits?: Array<{ name: string }> };
    const names = (parsed.hits ?? []).map((h) => h.name);
    expect(names).toContain('safari_dump_har');
  }, 30_000);

  it('directly calling a long-tail tool by name still works (server unhides on invocation)', async () => {
    const r = await client.send({
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'safari_dump_har', arguments: {} },
    }) as { result?: unknown; error?: unknown };
    const errorStr = JSON.stringify(r.error ?? '');
    expect(errorStr).not.toMatch(/tool not found|unknown tool/i);
  }, 30_000);
});
```

- [ ] **Step 2: Build + run test.**

```bash
npm run build
npx vitest run test/e2e/safari-tool-search-loadbearing.test.ts --no-coverage
```

Expected: PASS, 3 tests.

  - **If test 3 FAILS** with "tool not found": the current MCP server rejects calls to tools not in the published list. We need to update the `tools/call` handler to dispatch by name regardless of `tools/list` filter. This is a **critical architectural dependency** — without this, the entire load-bearing-discovery design is impossible.

  - **Gate T12:** if test 3 fails, escalate before continuing. Either (a) modify the `tools/call` handler to dispatch by name from the FULL registered tools, or (b) accept that long-tail tools must be added to a per-session "unhidden" set when they're discovered via `safari_tool_search`. Option (a) is simpler and keeps server logic stateless.

- [ ] **Step 3: Commit.**

```bash
git add test/e2e/safari-tool-search-loadbearing.test.ts
git commit -m "test(e2e): load-bearing safari_tool_search reaches long-tail tools"
```

---

### Task 13: Companion skill (anchored trigger)

**Files:**
- Create: `plugin/skills/safari-orient-plan-execute.md`
- Modify: `.claude-plugin/plugin.json` (or wherever skills register)

- [ ] **Step 1: Inspect existing plugin manifest + skills directory.**

```bash
ls .claude-plugin/ plugin/ 2>/dev/null
cat .claude-plugin/plugin.json 2>/dev/null || cat plugin/manifest.json 2>/dev/null
ls plugin/skills/ 2>/dev/null
```

- [ ] **Step 2: Write the skill file.**

```markdown
---
name: safari-orient-plan-execute
description: Use this skill when about to call any safari-pilot MCP tool (tool names beginning with `safari_`) — for example browsing, scraping, filling a form, logging in, navigating Safari, extracting data from a webpage. Loads the orient-plan-execute strategy that makes safari-pilot's load-bearing tool discovery work correctly. Do NOT use this skill if the user is filling forms manually, browsing on their own, or talking about another browser automation tool.
---

# Safari Orient → Plan → Execute

You are about to use safari-pilot tools to operate Safari. Follow this strategy.

## 1. Orient first (cheap)

- After every `safari_navigate` or `safari_new_tab`, call `safari_snapshot` once. The snapshot is a YAML map of the page with element refs (`e1`, `e2`, ...). Use refs in subsequent tools — they are unique within a tab and survive across same-tab calls. Refs are far cheaper than CSS selectors.
- Pass the latest `tabUrl` (returned by `safari_new_tab` and `safari_navigate`) to subsequent calls — it changes after navigation.

## 2. Plan: search before guessing

Your default tool list is small (~14 tools). It covers most navigation/extraction/interaction. But it does not include the long tail: HAR capture, network mocking, frame interaction, file upload, geolocation override, etc.

- **If you need a capability that's not in your default tools, call `safari_tool_search`** with a description of what you want. Returns up to 8 candidate tools with descriptions. You can then call them by name — the server will execute them even though they weren't in your initial list.
- **Examples:**
  - "capture network requests" → `safari_list_network_requests`, `safari_dump_har`
  - "operate inside an iframe" → `safari_eval_in_frame`, `safari_list_frames`
  - "upload a file" → `safari_file_upload`
- **For multi-step recurring patterns, call `safari_list_skills` first.** If a pre-baked skill matches (e.g. `login`, `paginate-and-scrape`, `robust-form-fill`), invoke it via `safari_run_skill` — it executes the full sequence in one tool call.

## 3. Execute: minimal sequence, no backtracking

- **Use `safari_query_all`** when the task involves multiple matching elements (rows, items, results). Returns refs for every match. Never loop `safari_get_text` by index.
- **Use `chain` ops** when multiple elements match a selector and strict mode complains. Inline disambiguation: `chain: [{ filter: { hasText: "Sign In" } }, { nth: 0 }]`. Filter operators: `hasText`, `hasNotText`, `has`, `hasNot`. Index operators: `nth`, `first`, `last`. Combinators: `and`, `or`, `descendant`.
- **Use one tab per task.** Single `safari_new_tab` at the start. Do not open additional tabs unless the task explicitly requires multi-tab work.
- **Use one strategy per task.** Pick the best tool sequence and complete it. Do not abandon mid-task and try a different approach.
- **Read tool result `metadata.suggested_next_tools`.** When present, the server has identified a likely next action.

## 4. Ask, do not guess on missing parameters

If a required parameter is unclear from the task description, ask a clarifying question instead of inventing a value.

## 5. Conventions

- `safari_evaluate` is the escape hatch — try a structured tool first.
- Complete the task by stating your final answer in plain text, no tool call.
```

- [ ] **Step 3: Register skill in manifest if needed.**

If the existing manifest auto-discovers `plugin/skills/`, no change. Otherwise add:
```json
"skills": ["plugin/skills/safari-orient-plan-execute.md"]
```

- [ ] **Step 4: Manually verify skill loads ONLY when safari-pilot is being used.**

In a fresh CC session:
1. Type "fill out this Google form for me" (no safari mention) — verify skill does NOT auto-load (it would be a false positive).
2. Type "use safari pilot to fetch the title of example.com" — verify skill DOES auto-load.
3. Type "navigate Safari to wikipedia and read the first paragraph" — verify skill DOES auto-load.

If false-positive triggers: tighten the description (the anchor on "safari-pilot MCP tool" should help). If false-negative triggers: loosen.

- [ ] **Step 5: Commit.**

```bash
git add plugin/skills/safari-orient-plan-execute.md .claude-plugin/plugin.json
git commit -m "feat(plugin): companion skill safari-orient-plan-execute (plugin-anchored trigger)"
```

---

### Task 14: Trace hook (Node-based, OPT-IN)

**Files:**
- Create: `plugin/hooks/post-tool-trace.mjs`
- Modify: `.claude-plugin/plugin.json` (hook registration)

- [ ] **Step 1: Write the hook.**

```javascript
#!/usr/bin/env node
// plugin/hooks/post-tool-trace.mjs
// Records safari_* tool calls for recipe miner. OPT-IN via SAFARI_PILOT_TRACE_CC_SESSIONS=1.
//
// Why opt-in: production CC sessions may include sensitive page content
// (banking, logged-in services). Default-off respects user privacy.

import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

if (process.env.SAFARI_PILOT_TRACE_CC_SESSIONS !== '1') {
  process.exit(0);  // opted out
}

const traceDir = process.env.SAFARI_PILOT_TRACE_DIR || join(homedir(), '.safari-pilot', 'traces');
try { mkdirSync(traceDir, { recursive: true }); } catch { /* exists */ }

let stdin = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(stdin);
    const tool = event?.tool_name || event?.toolName || '';
    if (!tool.startsWith('safari_')) process.exit(0);

    const dateTag = new Date().toISOString().slice(0, 10);
    const path = join(traceDir, `cc-${dateTag}.jsonl`);
    const entry = {
      ts: new Date().toISOString(),
      tool,
      args: event?.tool_input || event?.toolInput || {},
      result: event?.tool_result || event?.toolResult || null,
      session_id: event?.session_id || event?.sessionId || 'unknown',
    };
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort: never block the calling session
  }
  process.exit(0);
});
// Safety timeout: if stdin never closes, exit anyway
setTimeout(() => process.exit(0), 2000);
```

- [ ] **Step 2: Make executable + register.**

```bash
chmod +x plugin/hooks/post-tool-trace.mjs
```

Add to manifest:
```json
"hooks": {
  "PostToolUse": [
    { "command": "plugin/hooks/post-tool-trace.mjs" }
  ]
}
```

- [ ] **Step 3: Test opt-out (default — no log).**

```bash
unset SAFARI_PILOT_TRACE_CC_SESSIONS
echo '{"tool_name":"safari_snapshot","tool_input":{},"tool_result":{"ok":true},"session_id":"test"}' \
  | node plugin/hooks/post-tool-trace.mjs
ls -la ~/.safari-pilot/traces/cc-$(date +%Y-%m-%d).jsonl 2>&1 || echo "OK — no log written (opt-out)"
```

Expected: file does NOT exist (privacy default).

- [ ] **Step 4: Test opt-in (writes log).**

```bash
SAFARI_PILOT_TRACE_CC_SESSIONS=1 echo '{"tool_name":"safari_snapshot","tool_input":{},"tool_result":{"ok":true},"session_id":"test"}' \
  | SAFARI_PILOT_TRACE_CC_SESSIONS=1 node plugin/hooks/post-tool-trace.mjs
cat ~/.safari-pilot/traces/cc-$(date +%Y-%m-%d).jsonl | tail -1
```

Expected: one JSON line with `tool: "safari_snapshot"`.

- [ ] **Step 5: Test that non-safari tools are filtered out (with opt-in active).**

```bash
SAFARI_PILOT_TRACE_CC_SESSIONS=1 echo '{"tool_name":"Bash","tool_input":{},"tool_result":{},"session_id":"test"}' \
  | SAFARI_PILOT_TRACE_CC_SESSIONS=1 node plugin/hooks/post-tool-trace.mjs
# File line count should NOT increase
wc -l ~/.safari-pilot/traces/cc-$(date +%Y-%m-%d).jsonl
```

- [ ] **Step 6: Commit.**

```bash
git add plugin/hooks/post-tool-trace.mjs .claude-plugin/plugin.json
git commit -m "feat(plugin): post-tool trace hook (Node-based, opt-in via SAFARI_PILOT_TRACE_CC_SESSIONS)"
```

---

### Task 15: Update `safari-pilot.config.json`

**Files:**
- Modify: `safari-pilot.config.json`

- [ ] **Step 1: Add `defaultSurface` field. Documentation lives in `docs/benchmarking.md`, not inline.**

```bash
# Read current
cat safari-pilot.config.json
```

Edit JSON to include (preserving existing fields):
```json
{
  "defaultSurface": "hotset",
  "...existing fields..."
}
```

  Note: this is informational. The env var `SAFARI_PILOT_SURFACE` always wins. We do not wire the config field into runtime in this plan — that's a v0.1.31 enhancement if needed.

- [ ] **Step 2: Verify config is still valid JSON + server still starts.**

```bash
node -e "JSON.parse(require('fs').readFileSync('safari-pilot.config.json'))"
npm run build
node -e "const { SafariPilotServer } = require('./dist/server.js'); const { loadConfig } = require('./dist/config.js'); console.log(new SafariPilotServer(loadConfig()).listToolDefinitions().length);"
```

Expected: ~14 tools.

- [ ] **Step 3: Commit.**

```bash
git add safari-pilot.config.json
git commit -m "feat(config): add defaultSurface field (informational; env wins)"
```

---

> ## **Gate B — Architecture smoke**
>
> After Tasks 10-15 land, before scheduling the v0.1.30 baseline, verify:
>
> ```bash
> npm run build
> claude --dangerously-skip-permissions -p "Call safari_health_check, then call safari_tool_search with query='capture network HAR' and tell me how many candidates came back. End with: GATE_B: <count>"
> ```
>
> Expected: response includes `GATE_B: <N>` where N >= 1 (proves search returned at least one candidate from the long tail). If GATE_B reports 0 candidates or `claude -p` fails to load the plugin, the architecture isn't viable end-to-end.
>
> Also verify a v0.1.30 production session manually:
> 1. Open a fresh CC session
> 2. Issue a simple browse task ("use safari pilot to navigate to example.com and tell me the page title")
> 3. Verify the companion skill loads (visible in CC's context display)
> 4. Verify the task completes successfully
>
> If either check fails, return to the failing task. **Do not proceed to v0.1.30 baseline with broken integration.**

---

## Phase 4 — v0.1.30 Baseline + Decision Gate

### Task 16: v0.1.30 dev-sample baseline + comparison

> **Operational task** — same machine + same week as v0.1.29 baseline (Task 9). Schedule overnight. Cost ~$15-30 OpenAI judge.

- [ ] **Step 1: Verify v0.1.30 architecture is shipped.**

```bash
git log --oneline feat/v0130-webvoyager-and-discovery | head -10
npm run build
unset SAFARI_PILOT_SURFACE
node -e "const { SafariPilotServer } = require('./dist/server.js'); const { loadConfig } = require('./dist/config.js'); console.log(new SafariPilotServer(loadConfig()).listToolDefinitions().length);"
```

Expected: ~14 tools (hotset).

- [ ] **Step 2: Schedule run.**

```bash
caffeinate -dimsu &
CAFFEINATE_PID=$!
nohup bash bench/webvoyager/run.sh \
  --variant v0.1.30-baseline \
  --sample dev \
  --runs 1 \
  --resume \
  > /tmp/wv-v0130-baseline.log 2>&1 &
echo "RUN_PID=$!"
```

- [ ] **Step 3: When complete, copy + compare.**

```bash
LATEST=$(ls -td bench-runs/webvoyager-v0.1.30-baseline-* | head -1)
TODAY=$(date +%Y-%m-%d)
mkdir -p bench/baselines/v0.1.x/${TODAY}
cp "${LATEST}/scoreboard.json" "bench/baselines/v0.1.x/${TODAY}/v0.1.30-webvoyager-dev.json"
kill ${CAFFEINATE_PID} 2>/dev/null || true
```

- [ ] **Step 4: Generate comparison report.**

```bash
DATE=${TODAY} node --import tsx -e '
import { readFileSync } from "fs";
const date = process.env.DATE;
const v29 = JSON.parse(readFileSync(`bench/baselines/v0.1.x/${date}/v0.1.29-webvoyager-dev.json`, "utf-8"));
const v30 = JSON.parse(readFileSync(`bench/baselines/v0.1.x/${date}/v0.1.30-webvoyager-dev.json`, "utf-8"));
console.log("=== Overall ===");
console.log(`  v0.1.29: ${(v29.overall.success_rate*100).toFixed(1)}% @ ${v29.overall.wall_ms_median}ms median`);
console.log(`  v0.1.30: ${(v30.overall.success_rate*100).toFixed(1)}% @ ${v30.overall.wall_ms_median}ms median`);
const dPp = (v30.overall.success_rate - v29.overall.success_rate) * 100;
const dWall = (v30.overall.wall_ms_median / v29.overall.wall_ms_median - 1) * 100;
console.log(`  Δ success: ${dPp.toFixed(1)}pp`);
console.log(`  Δ wall_ms_median: ${dWall.toFixed(1)}%`);
console.log("\n=== Per-site ===");
const sites = Object.keys(v30.per_site).sort();
let worstRegress = 0;
for (const site of sites) {
  const a = v29.per_site[site]?.success_rate ?? 0;
  const b = v30.per_site[site].success_rate;
  const d = (b - a) * 100;
  if (d < worstRegress) worstRegress = d;
  const flag = d < -10 ? " ⚠ REGRESSION" : "";
  console.log(`  ${site.padEnd(20)} ${(a*100).toFixed(0).padStart(3)}% → ${(b*100).toFixed(0).padStart(3)}%  Δ ${d.toFixed(0).padStart(4)}pp${flag}`);
}
console.log("\n=== Gate C decision inputs ===");
console.log(`  Δ success: ${dPp.toFixed(2)}pp (threshold: ≥ -2.0pp)`);
console.log(`  Δ wall_ms_median: ${dWall.toFixed(2)}% (threshold: ≤ +5.0%)`);
console.log(`  Worst per-site regression: ${worstRegress.toFixed(2)}pp (threshold: ≥ -10.0pp)`);
const passSucc = dPp >= -2;
const passWall = dWall <= 5;
const passSite = worstRegress >= -10;
console.log(`\n  PASS: success=${passSucc}, wall=${passWall}, per-site=${passSite}`);
console.log(`\n  ${passSucc && passWall && passSite ? "✅ GATE C PASS — proceed to Phase 5" : "❌ GATE C FAIL — return to Phase 3 or accept regression deliberately"}`);
' > bench/baselines/v0.1.x/${TODAY}/v0130-vs-v0129-dev-comparison.txt
cat bench/baselines/v0.1.x/${TODAY}/v0130-vs-v0129-dev-comparison.txt
```

- [ ] **Step 5: Commit.**

```bash
git add bench/baselines/v0.1.x/${TODAY}/v0.1.30-webvoyager-dev.json bench/baselines/v0.1.x/${TODAY}/v0130-vs-v0129-dev-comparison.txt
git commit -m "bench(webvoyager): v0.1.30 dev baseline + co-measurement comparison + Gate C decision"
```

---

> ## **Gate C — Ship decision gate (HARD)**
>
> Read `bench/baselines/v0.1.x/<DATE>/v0130-vs-v0129-dev-comparison.txt`. **Proceed to Phase 5 ONLY IF ALL THREE conditions pass:**
>
> 1. **Success rate:** v0.1.30 success rate within ±2pp of v0.1.29 (i.e. `Δ success ≥ -2pp`).
> 2. **Wall time:** v0.1.30 wall_ms_median no more than 5% above v0.1.29 (i.e. `Δ wall_ms_median ≤ +5%`).
> 3. **Per-site:** no individual site regresses more than 10pp (i.e. worst regression `≥ -10pp`).
>
> **If ANY condition fails:**
> - **Option A — fix the architecture.** Likely paths: (a) wrong default surface (some sites need a tool we excluded from hotset); (b) companion skill misfiring on real WebVoyager tasks; (c) `safari_tool_search` not effectively surfacing the right tools. Diagnose via per-site comparison + per-task transcripts.
> - **Option B — accept narrower v0.1.30.** Default surface stays at `full` (no change), but we still ship the orient-plan-execute companion skill, the trace hook, and the WebVoyager harness as ship-supporting infrastructure. v0.1.30 becomes a "WebVoyager baseline + plumbing" release; the surface filter ships in v0.1.31 once we figure out why hotset hurts.
> - **Option C — abort the architecture change.** Roll back Tasks 10-12 (keep T13-T15). v0.1.30 ships only the companion skill + hook + bench harness.
>
> Pick A, B, or C explicitly and document the choice in `docs/changelogs/v0.1.30.md`. **Do not proceed to Task 17 silently if Gate C fails.**

---

## Phase 5 — Ship Gate (only if Gate C passed)

### Task 17: Full N=3 ship-gate baselines (co-measured)

> **Cost:** ~$300-450 in OpenAI judge calls. Wall time ~24-48hr per variant. Schedule across multiple overnight windows if needed (`--resume` lets the run pick up where it died).

- [ ] **Step 1: Schedule v0.1.29 full N=3.**

```bash
caffeinate -dimsu &
CAFFEINATE_PID=$!
nohup bash bench/webvoyager/run.sh \
  --variant v0.1.29-shipgate \
  --sample full \
  --runs 3 \
  --resume \
  > /tmp/wv-v0129-shipgate.log 2>&1 &
```

- [ ] **Step 2: When complete, schedule v0.1.30 full N=3.**

```bash
nohup bash bench/webvoyager/run.sh \
  --variant v0.1.30-shipgate \
  --sample full \
  --runs 3 \
  --resume \
  > /tmp/wv-v0130-shipgate.log 2>&1 &
```

- [ ] **Step 3: Lock both as baselines.**

```bash
TODAY=$(date +%Y-%m-%d)
for V in v0.1.29-shipgate v0.1.30-shipgate; do
  LATEST=$(ls -td bench-runs/webvoyager-${V}-* | head -1)
  cp "${LATEST}/scoreboard.json" "bench/baselines/v0.1.x/${TODAY}/${V}-webvoyager-full.json"
done
kill ${CAFFEINATE_PID} 2>/dev/null || true
```

- [ ] **Step 4: Re-run comparison report on full baselines.**

(Same script as Task 16 step 4, but pointing at the `-shipgate-webvoyager-full.json` files.)

- [ ] **Step 5: Re-evaluate Gate C against the full N=3 numbers.** If still passing, proceed to Task 18. If now failing (because dev sample was lucky), return to Gate C decision (A/B/C).

- [ ] **Step 6: Commit.**

```bash
git add bench/baselines/v0.1.x/${TODAY}/v0.1.29-shipgate-webvoyager-full.json bench/baselines/v0.1.x/${TODAY}/v0.1.30-shipgate-webvoyager-full.json bench/baselines/v0.1.x/${TODAY}/v0130-vs-v0129-shipgate-comparison.txt
git commit -m "bench(webvoyager): full N=3 ship-gate baselines (${TODAY})"
```

---

### Task 18: v0.1.30 changelog + version bump + tag + rollback plan

**Files:**
- Create: `docs/changelogs/v0.1.30.md`
- Modify: `package.json`, `extension/manifest.json` (lockstep version per memory `feedback-extension-version-both-fields`)

- [ ] **Step 1: Write the changelog with REAL numbers from Gate C / Task 17.**

```markdown
# v0.1.30 — Load-bearing discovery + WebVoyager canonical baseline

## Headline

[ONE PARAGRAPH — fill in based on Gate C outcome:
 If A (architecture passed): "v0.1.30 introduces dynamic surface exposure: default tools/list returns 14 tools (hotset) instead of 86. Long tail reachable via safari_tool_search or by direct call. WebVoyager full N=3: v0.1.29 X.X% / Y.YYs median → v0.1.30 X.X% / Y.YYs median."
 If B (narrowed scope): "v0.1.30 establishes WebVoyager as the canonical Safari Pilot benchmark and ships the orient-plan-execute companion skill and opt-in trace hook. The default-surface architecture change is deferred to v0.1.31 pending root-cause analysis of dev-sample regression on sites X/Y/Z."
 If C (architecture aborted): "v0.1.30 ships the WebVoyager harness, the companion skill, and the trace hook. The proposed default-surface change was reverted after benchmark showed regression."]

## What changed

[List ONLY what actually shipped. If Gate C went route A, include surface registry + tools/list filter. If B/C, omit those.]

- Bench infra: `bench/webvoyager/` (adapter, judge, sampler, scoreboard, runner, driver). Verbatim WebVoyager prompt. gpt-4o judge. claude -p driver (Max subscription, no API spend on agent side). Per-task resume on rerun.
- Companion skill: `plugin/skills/safari-orient-plan-execute.md` — auto-loads when the agent uses safari-pilot tools.
- Opt-in trace hook: `plugin/hooks/post-tool-trace.mjs` — writes safari_* tool calls to `~/.safari-pilot/traces/` when `SAFARI_PILOT_TRACE_CC_SESSIONS=1`. Default-off respects user privacy.

## WebVoyager scoreboard (locked, full N=3)

[Fill in from Task 17 step 3]

| Variant | Tasks | Success | Wall median (ms) | Worst-site regression |
|---|---|---|---|---|
| v0.1.29 | 643 (N=3) | XX.X% | YY,YYY | (n/a) |
| v0.1.30 | 643 (N=3) | XX.X% | YY,YYY | -X.Xpp on <site> |
| Δ | — | +X.Xpp | -X.X% | — |

Per-site deltas: see `bench/baselines/v0.1.x/<DATE>/v0130-vs-v0129-shipgate-comparison.txt`.

## Rollback plan

If v0.1.30 causes regressions in user reports within 72 hours of release:

```bash
# Revert the v0.1.30 tag commit on main
git revert <v0.1.30 commit SHA>
# Or hot-fix via env in user's environment
SAFARI_PILOT_SURFACE=full claude  # restores v0.1.29 behavior
# Cut a v0.1.31 with the env override defaulted to 'full' until issue resolved
```

`SAFARI_PILOT_SURFACE=full` is permanent escape valve — every user can opt out without waiting for a release.

## Files

[List actual files shipped, omit any from the rolled-back path]

## Process notes

- All Phase 1-3 tasks shipped under `upp:executing-plans` subagent mode with TDD red→green per task.
- WebVoyager baselines captured in same-week co-measurement window (v0.1.29 + v0.1.30 within 72hr of each other).
- Gate C decision: [Option A/B/C — quote the comparison txt outcome].
```

- [ ] **Step 2: Bump version + lockstep extension manifest.**

```bash
# package.json
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json'));
p.version = '0.1.30';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2));
"
# extension/manifest.json — must use same version
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('extension/manifest.json'));
m.version = '0.1.30';
fs.writeFileSync('extension/manifest.json', JSON.stringify(m, null, 2));
"
```

- [ ] **Step 3: Run pre-tag checks.**

```bash
bash scripts/pre-tag-check.sh
```

Expected: `ALL CHECKS PASSED`. If extension was changed in this sprint (it wasn't, per scope), need to rebuild via `bash scripts/build-extension.sh` first.

- [ ] **Step 4: Merge to main + tag + push.**

```bash
git add docs/changelogs/v0.1.30.md package.json extension/manifest.json
git commit -m "chore(release): v0.1.30 — load-bearing discovery + WebVoyager baselines"

git checkout main
git merge feat/v0130-webvoyager-and-discovery
git push origin main

git tag -a v0.1.30 -m "v0.1.30 — see docs/changelogs/v0.1.30.md"
git push origin v0.1.30
```

- [ ] **Step 5: Watch CI.**

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

---

## Plan-level acceptance criteria

- [ ] Pre-flight Gates PF-5a, PF-5b, PF-6 all passed
- [ ] WebVoyager harness shipped (Tasks 1-8); Gate A passed
- [ ] v0.1.29 dev-sample baseline locked (Task 9)
- [ ] Surface registry + tools/list filter shipped if Gate C went route A (Tasks 10-12); Gate T12 passed
- [ ] Companion skill shipped (Task 13)
- [ ] Trace hook shipped opt-in (Task 14)
- [ ] Config updated (Task 15); Gate B passed
- [ ] v0.1.30 dev-sample baseline + comparison locked (Task 16); Gate C decision documented
- [ ] (If Gate C → A) Full N=3 ship-gate baselines locked (Task 17)
- [ ] Changelog written with real numbers + rollback plan (Task 18)
- [ ] Version tagged + CI green (Task 18)

---

## Self-review summary

**1. Spec coverage:** every concern from the brainstorming session has a task. WebVoyager protocol → Phase 1; co-measurement → Phase 2 + 4; load-bearing discovery → Phase 3; ship → Phase 5. ✓

**2. Placeholders:** Task 18 changelog has structured placeholders that get filled at execution time from real comparison-report output. The placeholder shape is fully specified; only numbers + Gate C choice are deferred. ✓

**3. Type consistency:** `WebVoyagerTask`, `WebVoyagerScore`, `JudgeVerdict`, `SurfaceMode`, `Scoreboard`, `TaskAggregate`, `SiteAggregate` consistent across tasks. `wall_ms` cost metric (no `tt`) used uniformly. ✓

**4. Gates explicit:**
- **PF-5a/b** — dataset path + verbatim judge prompt extraction must succeed before any code depending on them
- **PF-6** — concurrency decision empirical, written to `CONCURRENCY` file
- **Gate A** — harness validated end-to-end before real WebVoyager run
- **Gate T4** — verbatim judge prompt locked
- **Gate T8** — driver-runner-adapter chain works
- **Gate T12** — long-tail tool callable by name even when hidden from list (architectural prerequisite)
- **Gate B** — architecture change works through claude -p
- **Gate C** — explicit thresholds (-2pp success, +5% wall, -10pp per-site); HARD gate before ship

---

## Revision changelog vs original

Applied 18 fixes from engineering-lead review:

1. ✅ **Verbatim judge prompt** — extracted in PF-5, used in T4 (was: paraphrased)
2. ✅ **Cost metric = wall_ms** — `tt` field dropped from types/scoreboard (was: `tt = wall_ms × tokens`, broken because claude -p doesn't surface tokens)
3. ✅ **Post-hoc screenshot** — `mcp-direct.ts` captures screenshot after `claude -p` exits (was: agent had to take it via instruction)
4. ✅ **Resume capability** — runner reads pre-existing per-task scores on startup (was: no resume)
5. ✅ **Gate C decision gate** — explicit ±2pp / +5% / -10pp thresholds (was: vague "neutral or better")
6. ✅ **PF-2 stronger** — calls safari_health_check via claude -p, not just "say hello" (was: too weak)
7. ✅ **Dataset path verified at PF-5** — path written to `TASKS_PATH` file, used by all downstream (was: guessed)
8. ✅ **Per-site `wall_ms_median`** computed over all runs in site, not median of medians (was: median of medians)
9. ✅ **Tie-break = FAILURE** — conservative (was: SUCCESS bias)
10. ✅ **Companion skill trigger anchored to plugin** — "when about to call safari_* tools" (was: generic verbs like "fill out a form")
11. ✅ **Hook opt-in via SAFARI_PILOT_TRACE_CC_SESSIONS=1** — privacy-respecting default (was: always-on)
12. ✅ **Concurrency smoke at PF-6** — empirical decision before scheduling overnight (was: guess + fallback)
13. ✅ **Ship-gate thresholds explicit** — Gate C codifies them (was: undefined "passing")
14. ✅ **Surface filter location decision documented** — server-side, rationale in plan header (was: implicit)
15. ✅ **Dead site_state_hash field removed** — was specced but never populated by runner; cleaner to drop than implement half-way
16. ✅ **Config docs moved to docs/benchmarking.md** — no awkward `_doc_*` JSON fields (was: inline doc in config)
17. ✅ **Hook rewritten in Node** — no jq dependency, guaranteed available (was: bash + jq)
18. ✅ **Rollback plan** added to T18 changelog template + `SAFARI_PILOT_SURFACE=full` as user escape valve (was: missing)

Plus structural improvements:
- **Per-task error isolation** in runner's worker loop (was: one failure killed all parallel workers)
- **Unique variant in run dir name** (`bench-runs/webvoyager-${VARIANT}-${TIMESTAMP}/`) so concurrent runs don't collide
- **Caffeinate** explicit in operational tasks to prevent sleep-mid-run
- **Conservative judge fallback** — judge errors → FAILURE verdict (was: errors raised + propagated, would kill the run)
- **Gate B** added between Phase 3 and 4 — quick sanity check that architecture works through claude -p before scheduling overnight bench

---

## Execution handoff

**Plan complete and saved to `docs/upp/plans/2026-05-08-v0130-webvoyager-and-loadbearing-discovery.md`.**

**Execute with:** `upp:executing-plans` skill in **subagent mode** (recommended) — fresh subagent per task with two-stage review (spec + code quality). No design context, so no design gate.

Tasks 9, 16, 17 are operational (long-running benchmark runs). Subagent dispatch for these can be skipped — controller runs them inline since the work is "schedule + wait + copy results."

Gates A, B, C, T4, T8, T12 are hard pause-points where the controller (you) reviews evidence and explicitly decides whether to proceed.
