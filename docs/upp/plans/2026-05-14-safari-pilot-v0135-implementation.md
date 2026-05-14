# Safari Pilot v0.1.35 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with two-stage review — spec compliance + code quality; no design stage since this is pure backend work) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.1.34's CSP-bypass infrastructure as v0.1.35 with bench-integrity protocol, evidence-grounded answer support, abstention policy, anti-thrash controls, and a 4-nudge unwind on tool descriptions.

**Architecture:** 11 slices in execution order. Slice 0 (patched bench) MUST land first so all later slices run against trustworthy signal. Bench-protocol slices (0-2) precede product slices (3-7). Eval-contamination guard (8) precedes the gate (9). Ship is the final slice.

**Tech Stack:** TypeScript (MCP server, bench harness), Swift (daemon — untouched this sprint), JavaScript (Safari Web Extension content scripts), Python (judge + bench analysis tools). Build via `npm run build` + `bash scripts/build-extension.sh`. Tests via vitest.

**Spec:** `docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md`

**Inputs:**
- Phase 1 diagnostic: `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md`
- Phase 2 research: `bench-runs/webvoyager-v0.1.34-bench-20260514/research-r1-r10.md`
- v0.1.34 branch HEAD: `feat/v0134-csp-bypass` at `4960ae3` (foundation; 16 sentinels + Layer 3 TT policy + locator port + 3 capability tools + legacyMainWorld flag — do not unwind)

**Branch:** continue on `feat/v0134-csp-bypass`. Final ship-tag will be `v0.1.35`.

---

## File Structure

| Path | Purpose | Status |
|---|---|---|
| `bench/webvoyager/patches.json` | Date substitutions + removal list per task ID | NEW |
| `bench/webvoyager/apply-patches.py` | Reads patches.json, emits patched-2026.jsonl + comparable-original.jsonl | NEW |
| `bench/webvoyager/run-bench.sh` | Top-level runner with `--patched`/`--comparable` modes | NEW (wraps run-one-task.sh) |
| `bench/webvoyager/runner.ts` | Adds `--runs N` flag for majority-of-N | MODIFY |
| `bench/webvoyager/judge.ts` | Majority-of-N verdict aggregation; recognizes ABSTAIN prefix | MODIFY |
| `bench/webvoyager/score.ts` | Dual-metric report (Pass@1 + median steps + median wall + total $) | MODIFY |
| `bench/webvoyager/run-one-task.sh` | Adds MAX_TURNS + MAX_WALL_MS env passing | MODIFY |
| `bench/webvoyager/audit-contamination.py` | Post-bench scan for benchmark-name searches in traces | NEW |
| `bench/webvoyager/prompt-template.md` | Adds abstention guidance | NEW (extracted from current inline template) |
| `bench/webvoyager/README.md` | Documents patched-2026 + comparable-original protocol | NEW |
| `src/security/loop-detector.ts` | Detects N consecutive identical tool calls + N consecutive identical snapshots | NEW |
| `src/server.ts` | Wires loop-detector into pre-execution pipeline + session step/wall caps | MODIFY |
| `src/tools/page-info.ts` | Remove "Use in place of safari_evaluate" from 3 tool descriptions | MODIFY |
| `src/tools/extraction.ts` | Soften safari_evaluate description; rewrite CSP_BLOCKED hint to be informational | MODIFY |
| `src/tools/interaction.ts` | Downgrade `requiresCspBypass` from `true` to `'preferred'` on tools with AppleScript fallback | MODIFY |
| `src/types.ts` | Adds `'preferred'` to `requiresCspBypass` union type | MODIFY |
| `src/engine-selector.ts` | Handles `'preferred'` value (Extension first, AppleScript fallback with degraded metadata) | MODIFY |
| `src/tools/final-proof.ts` | New tool: `safari_compose_final_evidence` | NEW |
| `src/tools/playbooks.ts` | New tools: `safari_normalize_date`, `safari_dismiss_cookie_consent` (wrapper), `safari_wait_for_rate_limit_clear` | NEW |
| `src/server.ts` | Register final-proof + playbooks tool modules | MODIFY |
| `extension/content-main.js` | Add `__SP_COMPOSE_FINAL_EVIDENCE__` + `__SP_WAIT_RATE_LIMIT_CLEAR__` sentinels | MODIFY |
| `extension/locator.js` | `resolveLocatorAll` envelope adds `interactability` per element | MODIFY |
| `src/locator.ts` | Type definition update for `interactability`; mirror behavior for AppleScript fallback | MODIFY |
| `test/unit/locators/drift-detector.test.ts` | Cover new interactability fields | MODIFY |
| `test/e2e/anti-thrash.test.ts` | New e2e for loop-detector + thrash-detector + caps | NEW |
| `test/e2e/final-proof.test.ts` | New e2e for safari_compose_final_evidence | NEW |
| `test/e2e/playbooks.test.ts` | New e2e for 3 playbook tools | NEW |
| `test/e2e/csp-error-softened.test.ts` | New e2e: CSP_BLOCKED returns informational hint, no prescriptive alternative_tools list | NEW |
| `test/unit/bench/apply-patches.test.py` | New unit: apply-patches.py emits valid patched-2026 + comparable-original sets | NEW |
| `test/unit/bench/judge-majority.test.ts` | New unit: majority-of-N verdict aggregation | NEW |
| `package.json` + `extension/manifest.json` | Bump to `0.1.35` (lockstep) | MODIFY |
| `CHANGELOG.md` | v0.1.35 entry | MODIFY |
| `ARCHITECTURE.md` | Updates for new tools + bench protocol | MODIFY |

---

## Tasks

### Task 1: WebVoyager date-audit and patches.json schema

**Files:**
- Create: `bench/webvoyager/patches.json`
- Create: `bench/webvoyager/AUDIT.md`

- [ ] **Step 1: Audit all 643 tasks for hardcoded dates**

Read `bench/webvoyager/data/data/WebVoyager_data.jsonl`. For each task, scan `ques` for: month names (Jan-Dec), 4-digit years (2020-2026), date formats (e.g. "Jan 10-24, 2024", "01/10/2024"), and date-relative phrases ("last week", "tomorrow", "this Friday"). Categorize each hit:

- `substitute` — date can be shifted forward (e.g., "Jan 10-24, 2024" → "Jan 10-24, 2027"); the underlying intent (find a flight, find a news article from a date range) is still meaningful.
- `remove` — task references an event that has already happened and cannot be refreshed (e.g., "find the schedule for the 2024 Super Bowl"); future-shifting changes the meaning.
- `keep` — date is incidental or the page handles dates dynamically (e.g., a Wikipedia article about a historical figure; today-relative searches).

Write `bench/webvoyager/AUDIT.md` listing each affected task with its category + one-sentence rationale. Aim for ~130-150 affected tasks given the spec note "21% of canonical tasks have hardcoded dates."

- [ ] **Step 2: Write patches.json**

Format:
```json
{
  "schema_version": "1",
  "dataset_sha": "<from bench/webvoyager/DATASET_COMMIT>",
  "generated_date": "2026-05-14",
  "patches": {
    "Google Flights--13": {
      "action": "substitute",
      "field": "ques",
      "find": "Jan 10 to Jan 24, 2024",
      "replace": "Jan 10 to Jan 24, 2027",
      "rationale": "Google Flights rejects past dates; substitution preserves the search intent."
    },
    "Booking--5": {
      "action": "substitute",
      "field": "ques",
      "find": "January 1 to January 4, 2024",
      "replace": "January 1 to January 4, 2027",
      "rationale": "Booking.com requires future dates; substitution preserves the hotel-search intent."
    },
    "<Task ID>": {
      "action": "remove",
      "rationale": "Event-specific task; cannot future-shift without changing the meaning."
    }
  }
}
```

One entry per patched task. Cross-reference AUDIT.md.

- [ ] **Step 3: Commit**

```bash
git add bench/webvoyager/patches.json bench/webvoyager/AUDIT.md
git commit -m "feat(bench): patches.json + AUDIT.md for WebVoyager stale-date handling"
```

---

### Task 2: apply-patches.py — emit patched-2026 + comparable-original sets

**Files:**
- Create: `bench/webvoyager/apply-patches.py`
- Create: `test/unit/bench/test_apply_patches.py`

- [ ] **Step 1: Write the failing test**

