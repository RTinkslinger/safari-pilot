#!/usr/bin/env bash
# scripts/promote-stable.sh — latest-stable state machine
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ACTION="${1:-promote}"

case "$ACTION" in
  promote)
    echo "Evaluating promotion candidates..."
    FOUND=false
    git tag --list 'v*.*.*' --sort=-v:refname | while read -r tag; do
      TAG_TS=$(git log -1 --format=%ct "$tag")
      NOW=$(date +%s)
      AGE=$((NOW - TAG_TS))
      if [[ $AGE -lt 259200 ]]; then continue; fi
      if [[ -f ".breached/$tag" ]]; then continue; fi
      echo "latest-stable: $tag"
      echo "$tag" > .latest-stable
      FOUND=true
      break
    done
    if [[ "$FOUND" != "true" ]] && [[ ! -f .latest-stable ]]; then
      echo "No eligible version for latest-stable promotion" >&2
      exit 1
    fi
    ;;
  rollback)
    REVERT_SHA="${2:?rollback requires commit sha}"
    echo "{\"commitSha\":\"$REVERT_SHA\",\"timestamp\":\"$(date -u +%s)\"}" > .last-rollback-commit
    echo "Rollback recorded: $REVERT_SHA"
    ;;
  mark-breached)
    VERSION="${2:?mark-breached requires version}"
    mkdir -p .breached
    touch ".breached/$VERSION"
    echo "Marked $VERSION breached"
    ;;
  *)
    echo "Usage: $0 [promote|rollback <sha>|mark-breached <version>]" >&2
    exit 1
    ;;
esac
