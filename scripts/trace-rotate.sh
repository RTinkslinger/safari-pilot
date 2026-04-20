#!/usr/bin/env bash
# Rotate trace files larger than 5MB
set -euo pipefail

TRACE_DIR="${HOME}/.safari-pilot"
MAX_SIZE=$((5 * 1024 * 1024))

for f in "${TRACE_DIR}/trace.ndjson" "${TRACE_DIR}/daemon-trace.ndjson"; do
  if [ -f "$f" ] && [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -gt "$MAX_SIZE" ]; then
    mv "$f" "${f}.$(date +%Y%m%d%H%M%S).bak"
    echo "Rotated: $f"
  fi
done