```python
# test/unit/bench/test_apply_patches.py
import json
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / 'bench/webvoyager/apply-patches.py'

def test_substitute_replaces_field():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        dataset = tmp / 'tasks.jsonl'
        dataset.write_text(
            json.dumps({"id":"X--1","web_name":"X","web":"https://x","ques":"flight Jan 10-24, 2024"}) + "\n" +
            json.dumps({"id":"X--2","web_name":"X","web":"https://x","ques":"keep me"}) + "\n"
        )
        patches = tmp / 'patches.json'
        patches.write_text(json.dumps({
            "schema_version":"1","dataset_sha":"test","generated_date":"2026-05-14",
            "patches":{"X--1":{"action":"substitute","field":"ques","find":"Jan 10-24, 2024","replace":"Jan 10-24, 2027","rationale":"r"}}
        }))
        out_patched = tmp / 'patched.jsonl'
        out_comp = tmp / 'comparable.jsonl'
        result = subprocess.run(
            ['python3', str(SCRIPT),
             '--dataset', str(dataset), '--patches', str(patches),
             '--out-patched', str(out_patched), '--out-comparable', str(out_comp)],
            capture_output=True, text=True
        )
        assert result.returncode == 0, result.stderr
        patched = [json.loads(l) for l in out_patched.read_text().splitlines()]
        comparable = [json.loads(l) for l in out_comp.read_text().splitlines()]
        assert len(patched) == 2
        assert patched[0]['ques'] == 'flight Jan 10-24, 2027'
        assert patched[1]['ques'] == 'keep me'
        # comparable contains only tasks NOT touched by patches
        assert len(comparable) == 1
        assert comparable[0]['id'] == 'X--2'

def test_remove_action_drops_from_patched_and_comparable():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        dataset = tmp / 'tasks.jsonl'
        dataset.write_text(json.dumps({"id":"X--3","web_name":"X","web":"https://x","ques":"q"}) + "\n")
        patches = tmp / 'patches.json'
        patches.write_text(json.dumps({
            "schema_version":"1","dataset_sha":"test","generated_date":"2026-05-14",
            "patches":{"X--3":{"action":"remove","rationale":"r"}}
        }))
        out_patched = tmp / 'patched.jsonl'
        out_comp = tmp / 'comparable.jsonl'
        subprocess.run(['python3', str(SCRIPT),
            '--dataset', str(dataset), '--patches', str(patches),
            '--out-patched', str(out_patched), '--out-comparable', str(out_comp)],
            check=True
        )
        assert out_patched.read_text().strip() == ''
        assert out_comp.read_text().strip() == ''

def test_substitute_find_not_present_errors():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        dataset = tmp / 'tasks.jsonl'
        dataset.write_text(json.dumps({"id":"X--4","web_name":"X","web":"https://x","ques":"text without target"}) + "\n")
        patches = tmp / 'patches.json'
        patches.write_text(json.dumps({
            "schema_version":"1","dataset_sha":"test","generated_date":"2026-05-14",
            "patches":{"X--4":{"action":"substitute","field":"ques","find":"NOT_FOUND","replace":"X","rationale":"r"}}
        }))
        result = subprocess.run(['python3', str(SCRIPT),
            '--dataset', str(dataset), '--patches', str(patches),
            '--out-patched', str(tmp/'p.jsonl'), '--out-comparable', str(tmp/'c.jsonl')],
            capture_output=True, text=True
        )
        assert result.returncode != 0
        assert 'NOT_FOUND' in result.stderr or 'find' in result.stderr.lower()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m pytest test/unit/bench/test_apply_patches.py -v
```
Expected: FAIL with "No such file or directory: apply-patches.py" or "FileNotFoundError".

- [ ] **Step 3: Implement apply-patches.py**

```python
#!/usr/bin/env python3
"""Apply WebVoyager patches.json to a tasks.jsonl, emitting two output files.

patched-2026:    tasks with `substitute` actions applied; tasks with `remove` action dropped.
comparable-original: tasks NOT mentioned in patches (the unpatched, still-valid subset).
"""
import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', required=True, type=Path)
    ap.add_argument('--patches', required=True, type=Path)
    ap.add_argument('--out-patched', required=True, type=Path)
    ap.add_argument('--out-comparable', required=True, type=Path)
    args = ap.parse_args()

    with args.patches.open() as f:
        patches_doc = json.load(f)
    patches = patches_doc.get('patches', {})

    patched_lines: list[str] = []
    comparable_lines: list[str] = []

    with args.dataset.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            task = json.loads(line)
            tid = task.get('id')
            patch = patches.get(tid)
            if patch is None:
                # Not in patches: both sets get the unmodified task
                patched_lines.append(json.dumps(task))
                comparable_lines.append(json.dumps(task))
                continue
            action = patch.get('action')
            if action == 'remove':
                # Dropped from both sets
                continue
            if action == 'substitute':
                field = patch['field']
                find = patch['find']
                replace = patch['replace']
                value = task.get(field, '')
                if find not in value:
                    print(f"ERROR: task {tid} field={field}: 'find' string not present: {find!r}", file=sys.stderr)
                    return 2
                task[field] = value.replace(find, replace, 1)
                patched_lines.append(json.dumps(task))
                # NOT added to comparable (it's a patched task)
                continue
            print(f"ERROR: task {tid}: unknown action {action!r}", file=sys.stderr)
            return 2

    args.out_patched.write_text('\n'.join(patched_lines) + ('\n' if patched_lines else ''))
    args.out_comparable.write_text('\n'.join(comparable_lines) + ('\n' if comparable_lines else ''))
    print(f"Wrote {len(patched_lines)} patched-2026 tasks, {len(comparable_lines)} comparable-original tasks")
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

```bash
chmod +x bench/webvoyager/apply-patches.py
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
python3 -m pytest test/unit/bench/test_apply_patches.py -v
```
Expected: 3 passed.

- [ ] **Step 5: Smoke against real dataset + patches**

```bash
python3 bench/webvoyager/apply-patches.py \
  --dataset bench/webvoyager/data/data/WebVoyager_data.jsonl \
  --patches bench/webvoyager/patches.json \
  --out-patched bench/webvoyager/data/patched-2026.jsonl \
  --out-comparable bench/webvoyager/data/comparable-original.jsonl
wc -l bench/webvoyager/data/patched-2026.jsonl bench/webvoyager/data/comparable-original.jsonl
```
Expected: patched-2026 ≈ 600 tasks (643 minus removals); comparable-original ≈ 500 tasks (the unpatched subset).

- [ ] **Step 6: Commit**

```bash
git add bench/webvoyager/apply-patches.py test/unit/bench/test_apply_patches.py bench/webvoyager/data/patched-2026.jsonl bench/webvoyager/data/comparable-original.jsonl
git commit -m "feat(bench): apply-patches.py emits patched-2026 + comparable-original sets"
```

---

### Task 3: run-bench.sh wrapper with --patched / --comparable modes

**Files:**
- Create: `bench/webvoyager/run-bench.sh`
- Create: `bench/webvoyager/README.md`

- [ ] **Step 1: Write run-bench.sh**

```bash
#!/usr/bin/env bash
# Top-level WebVoyager bench runner.
# Selects the task set (patched-2026 or comparable-original), then loops run-one-task.sh.
set -euo pipefail

MODE=""; RUNS=1; OUT_DIR=""; CONCURRENCY=4; LIMIT=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --patched)     MODE="patched";     shift ;;
    --comparable)  MODE="comparable";  shift ;;
    --runs)        RUNS="$2";          shift 2 ;;
    --out-dir)     OUT_DIR="$2";       shift 2 ;;
    --concurrency) CONCURRENCY="$2";   shift 2 ;;
    --limit)       LIMIT="$2";         shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
[[ -z "$MODE" ]] && { echo "usage: $0 --patched|--comparable [--runs N] [--out-dir DIR] [--concurrency N] [--limit N]" >&2; exit 2; }

REPO_ROOT="/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
case "$MODE" in
  patched)    DATASET="$REPO_ROOT/bench/webvoyager/data/patched-2026.jsonl"; VARIANT_TAG="v0.1.35-patched-2026" ;;
  comparable) DATASET="$REPO_ROOT/bench/webvoyager/data/comparable-original.jsonl"; VARIANT_TAG="v0.1.35-comparable-original" ;;
esac
[[ -f "$DATASET" ]] || { echo "dataset not found: $DATASET — run apply-patches.py first" >&2; exit 2; }

OUT_DIR="${OUT_DIR:-/tmp/wv-runs-${MODE}-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"
echo "Mode: $MODE" "·" "Runs: $RUNS" "·" "OutDir: $OUT_DIR" "·" "Concurrency: $CONCURRENCY"

