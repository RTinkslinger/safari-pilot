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

# Derive REPO_ROOT from this script's own location so the bench picks up
# whichever working copy (main vs worktree) it's launched from. Pre-v0.1.36
# this was hardcoded to the main checkout — every probe launched from a
# worktree silently fell back to main's stale dist/, which masked Track A
# Fix 2 (the Math.max-floor removal in src/engines/extension.ts) for every
# bench run between 2026-05-15 and 2026-05-17. Caller can still pin
# REPO_ROOT explicitly via env var for tests or special-case routing.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
case "$MODE" in
  patched)    DATASET="$REPO_ROOT/bench/webvoyager/patched-2026.jsonl"; VARIANT_TAG="v0.1.35-patched-2026" ;;
  comparable) DATASET="$REPO_ROOT/bench/webvoyager/comparable-original.jsonl"; VARIANT_TAG="v0.1.35-comparable-original" ;;
esac
# Test/dev override: if WV_DATASET is set in the parent env, honor it for BOTH
# iteration and child resolution. This lets harness tests run --patched without
# mutating the canonical patched-2026.jsonl on disk.
DATASET="${WV_DATASET:-$DATASET}"
[[ -f "$DATASET" ]] || { echo "dataset not found: $DATASET — run apply-patches.py first" >&2; exit 2; }

OUT_DIR="${OUT_DIR:-/tmp/wv-runs-${MODE}-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT_DIR"
echo "Mode: $MODE · Runs: $RUNS · OutDir: $OUT_DIR · Concurrency: $CONCURRENCY"

# Build task ID list
TASK_IDS=$(python3 -c "
import json
n=0
for line in open('$DATASET'):
    line=line.strip()
    if not line: continue
    print(json.loads(line)['id'])
    n+=1
    if '$LIMIT' and n>=int('$LIMIT'): break
")

# Loop over tasks × runs with bounded concurrency.
# IMPORTANT: iterate via `while IFS= read -r` not `for tid in $TASK_IDS` so task
# IDs containing spaces (e.g. "Wolfram Alpha--45", "Google Flights--13") survive
# intact. Bash word-splitting on unquoted $TASK_IDS silently dropped 257/641
# tasks during the v0.1.35 patched bench run (2026-05-15).
while IFS= read -r tid; do
  [[ -z "$tid" ]] && continue
  for ((r=1; r<=RUNS; r++)); do
    while [[ $(jobs -r | wc -l) -ge $CONCURRENCY ]]; do sleep 0.5; done
    # Hard external wall-cap (1500s = 25 min) so a hung child can't pin
    # the launcher forever — the v0.1.36 Playwright probe had two tasks
    # zombie for 14h each before being noticed. WallCapEnforcer inside
    # the agent is supposed to cap at MAX_WALL_MS (default 20m) but if
    # it fails to fire (extension or daemon wedged), this perl-alarm
    # terminates the process tree externally. 5 min of slack above
    # MAX_WALL_MS so a legitimately-near-cap task isn't truncated.
    WV_OUT_DIR="$OUT_DIR" WV_VARIANT="$VARIANT_TAG" WV_RUN_SEQ="$r" WV_DATASET="$DATASET" \
      perl -e 'alarm 1500; exec @ARGV' \
      bash "$REPO_ROOT/bench/webvoyager/run-one-task.sh" "$tid" &
  done
done <<< "$TASK_IDS"
wait
echo "Bench complete. Out: $OUT_DIR"
