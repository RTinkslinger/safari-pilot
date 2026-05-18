# WebVoyager Bench Protocol — v0.1.35

## Sets

| Set | File | Purpose |
|---|---|---|
| `patched-2026` | `patched-2026.jsonl` | Stale-dated tasks substituted, impossible tasks removed. 641 tasks. PRIMARY ship metric. |
| `comparable-original` | `comparable-original.jsonl` | Original tasks that are still valid in 2026 (subset of 643). 567 tasks. Anti-regression baseline. |

## Patches

`patches.json` defines per-task substitutions and removals. See `AUDIT.md` for per-task rationale. Regenerate the two `.jsonl` outputs when patches.json changes:

```bash
python3 bench/webvoyager/apply-patches.py \
  --dataset bench/webvoyager/data/data/WebVoyager_data.jsonl \
  --patches bench/webvoyager/patches.json \
  --out-patched bench/webvoyager/patched-2026.jsonl \
  --out-comparable bench/webvoyager/comparable-original.jsonl
```

> Note: outputs are at `bench/webvoyager/*.jsonl` (not `bench/webvoyager/data/`) because `data/` is the nested upstream WebVoyager git clone.

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