# Build task ID list
TASK_IDS=$(python3 -c "
import json, sys
n=0
for line in open('$DATASET'):
    line=line.strip()
    if not line: continue
    print(json.loads(line)['id'])
    n+=1
    if '$LIMIT' and n>=int('$LIMIT'): break
")

# Loop over tasks × runs with bounded concurrency
JOBS=()
for tid in $TASK_IDS; do
  for ((r=1; r<=RUNS; r++)); do
    while [[ $(jobs -r | wc -l) -ge $CONCURRENCY ]]; do sleep 0.5; done
    WV_OUT_DIR="$OUT_DIR" WV_VARIANT="$VARIANT_TAG" WV_RUN_SEQ="$r" \
      bash "$REPO_ROOT/bench/webvoyager/run-one-task.sh" "$tid" &
  done
done
wait
echo "Bench complete. Out: $OUT_DIR"
```

```bash
chmod +x bench/webvoyager/run-bench.sh
```

- [ ] **Step 2: Pass WV_RUN_SEQ through run-one-task.sh**

Edit `bench/webvoyager/run-one-task.sh` lines 22-25:
```bash
RUN_SEQ="${WV_RUN_SEQ:-1}"
SCREENSHOT="/tmp/wv-AGENT-${SAFE_ID}-r${RUN_SEQ}.png"
SCORE_FILE="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.score.json"
TRANSCRIPT="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.transcript.txt"
STREAM_JSONL="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.stream.jsonl"
PRETTY_LOG="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.pretty.log"
```
(Replace `-r1` literals with `-r${RUN_SEQ}`.)

- [ ] **Step 3: Write README.md**

```markdown
# WebVoyager Bench Protocol — v0.1.35

## Sets

| Set | File | Purpose |
|---|---|---|
| `patched-2026` | `data/patched-2026.jsonl` | Stale-dated tasks substituted, impossible tasks removed. ~600 tasks. PRIMARY ship metric. |
| `comparable-original` | `data/comparable-original.jsonl` | Original tasks that are still valid in 2026 (subset of 643). ~500 tasks. Anti-regression baseline. |

## Patches

`patches.json` defines per-task substitutions and removals. See `AUDIT.md` for per-task rationale. Regenerate the two `.jsonl` outputs when patches.json changes:

```bash
python3 bench/webvoyager/apply-patches.py \
  --dataset bench/webvoyager/data/data/WebVoyager_data.jsonl \
  --patches bench/webvoyager/patches.json \
  --out-patched bench/webvoyager/data/patched-2026.jsonl \
  --out-comparable bench/webvoyager/data/comparable-original.jsonl
```

## Running the bench

```bash
# Single-run dev loop:
bash bench/webvoyager/run-bench.sh --patched --concurrency 4 --limit 20

# Ship gate (multi-run majority):
bash bench/webvoyager/run-bench.sh --patched    --runs 3 --concurrency 4
bash bench/webvoyager/run-bench.sh --comparable --runs 3 --concurrency 4
```

Output goes to `/tmp/wv-runs-<mode>-<timestamp>/` per (task × run-seq).

## Scoring

```bash
npx tsx bench/webvoyager/score.ts --in /tmp/wv-runs-patched-... --runs 3
```

Reports: Pass@1 (majority-of-N), median steps, median wall, total $.
```

- [ ] **Step 4: Smoke against a 2-task limit**

```bash
bash bench/webvoyager/run-bench.sh --comparable --concurrency 1 --limit 2 --runs 1
```
Expected: 2 task runs complete; `*-r1.score.json` files exist.

- [ ] **Step 5: Commit**

```bash
git add bench/webvoyager/run-bench.sh bench/webvoyager/run-one-task.sh bench/webvoyager/README.md
git commit -m "feat(bench): run-bench.sh wrapper with --patched/--comparable + multi-run support"
```

---

### Task 4: Multi-run majority verdict aggregation in judge.ts + score.ts

**Files:**
- Modify: `bench/webvoyager/judge.ts`
- Modify: `bench/webvoyager/score.ts`
- Create: `test/unit/bench/judge-majority.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/bench/judge-majority.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateMajorityVerdict } from '../../../bench/webvoyager/judge.js';
import type { JudgeVerdict } from '../../../bench/webvoyager/types.js';

describe('aggregateMajorityVerdict', () => {
  it('returns SUCCESS when 2 of 3 runs are SUCCESS', () => {
    const result = aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS', 'SUCCESS', 'FAILURE']);
    expect(result).toBe('SUCCESS');
  });

  it('returns FAILURE when 2 of 3 runs are FAILURE', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['FAILURE', 'FAILURE', 'SUCCESS'])).toBe('FAILURE');
  });

  it('returns UNKNOWN when no majority', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS', 'FAILURE', 'UNKNOWN'])).toBe('UNKNOWN');
  });

  it('handles single-run input by returning the only verdict', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS'])).toBe('SUCCESS');
  });

  it('handles 5-run input with 3 SUCCESS', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILURE', 'FAILURE'])).toBe('SUCCESS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/bench/judge-majority.test.ts
```
Expected: FAIL with "aggregateMajorityVerdict is not a function".

- [ ] **Step 3: Implement aggregateMajorityVerdict in judge.ts**

Append to `bench/webvoyager/judge.ts`:
```typescript
/**
 * Majority-of-N verdict aggregator.
 * Returns the verdict with the strict majority of votes, or UNKNOWN if no majority exists.
 */
export function aggregateMajorityVerdict<T extends string>(verdicts: readonly T[]): T | 'UNKNOWN' {
  if (verdicts.length === 0) return 'UNKNOWN' as T | 'UNKNOWN';
  const counts = new Map<T, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
  const half = verdicts.length / 2;
  for (const [v, n] of counts) {
    if (n > half) return v;
  }
  return 'UNKNOWN' as T | 'UNKNOWN';
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/unit/bench/judge-majority.test.ts
```
Expected: 5 passed.

- [ ] **Step 5: Wire majority aggregation into score.ts**

Edit `bench/webvoyager/score.ts`. Add a CLI flag `--runs N` and a `--in` flag pointing at a runs directory. When `runs > 1`, group score files by `task_id` (strip `-rN.score.json` suffix), pull every run's verdict, call `aggregateMajorityVerdict`, then compute aggregate metrics on the majority-verdict-collapsed task list.

```typescript
// score.ts additions (above main()):
import { aggregateMajorityVerdict } from './judge.js';

interface RunScore {
  task_id: string;
  run_seq: number;
  verdict: JudgeVerdict;
  wall_ms: number;
  cost_usd?: number;
  step_count?: number;
}

export function collapseMajority(runs: RunScore[]): {
  task_id: string;
  verdict: JudgeVerdict | 'UNKNOWN';
  median_wall_ms: number;
  median_steps: number;
  total_cost_usd: number;
}[] {
  const byTask = new Map<string, RunScore[]>();
  for (const r of runs) {
    const arr = byTask.get(r.task_id) ?? [];
    arr.push(r);
    byTask.set(r.task_id, arr);
  }
  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return Array.from(byTask.entries()).map(([task_id, rs]) => ({
    task_id,
    verdict: aggregateMajorityVerdict(rs.map(r => r.verdict)),
    median_wall_ms: median(rs.map(r => r.wall_ms)),
    median_steps: median(rs.map(r => r.step_count ?? 0)),
    total_cost_usd: rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
  }));
}
```

- [ ] **Step 6: Smoke score.ts against the 2-task smoke from Task 3**

```bash
npx tsx bench/webvoyager/score.ts --in /tmp/wv-runs-comparable-... --runs 1
```
Expected: report prints with Pass@1, median steps, median wall, total $.

- [ ] **Step 7: Commit**

```bash
git add bench/webvoyager/judge.ts bench/webvoyager/score.ts test/unit/bench/judge-majority.test.ts
git commit -m "feat(bench): aggregateMajorityVerdict + collapseMajority + dual-metric report"
```

---

### Task 5: Anti-thrash — loop-detector + thrash-detector + hard caps

**Files:**
- Create: `src/security/loop-detector.ts`
- Modify: `src/server.ts` (wire detector into pre-execution)
- Modify: `src/errors.ts` (add LOOP_DETECTED + THRASH_DETECTED + STEP_CAP_EXCEEDED + WALL_CAP_EXCEEDED codes)
- Modify: `bench/webvoyager/run-one-task.sh` (export MAX_TURNS + MAX_WALL_MS)
- Create: `test/e2e/anti-thrash.test.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/e2e/anti-thrash.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer } from '../helpers/fixture-server.js';

let client: McpTestClient;
let serverUrl: string;

beforeAll(async () => {
  serverUrl = await startFixtureServer();
  client = new McpTestClient();
  await client.start();
});
afterAll(async () => {
  await client.stop();
  await stopFixtureServer();
});

describe('loop-detector', () => {
  it('returns LOOP_DETECTED after 5 identical (tool, key-args) calls', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${serverUrl}/blank` });
    const tabId = tab.metadata.tab_id;
    let lastError: any = null;
    for (let i = 0; i < 6; i++) {
      const r = await client.callTool('safari_get_text', { tabUrl: `${serverUrl}/blank`, locator: { selector: '#nope' } });
      if (r.isError) lastError = r;
    }
    expect(lastError?.metadata?.error_code).toBe('LOOP_DETECTED');
    await client.callTool('safari_close_tab', { tabId });
  }, 60_000);

  it('returns THRASH_DETECTED after 4 identical snapshot results', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${serverUrl}/static` });
    const tabId = tab.metadata.tab_id;
    let lastError: any = null;
    for (let i = 0; i < 5; i++) {
      const r = await client.callTool('safari_snapshot', { tabUrl: `${serverUrl}/static` });
      if (r.isError) lastError = r;
    }
    expect(lastError?.metadata?.error_code).toBe('THRASH_DETECTED');
    await client.callTool('safari_close_tab', { tabId });
  }, 60_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/e2e/anti-thrash.test.ts
```
Expected: FAIL with no LOOP_DETECTED error code.

- [ ] **Step 3: Add error codes**

Edit `src/errors.ts`. Add to `ERROR_CODES`:
```typescript
LOOP_DETECTED: 'LOOP_DETECTED',
THRASH_DETECTED: 'THRASH_DETECTED',
STEP_CAP_EXCEEDED: 'STEP_CAP_EXCEEDED',
WALL_CAP_EXCEEDED: 'WALL_CAP_EXCEEDED',
```
Add to `ERROR_METADATA`:
```typescript
[ERROR_CODES.LOOP_DETECTED]: { retryable: false, hints: ['Same (tool, key-args) called 5+ times in a row. The page state is not changing — try a different approach.'] },
[ERROR_CODES.THRASH_DETECTED]: { retryable: false, hints: ['safari_snapshot returned identical content 4+ times. The page is not loading new state — check for stale-data or rate-limit indicators.'] },
[ERROR_CODES.STEP_CAP_EXCEEDED]: { retryable: false, hints: ['Session step cap reached. Abort and report inability to complete.'] },
[ERROR_CODES.WALL_CAP_EXCEEDED]: { retryable: false, hints: ['Session wall-clock cap reached. Abort and report inability to complete.'] },
```

- [ ] **Step 4: Implement loop-detector.ts**

```typescript
// src/security/loop-detector.ts
import { SafariPilotError, ERROR_CODES } from '../errors.js';

const LOOP_THRESHOLD = 5;
const THRASH_THRESHOLD = 4;

export interface CallRecord {
  tool: string;
  keyArgs: string;
}

export class LoopDetector {
  private callHistory: CallRecord[] = [];
  private snapshotResultHistory: string[] = [];

  preCheck(tool: string, params: Record<string, unknown>): void {
    const keyArgs = this.extractKeyArgs(tool, params);
    this.callHistory.push({ tool, keyArgs });
    if (this.callHistory.length > LOOP_THRESHOLD) this.callHistory.shift();
    if (this.callHistory.length === LOOP_THRESHOLD) {
      const allEqual = this.callHistory.every(c => c.tool === tool && c.keyArgs === keyArgs);
      if (allEqual) {
        throw new SafariPilotError(
          `Loop detected: ${tool} called ${LOOP_THRESHOLD} times with the same arguments`,
          ERROR_CODES.LOOP_DETECTED,
        );
      }
    }
  }

  recordSnapshotResult(serializedResult: string): void {
    this.snapshotResultHistory.push(serializedResult);
    if (this.snapshotResultHistory.length > THRASH_THRESHOLD) this.snapshotResultHistory.shift();
    if (this.snapshotResultHistory.length === THRASH_THRESHOLD) {
      const allEqual = this.snapshotResultHistory.every(r => r === serializedResult);
      if (allEqual) {
        throw new SafariPilotError(
          `Thrash detected: safari_snapshot returned identical content ${THRASH_THRESHOLD} times`,
          ERROR_CODES.THRASH_DETECTED,
        );
      }
    }
  }

  reset(): void {
    this.callHistory = [];
    this.snapshotResultHistory = [];
  }

  private extractKeyArgs(tool: string, params: Record<string, unknown>): string {
    // Hash on (tabUrl + locator.selector|locator.text|tabId). Excludes ephemeral fields like timeout.
    const tabUrl = params.tabUrl ?? params.tabId ?? '';
    const locator = params.locator as Record<string, unknown> | undefined;
    const selector = locator?.selector ?? locator?.text ?? locator?.role ?? '';
    return JSON.stringify({ tabUrl, selector });
  }
}
```

- [ ] **Step 5: Wire LoopDetector into server.ts**

Find `executeToolWithSecurity` in `src/server.ts`. Add a per-server `LoopDetector` instance (one per session, not per call). Insert detector check after KillSwitch (Layer 1):
```typescript
// Pre-execution Layer 6.5 (after RateLimiter, before CircuitBreaker):
this.loopDetector.preCheck(toolName, params as Record<string, unknown>);
```
For `safari_snapshot` post-execution, after the result is computed, call `this.loopDetector.recordSnapshotResult(JSON.stringify(result.value))`. Reset on `safari_health_check` (signal of session restart).

- [ ] **Step 6: Pass MAX_TURNS + MAX_WALL_MS through harness**

Edit `bench/webvoyager/run-one-task.sh`. After the `claude` invocation block, add env exports:
```bash
export MAX_TURNS="${MAX_TURNS:-25}"
export MAX_WALL_MS="${MAX_WALL_MS:-1200000}"  # 20 min
```
Pass to claude --bare via env. (Caps are wired into MCP tools through the loop-detector for now; harness-level caps via claude flag are a separate consideration if claude supports `--max-turns`.)

- [ ] **Step 7: Build and run e2e**

```bash
npm run build
npx vitest run test/e2e/anti-thrash.test.ts
```
Expected: 2 passed.

- [ ] **Step 8: Commit**

```bash
git add src/security/loop-detector.ts src/server.ts src/errors.ts bench/webvoyager/run-one-task.sh test/e2e/anti-thrash.test.ts
git commit -m "feat(security): loop-detector + thrash-detector + hard caps via env"
```

---

### Task 6: 4-nudge unwind — soften tool descriptions + introduce 'preferred' CSP routing

**Files:**
- Modify: `src/tools/page-info.ts` (3 tool descriptions)
- Modify: `src/tools/extraction.ts` (safari_evaluate description; CSP_BLOCKED hint)
- Modify: `src/tools/interaction.ts` (downgrade `requiresCspBypass: true` → `'preferred'` on tools with AppleScript fallback)
- Modify: `src/types.ts` (add `'preferred'` value)
- Modify: `src/engine-selector.ts` (handle 'preferred')
- Create: `test/e2e/csp-error-softened.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/e2e/csp-error-softened.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer } from '../helpers/fixture-server.js';

