#!/usr/bin/env bash
# bench/run.sh — driver that loops over bench/tasks/*.task.json, runs each task
# through bench/agent.ts, then aggregates into a run scoreboard.
#
# Usage:
#   bash bench/run.sh [--variant <tag>] [--fixture-port <port>] [--tasks-glob <glob>]
#
# Defaults:
#   --variant     baseline
#   --fixture-port 18080  (user is expected to start fixture server separately,
#                          or pass 0 to have each agent invocation pick a free port)
#   --tasks-glob  bench/tasks/**/*.task.json
#
# Output: bench-runs/<timestamp>/<task-id>/score.json + tool-calls.jsonl per task
#         bench-runs/<timestamp>/scoreboard.json (aggregated)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── defaults ────────────────────────────────────────────────────────────────
VARIANT="${VARIANT:-baseline}"
FIXTURE_PORT="${FIXTURE_PORT:-18080}"
TASKS_GLOB="${TASKS_GLOB:-bench/tasks/**/*.task.json}"

SURFACE="${SURFACE:-full}"
MODEL="${MODEL:-claude-haiku-4-5-20251001}"

# ── parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)       VARIANT="$2";       shift 2 ;;
    --fixture-port)  FIXTURE_PORT="$2";  shift 2 ;;
    --tasks-glob)    TASKS_GLOB="$2";    shift 2 ;;
    --surface)       SURFACE="$2";       shift 2 ;;
    --model)         MODEL="$2";         shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── run directory ─────────────────────────────────────────────────────────────
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="${REPO_ROOT}/bench-runs/${TIMESTAMP}"
mkdir -p "${RUN_DIR}"

echo "[bench/run.sh] variant=${VARIANT} fixture-port=${FIXTURE_PORT} run-dir=${RUN_DIR}"

# ── collect task files ────────────────────────────────────────────────────────
TASK_FILES=()
while IFS= read -r -d $'\0' f; do
  TASK_FILES+=("$f")
done < <(find "${REPO_ROOT}" -path "${REPO_ROOT}/${TASKS_GLOB}" -name "*.task.json" -print0 2>/dev/null | sort -z)

if [[ ${#TASK_FILES[@]} -eq 0 ]]; then
  echo "[bench/run.sh] No task files found matching: ${TASKS_GLOB}" >&2
  exit 1
fi

echo "[bench/run.sh] Found ${#TASK_FILES[@]} task(s)"

# ── run each task ─────────────────────────────────────────────────────────────
FAILED=0
for TASK_FILE in "${TASK_FILES[@]}"; do
  TASK_ID="$(python3 -c "import json,sys; print(json.load(open('${TASK_FILE}'))['id'])" 2>/dev/null || basename "${TASK_FILE}" .task.json)"
  TASK_OUT="${RUN_DIR}/${TASK_ID}"
  mkdir -p "${TASK_OUT}"

  echo "[bench/run.sh] running task: ${TASK_ID}"

  if node --import tsx "${REPO_ROOT}/bench/agent.ts" \
       --task "${TASK_FILE}" \
       --out "${TASK_OUT}" \
       --fixture-port "${FIXTURE_PORT}" \
       --variant "${VARIANT}" \
       --surface "${SURFACE}" \
       --model "${MODEL}" 2>&1; then
    echo "[bench/run.sh] ✓ ${TASK_ID}"
  else
    echo "[bench/run.sh] ✗ ${TASK_ID} (agent error — continuing)" >&2
    FAILED=$((FAILED + 1))
  fi
done

# ── aggregate scoreboard ──────────────────────────────────────────────────────
SCOREBOARD="${RUN_DIR}/scoreboard.json"
echo "[bench/run.sh] aggregating scores → ${SCOREBOARD}"
node --import tsx "${REPO_ROOT}/bench/score.ts" \
  --run-dir "${RUN_DIR}" \
  --out "${SCOREBOARD}"

echo "[bench/run.sh] done. scoreboard: ${SCOREBOARD}"
if [[ ${FAILED} -gt 0 ]]; then
  echo "[bench/run.sh] WARNING: ${FAILED} task(s) had agent errors" >&2
fi
