#!/usr/bin/env bash
# bench/webvoyager/run.sh — driver for WebVoyager bench runs.
#
# Usage:
#   bash bench/webvoyager/run.sh --variant <tag> --sample dev|full [--runs N] [--concurrency N] [--skip-judge] [--resume]
#   bash bench/webvoyager/run.sh --variant <tag> --tasks-file <path> [--skip-judge]    # explicit path override (smoke/debug)
#
# Reads CONCURRENCY from PF-6 decision file (bench/webvoyager/CONCURRENCY).
# Reads canonical TASKS_PATH from PF-5 lock file (bench/webvoyager/TASKS_PATH) when --tasks-file not given.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WV_DIR="${REPO_ROOT}/bench/webvoyager"

VARIANT=""
SAMPLE="dev"
RUNS=1
SKIP_JUDGE=""
RESUME=""
TASKS_FILE_OVERRIDE=""

# Concurrency from PF-6
CONCURRENCY=$(cat "${WV_DIR}/CONCURRENCY" 2>/dev/null || echo 8)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --variant)      VARIANT="$2";              shift 2 ;;
    --sample)       SAMPLE="$2";               shift 2 ;;
    --runs)         RUNS="$2";                 shift 2 ;;
    --concurrency)  CONCURRENCY="$2";          shift 2 ;;
    --tasks-file)   TASKS_FILE_OVERRIDE="$2";  shift 2 ;;
    --skip-judge)   SKIP_JUDGE="--skip-judge"; shift ;;
    --resume)       RESUME="--resume";         shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -z "${VARIANT}" ]] && { echo "ERROR: --variant required" >&2; exit 1; }

# Resolve tasks file: explicit override wins; else read TASKS_PATH and apply --sample
if [[ -n "${TASKS_FILE_OVERRIDE}" ]]; then
  [[ -f "${TASKS_FILE_OVERRIDE}" ]] || { echo "ERROR: --tasks-file not found: ${TASKS_FILE_OVERRIDE}" >&2; exit 1; }
  TASKS_FILE="${TASKS_FILE_OVERRIDE}"
  echo "[wv] using --tasks-file override: ${TASKS_FILE}"
else
  TASKS_PATH_REL=$(cat "${WV_DIR}/TASKS_PATH")
  # TASKS_PATH may be relative to WV_DIR; resolve to absolute.
  if [[ "${TASKS_PATH_REL}" = /* ]]; then
    TASKS_FULL="${TASKS_PATH_REL}"
  else
    TASKS_FULL="${WV_DIR}/${TASKS_PATH_REL}"
  fi
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
fi

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