let client: McpTestClient;
let server: string;

beforeAll(async () => {
  server = await startFixtureServer();
  client = new McpTestClient();
  await client.start();
});
afterAll(async () => { await client.stop(); await stopFixtureServer(); });

describe('CSP_BLOCKED softened error UX', () => {
  it('returns informational hint without prescriptive alternative_tools list', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${server}/csp-strict` });
    const tabId = tab.metadata.tab_id;
    const result = await client.callTool('safari_evaluate', {
      tabUrl: `${server}/csp-strict`,
      script: 'document.title',
    });
    expect(result.isError).toBe(true);
    expect(result.metadata?.error_code).toMatch(/CSP_BLOCKED|CSP_HARD_BLOCK/);
    expect(result.metadata?.hint?.alternative_tools).toBeUndefined();
    expect(result.metadata?.hint?.fallback_available).toBe(true);
    expect(result.metadata?.hint?.note).toMatch(/CSP/);
    await client.callTool('safari_close_tab', { tabId });
  }, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/e2e/csp-error-softened.test.ts
```
Expected: FAIL — current error has `alternative_tools` array.

- [ ] **Step 3: Soften the 3 page-info tool descriptions**

Edit `src/tools/page-info.ts`. For each of `safari_get_page_info`, `safari_get_meta_tags`, `safari_extract_text_window`, find the description string and replace any `Use in place of safari_evaluate` clause with `Returns structured data via dedicated handlers. Available alongside safari_evaluate.` (or remove if it doesn't fit).

- [ ] **Step 4: Soften the safari_evaluate description**

Edit `src/tools/extraction.ts`. Find the `safari_evaluate` ToolDefinition's description. Remove "prefer safari_get_text, safari_extract_tables, or safari_query_all". Replace with: "Run an arbitrary JavaScript expression in the page context. Returns the expression's value via JSON serialization."

- [ ] **Step 5: Soften CSP_BLOCKED hint shape**

Find `handleEvaluate` in `src/tools/extraction.ts`. Where the CSP_BLOCKED / CSP_HARD_BLOCK error is constructed, change `hint.alternative_tools: [...]` to:
```typescript
hint: {
  fallback_available: true,
  note: 'This script could not run because the page enforces a CSP that disallows eval() or string-to-script.',
  cspMode,
}
```

- [ ] **Step 6: Add 'preferred' value to types**

Edit `src/types.ts`. Find the `ToolRequirements` type definition. Change:
```typescript
requiresCspBypass?: boolean;
```
to:
```typescript
requiresCspBypass?: boolean | 'preferred';
```

- [ ] **Step 7: Handle 'preferred' in engine-selector**

Edit `src/engine-selector.ts`. In `selectEngine()`, where `requiresCspBypass: true` is handled (forces Extension or throws `EngineUnavailableError`), add a branch:
```typescript
if (requirements.requiresCspBypass === 'preferred') {
  // Try Extension first; if unavailable, fall back to AppleScript with metadata.
  if (extensionAvailable) return { engine: 'extension', degraded: false };
  return { engine: 'applescript', degraded: true, degradedReason: 'extension_unavailable_csp_preferred' };
}
```

- [ ] **Step 8: Downgrade tools that have AppleScript fallback paths**

Edit `src/tools/interaction.ts`. For `safari_click`, `safari_fill`, `safari_type`, `safari_scroll` — change `requiresCspBypass: true` → `requiresCspBypass: 'preferred'`. KEEP `true` for `safari_get_text`, `safari_get_html`, `safari_get_attribute` in `extraction.ts` (these route through `buildLocatorSentinel` which has no AppleScript fallback).

- [ ] **Step 9: Build and run the new test**

```bash
npm run build
npx vitest run test/e2e/csp-error-softened.test.ts
```
Expected: 1 passed.

- [ ] **Step 10: Run the full e2e suite for regression check**

```bash
npx vitest run test/e2e/
```
Expected: all pre-existing tests still pass (no regressions in CSP-related or interaction-related coverage).

- [ ] **Step 11: Commit**

```bash
git add src/tools/page-info.ts src/tools/extraction.ts src/tools/interaction.ts src/types.ts src/engine-selector.ts test/e2e/csp-error-softened.test.ts
git commit -m "feat(tools): soften 4-nudge stack against safari_evaluate; add 'preferred' CSP routing"
```

---

### Task 7: Final-proof tool — safari_compose_final_evidence

**Files:**
- Create: `src/tools/final-proof.ts`
- Modify: `src/server.ts` (register module)
- Modify: `extension/content-main.js` (add `__SP_COMPOSE_FINAL_EVIDENCE__` sentinel)
- Modify: `package.json` + `extension/manifest.json` (bump to `0.1.35-dev.1`)
- Create: `test/e2e/final-proof.test.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/e2e/final-proof.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer } from '../helpers/fixture-server.js';

let client: McpTestClient;
let server: string;

beforeAll(async () => {
  server = await startFixtureServer();
  client = new McpTestClient();
  await client.start();
});
afterAll(async () => { await client.stop(); await stopFixtureServer(); });

describe('safari_compose_final_evidence', () => {
  it('captures screenshot + DOM snippet for a claim grounded in page content', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${server}/with-claim` });
    const tabId = tab.metadata.tab_id;
    const result = await client.callTool('safari_compose_final_evidence', {
      tabUrl: `${server}/with-claim`,
      claim: 'The recipe has 4.5 stars and 563 ratings',
      evidence_locator: { selector: '#rating-block' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.metadata?.screenshot_path).toBeTruthy();
    expect(existsSync(result.metadata!.screenshot_path)).toBe(true);
    expect(result.metadata?.dom_snippet).toMatch(/4\.5/);
    expect(result.metadata?.claim_grounded).toBe(true);
    await client.callTool('safari_close_tab', { tabId });
  }, 60_000);

  it('reports claim_grounded:false when claim text not found in DOM', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${server}/with-claim` });
    const tabId = tab.metadata.tab_id;
    const result = await client.callTool('safari_compose_final_evidence', {
      tabUrl: `${server}/with-claim`,
      claim: 'The recipe has 9.9 stars',
      evidence_locator: { selector: '#rating-block' },
    });
    expect(result.metadata?.claim_grounded).toBe(false);
    await client.callTool('safari_close_tab', { tabId });
  }, 60_000);
});
```

Add a `/with-claim` route to `test/helpers/fixture-server.ts` returning HTML with `<div id="rating-block">4.5 stars · 563 ratings</div>`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/e2e/final-proof.test.ts
```
Expected: FAIL — tool not registered.

- [ ] **Step 3: Add the sentinel handler in extension/content-main.js**

Inside the `__SP_*` switch in content-main.js, add a case:
```javascript
if (cmd.startsWith('__SP_COMPOSE_FINAL_EVIDENCE__:')) {
  const payload = JSON.parse(cmd.slice('__SP_COMPOSE_FINAL_EVIDENCE__:'.length));
  const { claim, locator } = payload;
  let element = null;
  if (locator) {
    element = window.__SP_LOCATOR__.resolveLocator(locator);
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'instant', block: 'center' });
    }
  }
  const dom_snippet = element ? element.outerHTML.slice(0, 2000) : document.body.innerText.slice(0, 2000);
  const claim_grounded = dom_snippet.includes(claim) ||
    (typeof claim === 'string' && claim.split(/\s+/).filter(w => w.length > 3).every(w => dom_snippet.includes(w)));
  return { ok: true, value: { dom_snippet, claim_grounded } };
}
```

- [ ] **Step 4: Implement final-proof.ts**

```typescript
// src/tools/final-proof.ts
import type { ToolDefinition, ToolHandler, ToolResponse } from '../types.js';
import { selectEngine } from '../engine-selector.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execP = promisify(exec);

