#!/usr/bin/env bash
# Merge TS and daemon trace files, sorted by timestamp, filtered by optional commandId
set -euo pipefail

TRACE_DIR="${HOME}/.safari-pilot"
TS_FILE="${TRACE_DIR}/trace.ndjson"
DAEMON_FILE="${TRACE_DIR}/daemon-trace.ndjson"

if [ $# -eq 0 ]; then
  cat "$TS_FILE" "$DAEMON_FILE" 2>/dev/null | sort -t'"' -k4
else
  cat "$TS_FILE" "$DAEMON_FILE" 2>/dev/null | grep "$1" | sort -t'"' -k4
fi