export class FinalProofTools {
  getDefinitions(): ToolDefinition[] {
    return [{
      name: 'safari_compose_final_evidence',
      description:
        'Compose evidence for a claim before answering. Scrolls to the claim element (if locator given), captures a screenshot, and extracts the matching DOM snippet. Use before answering when your final response references on-page evidence — the screenshot will visually confirm your claim to a screenshot-based judge.',
      inputSchema: {
        type: 'object',
        properties: {
          tabUrl: { type: 'string' },
          claim: { type: 'string', description: 'The textual claim you intend to make in your answer.' },
          evidence_locator: {
            type: 'object',
            description: 'Optional: locator pointing to the DOM element that contains the evidence. If omitted, the full page is sampled.',
          },
        },
        required: ['tabUrl', 'claim'],
      },
      requirements: { requiresCspBypass: 'preferred' },
    }];
  }

  getHandler(_name: string): ToolHandler {
    return async (params): Promise<ToolResponse> => {
      const { tabUrl, claim, evidence_locator } = params as { tabUrl: string; claim: string; evidence_locator?: object };
      const sentinel = `__SP_COMPOSE_FINAL_EVIDENCE__:${JSON.stringify({ claim, locator: evidence_locator })}`;
      const engine = await selectEngine({ requiresCspBypass: 'preferred' });
      const evalResult = await engine.evaluate({ tabUrl, script: sentinel });
      if (!evalResult.ok) {
        return { content: [{ type: 'text', text: `final-proof failed: ${evalResult.error}` }], metadata: { isError: true } };
      }
      const { dom_snippet, claim_grounded } = evalResult.value as { dom_snippet: string; claim_grounded: boolean };
      // Capture screenshot via screencapture (already used by safari_take_screenshot)
      const dir = mkdtempSync(join(tmpdir(), 'sp-final-proof-'));
      const path = join(dir, 'evidence.png');
      await execP(`screencapture -x -t png "${path}"`);
      return {
        content: [{ type: 'text', text: `Evidence composed. Screenshot: ${path}` }],
        metadata: { screenshot_path: path, dom_snippet, claim_grounded, isError: false },
      };
    };
  }
}
```

- [ ] **Step 5: Register in server.ts**

Edit `src/server.ts`. Where other tool modules are imported and registered, add:
```typescript
import { FinalProofTools } from './tools/final-proof.js';
// ... in the constructor or registration block:
this.registerToolModule(new FinalProofTools());
```

- [ ] **Step 6: Bump versions**

Edit `package.json` `"version": "0.1.35-dev.1"`. Edit `extension/manifest.json` matching version + `version_name`.

- [ ] **Step 7: Rebuild extension + run e2e**

```bash
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"   # user must enable in Safari Settings the first time
npm run build
npx vitest run test/e2e/final-proof.test.ts
```
Expected: 2 passed.

- [ ] **Step 8: Commit**

```bash
git add src/tools/final-proof.ts src/server.ts extension/content-main.js package.json extension/manifest.json test/e2e/final-proof.test.ts test/helpers/fixture-server.ts bin/
git commit -m "feat(tools): safari_compose_final_evidence + extension sentinel + 0.1.35-dev.1"
```

---

### Task 8: Abstention policy in prompt template + judge

**Files:**
- Create: `bench/webvoyager/prompt-template.md`
- Modify: `bench/webvoyager/run-one-task.sh` (extract prompt to template file)
- Modify: `bench/webvoyager/judge.ts` (add ABSTAIN verdict + recognition)
- Modify: `bench/webvoyager/types.ts` (add 'ABSTAIN' to JudgeVerdict)
- Modify: `bench/webvoyager/score.ts` (track abstention rate per site)
- Modify: `test/unit/bench/judge-majority.test.ts` (add ABSTAIN aggregation case)

- [ ] **Step 1: Update JudgeVerdict type**

Edit `bench/webvoyager/types.ts`:
```typescript
export type JudgeVerdict = 'SUCCESS' | 'FAILURE' | 'UNKNOWN' | 'ABSTAIN';
```

- [ ] **Step 2: Extract prompt to template + add abstention guidance**

Create `bench/webvoyager/prompt-template.md`:
```markdown
You are an autonomous browser agent operating Safari via the Safari Pilot MCP server. Your task:

URL: {url}
Question: {question}

Use the safari_* tools to navigate, interact, and extract information. Provide a final textual answer that directly addresses the question.

**Before your final answer**, if your answer references specific on-page evidence (a price, a star rating, a count), call `safari_compose_final_evidence` with the claim and a locator pointing to the evidence element. This grounds your answer for the screenshot-based judge.

**Abstention:** If the task is impossible (the site rejects past dates, the requested entity doesn't exist, you're persistently rate-limited and waiting hasn't helped), respond with `ABSTAIN: <one-sentence reason>` rather than fabricating an answer. Abstentions are scored separately from successes and failures and are not penalized.

Hard limits: 25 turns, 20 minutes wall-clock. Plan accordingly.
```

In `run-one-task.sh`, replace the inline prompt construction with:
```bash
PROMPT_TEMPLATE=$(cat "$REPO_ROOT/bench/webvoyager/prompt-template.md")
PROMPT="${PROMPT_TEMPLATE//\{url\}/$URL}"
PROMPT="${PROMPT//\{question\}/$QUES}"
```

- [ ] **Step 3: Recognize ABSTAIN prefix in judge.ts**

Find the section in `judge.ts` where the agent's final text is mapped to a verdict (before/after the GPT-4o call). Add a pre-check:
```typescript
function detectAbstention(agentFinalText: string): { abstained: boolean; reason?: string } {
  const m = agentFinalText.trim().match(/^ABSTAIN:\s*(.+)/i);
  if (m) return { abstained: true, reason: m[1].trim() };
  return { abstained: false };
}
```
In the judge entry point, if `detectAbstention(agentFinalText).abstained`, return `{ verdict: 'ABSTAIN', judge_reasoning: 'Agent abstained: ' + reason }` immediately, skipping the GPT-4o call.

- [ ] **Step 4: Update aggregateMajorityVerdict for ABSTAIN**

In `bench/webvoyager/judge.ts`, the existing `aggregateMajorityVerdict` should already handle ABSTAIN as a distinct verdict (just another string). Add a test case to `test/unit/bench/judge-majority.test.ts`:
```typescript
it('returns ABSTAIN when 2 of 3 runs are ABSTAIN', () => {
  expect(aggregateMajorityVerdict<JudgeVerdict>(['ABSTAIN', 'ABSTAIN', 'FAILURE'])).toBe('ABSTAIN');
});
```

- [ ] **Step 5: Track abstention rate per site in score.ts**

Edit `bench/webvoyager/score.ts`. In the per-site aggregate computation, add an `abstention_rate` field: `abstained_count / tasks_total` per site.

- [ ] **Step 6: Run unit tests**

```bash
npx vitest run test/unit/bench/judge-majority.test.ts
```
Expected: 6 passed.

- [ ] **Step 7: Commit**

```bash
git add bench/webvoyager/prompt-template.md bench/webvoyager/run-one-task.sh bench/webvoyager/judge.ts bench/webvoyager/types.ts bench/webvoyager/score.ts test/unit/bench/judge-majority.test.ts
git commit -m "feat(bench): ABSTAIN verdict + prompt-template + per-site abstention rate"
```

---

### Task 9: Light playbooks — date normalization, cookie consent wrapper, rate-limit wait

**Files:**
- Create: `src/tools/playbooks.ts`
- Modify: `src/server.ts` (register PlaybooksTools)
- Modify: `extension/content-main.js` (add `__SP_WAIT_RATE_LIMIT_CLEAR__` sentinel)
- Create: `test/e2e/playbooks.test.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/e2e/playbooks.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer } from '../helpers/fixture-server.js';

let client: McpTestClient;
let server: string;

beforeAll(async () => {
  server = await startFixtureServer();
  client = new McpTestClient();
  await client.start();
});
afterAll(async () => { await client.stop(); await stopFixtureServer(); });

describe('safari_normalize_date', () => {
  it('parses an English date string into ISO + components', async () => {
    const r = await client.callTool('safari_normalize_date', { input: 'January 10, 2027' });
    expect(r.metadata?.iso).toBe('2027-01-10');
    expect(r.metadata?.components).toEqual({ year: 2027, month: 1, day: 10 });
  });

  it('returns isError when input is not a parseable date', async () => {
    const r = await client.callTool('safari_normalize_date', { input: 'not a date at all' });
    expect(r.metadata?.isError).toBe(true);
  });
});

describe('safari_dismiss_cookie_consent', () => {
  it('dismisses a cookie banner on a fixture page', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${server}/cookie-banner` });
    const tabId = tab.metadata.tab_id;
    const r = await client.callTool('safari_dismiss_cookie_consent', { tabUrl: `${server}/cookie-banner` });
    expect(r.metadata?.dismissed).toBe(true);
    await client.callTool('safari_close_tab', { tabId });
  }, 30_000);
});

describe('safari_wait_for_rate_limit_clear', () => {
  it('reports ready:true when no rate-limit indicator present', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${server}/blank` });
    const tabId = tab.metadata.tab_id;
    const r = await client.callTool('safari_wait_for_rate_limit_clear', { tabUrl: `${server}/blank`, max_wait_ms: 2000 });
    expect(r.metadata?.ready).toBe(true);
    expect(r.metadata?.waited_ms).toBeLessThan(2500);
    await client.callTool('safari_close_tab', { tabId });
  }, 30_000);
});
```

Add `/cookie-banner` route to `test/helpers/fixture-server.ts` with HTML containing a banner div + accept button matching the existing cookie-consent overlay JSON allowlist.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/e2e/playbooks.test.ts
```
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement playbooks.ts**

```typescript
// src/tools/playbooks.ts
import type { ToolDefinition, ToolHandler, ToolResponse } from '../types.js';
import { selectEngine } from '../engine-selector.js';
import { OverlaysTools } from './overlays.js';

export class PlaybooksTools {
  private overlays = new OverlaysTools();

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_normalize_date',
        description: 'Parse a date string into ISO format + numeric components. Pure function; no DOM access. Useful before filling date inputs.',
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
        requirements: {},
      },
      {
        name: 'safari_dismiss_cookie_consent',
        description: 'Dismiss a cookie-consent banner on the current page. Specialization of safari_dismiss_overlays restricted to the cookie-consent overlay family.',
        inputSchema: {
          type: 'object',
          properties: { tabUrl: { type: 'string' } },
          required: ['tabUrl'],
        },
        requirements: { requiresCspBypass: 'preferred' },
      },
      {
        name: 'safari_wait_for_rate_limit_clear',
        description: 'Polls the current page for HTTP 429 / rate-limit indicators. Returns when cleared OR when max_wait_ms elapses.',
        inputSchema: {
          type: 'object',
          properties: { tabUrl: { type: 'string' }, max_wait_ms: { type: 'number', default: 30000 } },
          required: ['tabUrl'],
        },
        requirements: { requiresCspBypass: 'preferred' },
      },
    ];
  }

  getHandler(name: string): ToolHandler {
    if (name === 'safari_normalize_date') return this.handleNormalizeDate.bind(this);
    if (name === 'safari_dismiss_cookie_consent') return this.handleDismissCookieConsent.bind(this);
    if (name === 'safari_wait_for_rate_limit_clear') return this.handleWaitRateLimit.bind(this);
    throw new Error(`unknown handler ${name}`);
  }

  private async handleNormalizeDate(params: { input: string }): Promise<ToolResponse> {
    const date = new Date(params.input);
    if (isNaN(date.getTime())) {
      return { content: [{ type: 'text', text: `Could not parse date: ${params.input}` }], metadata: { isError: true } };
    }
    const iso = date.toISOString().split('T')[0];
    return {
      content: [{ type: 'text', text: iso }],
      metadata: {
        iso,
        components: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
        isError: false,
      },
    };
  }

  private async handleDismissCookieConsent(params: { tabUrl: string }): Promise<ToolResponse> {
    // Delegate to the existing overlays tool with a 'cookie-consent' filter (overlays.ts accepts a category param).
    const overlaysHandler = this.overlays.getHandler('safari_dismiss_overlays');
    const result = await overlaysHandler({ tabUrl: params.tabUrl, categories: ['cookie-consent'] });
    return {
      content: result.content,
      metadata: {
        dismissed: !result.metadata?.isError && (result.metadata as Record<string, unknown> | undefined)?.dismissed_count !== 0,
        banner_type: 'cookie-consent',
        isError: result.metadata?.isError ?? false,
      },
    };
  }

  private async handleWaitRateLimit(params: { tabUrl: string; max_wait_ms?: number }): Promise<ToolResponse> {
    const max = params.max_wait_ms ?? 30000;
    const start = Date.now();
    const engine = await selectEngine({ requiresCspBypass: 'preferred' });
    while (Date.now() - start < max) {
      const sentinel = '__SP_WAIT_RATE_LIMIT_CLEAR__:{}';
      const res = await engine.evaluate({ tabUrl: params.tabUrl, script: sentinel });
      if (res.ok && (res.value as { rate_limited: boolean }).rate_limited === false) {
        return {
          content: [{ type: 'text', text: 'rate limit clear' }],
          metadata: { ready: true, waited_ms: Date.now() - start, isError: false },
        };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return {
      content: [{ type: 'text', text: 'rate limit not cleared in time' }],
      metadata: { ready: false, waited_ms: Date.now() - start, isError: false },
    };
  }
}
```

- [ ] **Step 4: Add the rate-limit detection sentinel in extension/content-main.js**

```javascript
if (cmd.startsWith('__SP_WAIT_RATE_LIMIT_CLEAR__:')) {
  const text = (document.body.innerText || '').toLowerCase();
  const indicators = ['rate limit', '429', 'too many requests', 'try again later'];
  const rate_limited = indicators.some(i => text.includes(i));
  return { ok: true, value: { rate_limited } };
}
```

- [ ] **Step 5: Register in server.ts**

```typescript
import { PlaybooksTools } from './tools/playbooks.js';
this.registerToolModule(new PlaybooksTools());
```

- [ ] **Step 6: Rebuild extension + run e2e**

```bash
# Bump to 0.1.35-dev.2 first per the version-both-fields rule
# package.json + extension/manifest.json: 0.1.35-dev.2
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
npm run build
npx vitest run test/e2e/playbooks.test.ts
```
Expected: 4 passed.

- [ ] **Step 7: Commit**

```bash
git add src/tools/playbooks.ts src/server.ts extension/content-main.js package.json extension/manifest.json test/e2e/playbooks.test.ts test/helpers/fixture-server.ts bin/
git commit -m "feat(tools): safari_normalize_date + safari_dismiss_cookie_consent + safari_wait_for_rate_limit_clear"
```

---

### Task 10: query_all interactivity hints

**Files:**
- Modify: `extension/locator.js` (`resolveLocatorAll` adds `interactability`)
- Modify: `src/locator.ts` (mirror behavior for AppleScript fallback path; type update)
- Modify: `test/unit/locators/drift-detector.test.ts` (cover new fields)
- Create: `test/e2e/query-all-interactivity.test.ts`

- [ ] **Step 1: Write the failing e2e test**

```typescript
// test/e2e/query-all-interactivity.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer } from '../helpers/fixture-server.js';

let client: McpTestClient;
let server: string;

beforeAll(async () => {
  server = await startFixtureServer();
  client = new McpTestClient();
  await client.start();
});
afterAll(async () => { await client.stop(); await stopFixtureServer(); });

describe('safari_query_all interactivity hints', () => {
  it('returns clickable/fillable/visible/role/accessibleName for buttons + inputs', async () => {
    const tab = await client.callTool('safari_new_tab', { url: `${server}/interactivity` });
    const tabId = tab.metadata.tab_id;
    const r = await client.callTool('safari_query_all', { tabUrl: `${server}/interactivity`, locator: { selector: 'button, input' } });
    const elements = (r.metadata as Record<string, unknown>).elements as Array<Record<string, unknown>>;
    expect(elements.length).toBeGreaterThan(0);
    const submit = elements.find((e: any) => e.interactability?.role === 'button');
    expect(submit?.interactability?.clickable).toBe(true);
    expect(submit?.interactability?.isVisible).toBe(true);
    const disabled = elements.find((e: any) => e.interactability?.isAriaDisabled === true);
    expect(disabled?.interactability?.clickable).toBe(false);
    await client.callTool('safari_close_tab', { tabId });
  }, 30_000);
});
```

Add `/interactivity` route to `test/helpers/fixture-server.ts` with `<button>Click me</button> <button disabled aria-disabled="true">No</button> <input type="text" />`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/e2e/query-all-interactivity.test.ts
```
Expected: FAIL — `interactability` field undefined.

- [ ] **Step 3: Add interactability builder in extension/locator.js**

In `extension/locator.js`, find `resolveLocatorAll` (or `buildSnapshot` if shared). Wrap each returned element shape with:
```javascript
function buildInteractability(el) {
  if (!(el instanceof Element)) return null;
  const tag = el.tagName.toLowerCase();
  const aria = (n) => el.getAttribute(n);
  const isDisabled = el.hasAttribute('disabled') || aria('aria-disabled') === 'true';
  const role = aria('role') || (tag === 'button' ? 'button' : tag === 'input' ? 'textbox' : tag === 'a' ? 'link' : null);
  const accessibleName = aria('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.textContent?.trim().slice(0, 100) || null;
  const rect = el.getBoundingClientRect();
  const isVisible = rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  // isCovered: simple heuristic — pick the element at rect center; if it's not us or our descendant, we're covered.
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const isCovered = top != null && top !== el && !el.contains(top);
  return {
    clickable: !isDisabled && (role === 'button' || role === 'link' || tag === 'button' || tag === 'a'),
    fillable: !isDisabled && (role === 'textbox' || tag === 'input' || tag === 'textarea'),
    focusable: !isDisabled && el.tabIndex >= 0,
    role,
    accessibleName,
    isVisible,
    boundingBox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    isCovered,
    isAriaDisabled: aria('aria-disabled') === 'true',
  };
}
```

In the resolveLocatorAll return loop, attach `interactability: buildInteractability(el)` to each element record.

- [ ] **Step 4: Mirror minimal behavior in src/locator.ts (AppleScript fallback)**

The AppleScript fallback returns minimal shapes. Add an `interactability: null` field so consumers can rely on the field's presence (and detect "we're in degraded mode") without crashing.

In `src/locator.ts`, find where the AppleScript fallback emits per-element records. Add `interactability: null,` to each.

- [ ] **Step 5: Update drift-detector**

Edit `test/unit/locators/drift-detector.test.ts`. Add a new assertion verifying both `extension/locator.js`'s resolveLocatorAll and `src/locator.ts`'s fallback return objects with an `interactability` key. The extension's value should be a structured object; the AppleScript fallback's may be `null`.

- [ ] **Step 6: Bump version + rebuild + run tests**

```bash
# 0.1.35-dev.3
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
npm run build
npx vitest run test/unit/locators/drift-detector.test.ts test/e2e/query-all-interactivity.test.ts
```
Expected: drift-detector PASS; query-all-interactivity 1 passed.

- [ ] **Step 7: Commit**

```bash
git add extension/locator.js src/locator.ts test/unit/locators/drift-detector.test.ts test/e2e/query-all-interactivity.test.ts test/helpers/fixture-server.ts package.json extension/manifest.json bin/
git commit -m "feat(locators): query_all interactivity hints (clickable/fillable/role/accessibleName/visible/covered)"
```

---

### Task 11: Eval-contamination audit script

**Files:**
- Create: `bench/webvoyager/audit-contamination.py`
- Create: `test/unit/bench/test_audit_contamination.py`

- [ ] **Step 1: Write the failing test**

```python
# test/unit/bench/test_audit_contamination.py
import json
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / 'bench/webvoyager/audit-contamination.py'

def test_clean_traces_pass():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        run_dir = tmp / 'runs'; run_dir.mkdir()
        trace = run_dir / 'X--1-r1.stream.jsonl'
        trace.write_text(json.dumps({"type":"tool_use","name":"safari_navigate","input":{"url":"https://example.com"}}) + "\n")
        result = subprocess.run(['python3', str(SCRIPT), '--in', str(run_dir)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr

def test_webvoyager_search_term_fails():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        run_dir = tmp / 'runs'; run_dir.mkdir()
        trace = run_dir / 'X--1-r1.stream.jsonl'
        trace.write_text(json.dumps({"type":"tool_use","name":"safari_navigate","input":{"url":"https://google.com/search?q=WebVoyager+benchmark+answer+key"}}) + "\n")
        result = subprocess.run(['python3', str(SCRIPT), '--in', str(run_dir)], capture_output=True, text=True)
        assert result.returncode != 0
        assert 'WebVoyager' in result.stdout or 'WebVoyager' in result.stderr
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
python3 -m pytest test/unit/bench/test_audit_contamination.py -v
```
Expected: FAIL — script does not exist.

- [ ] **Step 3: Implement audit-contamination.py**

```python
#!/usr/bin/env python3
"""Scan WebVoyager bench traces for benchmark-contamination signals."""
import argparse
import json
import re
import sys
from pathlib import Path

CONTAMINATION_PATTERNS = [
    r'WebVoyager',
    r'MinorJerry',
    r'WebVoyager_data\.jsonl',
    r'webvoyager.*answer',
    r'web.?voyager.*solution',
]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='in_dir', required=True, type=Path)
    args = ap.parse_args()
    hits: list[tuple[str, str, str]] = []  # (file, pattern, snippet)
    for path in sorted(args.in_dir.glob('*.stream.jsonl')):
        for ln, line in enumerate(path.open()):
            for pat in CONTAMINATION_PATTERNS:
                m = re.search(pat, line, re.IGNORECASE)
                if m:
                    hits.append((path.name, pat, line[:200].strip()))
    if hits:
        print(f"CONTAMINATION DETECTED — {len(hits)} hit(s):", file=sys.stderr)
        for f, p, s in hits[:20]:
            print(f"  {f}: pattern={p!r}: {s}", file=sys.stderr)
        return 2
    print("No contamination signals detected.")
    return 0

if __name__ == '__main__':
    sys.exit(main())
```

```bash
chmod +x bench/webvoyager/audit-contamination.py
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
python3 -m pytest test/unit/bench/test_audit_contamination.py -v
```
Expected: 2 passed.

- [ ] **Step 5: Sanity-audit the existing v0.1.34 traces**

```bash
python3 bench/webvoyager/audit-contamination.py --in /tmp/wv-inline-runs-v0.1.34/ || true
```
Expected: "No contamination signals detected" (sanity check that the v0.1.34 baseline was clean).

- [ ] **Step 6: Commit**

```bash
git add bench/webvoyager/audit-contamination.py test/unit/bench/test_audit_contamination.py
git commit -m "feat(bench): audit-contamination.py for eval-awareness guard"
```

---

### Task 12: Bench gate — full multi-run on patched + comparable

**Files:** (no source changes; bench execution + scoreboard generation)

- [ ] **Step 1: Pre-flight the build**

```bash
npm run build
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"   # confirm version 0.1.35-dev.3 enabled in Safari Settings
```

- [ ] **Step 2: Run patched-2026 bench, 3 runs, concurrency 4**

```bash
bash bench/webvoyager/run-bench.sh --patched --runs 3 --concurrency 4 --out-dir /tmp/wv-runs-v0135-patched-3run
```
Expected: ~600 tasks × 3 runs ≈ 1800 task runs. ~3-5 hours wall-clock at concurrency 4. Budget: ~$540 LLM cost.

Monitor by tailing `/tmp/wv-runs-v0135-patched-3run/*.pretty.log`. Abort if `capture_failure_rate > 5%` after the first ~50 tasks.

- [ ] **Step 3: Run comparable-original bench, 3 runs, concurrency 4**

```bash
bash bench/webvoyager/run-bench.sh --comparable --runs 3 --concurrency 4 --out-dir /tmp/wv-runs-v0135-comparable-3run
```
Expected: ~500 tasks × 3 runs ≈ 1500 task runs. ~2-4 hours. Budget: ~$135.

- [ ] **Step 4: Score both runs**

```bash
npx tsx bench/webvoyager/score.ts --in /tmp/wv-runs-v0135-patched-3run    --runs 3 > bench-runs/v0135-patched-scoreboard.md
npx tsx bench/webvoyager/score.ts --in /tmp/wv-runs-v0135-comparable-3run --runs 3 > bench-runs/v0135-comparable-scoreboard.md
```

- [ ] **Step 5: Run contamination audit**

```bash
python3 bench/webvoyager/audit-contamination.py --in /tmp/wv-runs-v0135-patched-3run/
python3 bench/webvoyager/audit-contamination.py --in /tmp/wv-runs-v0135-comparable-3run/
```
Expected: both PASS (return code 0).

- [ ] **Step 6: Verify acceptance criteria**

Open both scoreboards and check against spec Section 3.2:
- [ ] patched-2026: Pass@1 (majority-of-3) ≥ 80%
- [ ] comparable-original: Pass@1 (majority-of-3) ≥ v0.1.33 baseline (no regression)
- [ ] Median steps/task ≤ 12
- [ ] Median LLM cost/task ≤ $0.30
- [ ] Eval contamination: 0
- [ ] safari_evaluate usage within ±25% of v0.1.33 baseline (compute from `*.stream.jsonl` traces)

If any fail: do NOT proceed to Task 13. Diagnose specific gap, return to relevant prior task, re-bench affected slice.

- [ ] **Step 7: Commit scoreboards**

```bash
git add bench-runs/v0135-patched-scoreboard.md bench-runs/v0135-comparable-scoreboard.md
git commit -m "bench(v0.1.35): patched-2026 + comparable-original scoreboards (3-run majority)"
```

---

### Task 13: Ship — version bump, docs, tag, publish

**Files:**
- Modify: `package.json` + `extension/manifest.json` (final 0.1.35)
- Modify: `CHANGELOG.md`
- Modify: `ARCHITECTURE.md` (new tools + bench protocol)
- Modify: `CLAUDE.md` (any new hard rules from this sprint)

- [ ] **Step 1: Bump to final 0.1.35**

Edit `package.json` `"version": "0.1.35"`. Edit `extension/manifest.json` matching `version` and `version_name`.

- [ ] **Step 2: Write CHANGELOG entry**

Prepend to `CHANGELOG.md`:
```markdown
## [0.1.35] — 2026-05-XX

### Bench protocol (NEW)
- Patched WebVoyager protocol: `bench/webvoyager/patches.json` with date substitutions + impossible-task removals. Two task sets: `patched-2026` (~600 tasks) + `comparable-original` (~500 unpatched tasks).
- Multi-run majority-of-3 verdict aggregation (`bench/webvoyager/judge.ts`).
- Dual-metric reporting: Pass@1 + median steps + median wall + total $ (`bench/webvoyager/score.ts`).
- Eval-contamination audit script (`bench/webvoyager/audit-contamination.py`).
- Per-site abstention rate tracking.

### Tools (NEW)
- `safari_compose_final_evidence` — composes evidence (screenshot + DOM snippet + claim_grounded check) for an answer claim before the agent finalizes its response. Improves judge visibility on screenshot-based evaluations.
- `safari_normalize_date`, `safari_dismiss_cookie_consent`, `safari_wait_for_rate_limit_clear` — light cross-cutting playbooks.

### Behavioral fixes
- Anti-thrash: `LoopDetector` (5-call same-args loop) + `ThrashDetector` (4-call identical snapshot).
- Tool-description softening: removed prescriptive "Use in place of safari_evaluate" framing; restored balanced selection.
- CSP_BLOCKED error UX: informational hint (`fallback_available + note`) instead of prescriptive `alternative_tools` list.
- New `requiresCspBypass: 'preferred'` value: tools with AppleScript fallback degrade gracefully instead of throwing `EngineUnavailableError`.

### query_all
- Per-element `interactability` field: `{clickable, fillable, focusable, role, accessibleName, isVisible, boundingBox, isCovered, isAriaDisabled}`.

### Carry-forward from v0.1.34 (now shipping)
- 16 sentinels in `extension/content-main.js` (CSP-immune execution path).
- Layer 3 Trusted-Types policy registration.
- `extension/locator.js` full port (sentinel-routed locator resolution).
- 3 ISOLATED-world capability tools (`safari_get_page_info`, `safari_get_meta_tags`, `safari_extract_text_window`).
- `legacyMainWorld` rollback flag in `safari-pilot.config.json`.
- `requiresCspBypass` engine routing in `src/engine-selector.ts`.

### Bench results
- `patched-2026` (3-run majority): N/N (NN.N%) — see `bench-runs/v0135-patched-scoreboard.md`
- `comparable-original` (3-run majority): N/N (NN.N%) — see `bench-runs/v0135-comparable-scoreboard.md`
- Median steps/task: NN. Median LLM cost/task: $0.NN.
```

(Fill in actual numbers from Task 12 scoreboards.)

- [ ] **Step 3: Update ARCHITECTURE.md**

Edit `ARCHITECTURE.md`. Add to the Tool Module Pattern section: register FinalProofTools + PlaybooksTools. Add a new Section "Bench Protocol" referencing patches.json + multi-run + dual-metric. Add `LoopDetector` to the security pipeline diagram.

- [ ] **Step 4: Update CLAUDE.md if any new hard rules**

Add to the "Bench Hierarchy" section: `bench/webvoyager/patches.json` is canonical. Bench scores must come from the multi-run majority. Single-run remains the dev loop.

- [ ] **Step 5: Pre-tag check**

```bash
bash scripts/pre-tag-check.sh
```
Expected: "ALL CHECKS PASSED — safe to tag".

- [ ] **Step 6: Local install rehearsal**

```bash
open "bin/Safari Pilot.app"
# Verify in Safari > Settings > Extensions: 0.1.35 enabled.
```

- [ ] **Step 7: Commit + tag + push**

```bash
git add package.json extension/manifest.json CHANGELOG.md ARCHITECTURE.md CLAUDE.md bin/
git commit -m "chore(release): v0.1.35"
git push origin feat/v0134-csp-bypass
git tag -a v0.1.35 -m "v0.1.35 — bench integrity, evidence-grounded answers, abstention, anti-thrash, 4-nudge unwind"
git push origin v0.1.35
```

- [ ] **Step 8: Watch CI**

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: green CI, npm publish succeeds. After CI completes, verify with:
```bash
npm view safari-pilot version
```
Expected: `0.1.35`.

- [ ] **Step 9: Merge feature branch to main**

After CI green + npm publish verified:
```bash
git checkout main
git merge feat/v0134-csp-bypass
git push origin main
git branch -d feat/v0134-csp-bypass
```

---

## Self-Review notes

**Spec coverage:** Slices 0-10 from spec map to Tasks 1-13 (Slice 0 → Tasks 1-3, Slice 1 → Task 4, Slice 2 → Task 5, Slice 3 → Task 6, Slice 4 → Task 7, Slice 5 → Task 8, Slice 6 → Task 9, Slice 7 → Task 10, Slice 8 → Task 11, Slice 9 → Task 12, Slice 10 → Task 13). Two real product bugs (Booking--5 + Google Search--14) not addressed by dedicated tasks — they should manifest as fewer regressions on the patched + multi-run gate. If they persist after Task 12, file as v0.1.36 carry-forwards.

**Type consistency:** `JudgeVerdict` extended to include `'ABSTAIN'` in Task 8; `aggregateMajorityVerdict` is generic so it handles the new value. `requiresCspBypass: boolean | 'preferred'` introduced in Task 6, used in Tasks 7 + 9 consistently.

**Open notes:**
- Task 7 final-proof tool uses `screencapture` for the screenshot. If `safari_take_screenshot` already exists with a viewport-bounded mode, prefer composing on it instead — keeps a single screenshot path.
- Task 12 bench gate budget ($675 + retries) requires user approval before kickoff.
- The 25-turn / 20-min hard caps in Task 5 are enforced via env passing only at the harness level for now; deeper integration into MCP-tool dispatch would require a separate session-state primitive — out of scope for v0.1.35.
