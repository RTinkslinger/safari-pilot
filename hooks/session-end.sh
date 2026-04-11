#!/bin/bash
# safari-pilot session-end hook
# Runs when Claude Code session ends (Stop event).
# Summarizes audit log and performs cleanup.

set -euo pipefail

SAFARI_PILOT_DATA="${SAFARI_PILOT_DATA:-$HOME/.safari-pilot}"
LOG_DIR="${SAFARI_PILOT_DATA}/logs"
AUDIT_LOG="${SAFARI_PILOT_DATA}/audit.log"
PID_FILE="${SAFARI_PILOT_DATA}/daemon.pid"

# ── 1. OS gate ─────────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

# ── 2. Audit log summary ──────────────────────────────────────────────────────
if [[ -f "$AUDIT_LOG" ]]; then
  TOTAL=$(wc -l < "$AUDIT_LOG" | tr -d ' ')
  ERRORS=$(grep -c '"result":"error"' "$AUDIT_LOG" 2>/dev/null || echo 0)
  OK=$(grep -c '"result":"ok"' "$AUDIT_LOG" 2>/dev/null || echo 0)
  echo "safari-pilot: Session summary — ${TOTAL} actions logged (${OK} ok, ${ERRORS} errors)" >&2

  # Archive the audit log with a timestamp to prevent unbounded growth
  if [[ "$TOTAL" -gt 0 ]]; then
    ARCHIVE="${LOG_DIR}/audit-$(date +%Y%m%d-%H%M%S).log"
    mkdir -p "$LOG_DIR"
    cp "$AUDIT_LOG" "$ARCHIVE" 2>/dev/null || true
    # Truncate the live audit log for the next session
    : > "$AUDIT_LOG" 2>/dev/null || true
    echo "safari-pilot: Audit log archived to ${ARCHIVE}" >&2
  fi
else
  echo "safari-pilot: No audit log found — session had no tool calls" >&2
fi

# ── 3. Clean up stale session logs (keep last 10) ────────────────────────────
if [[ -d "$LOG_DIR" ]]; then
  # List session logs sorted by time, remove all but the 10 most recent
  SESSION_LOGS=$(ls -t "${LOG_DIR}"/session-*.log 2>/dev/null | tail -n +11)
  if [[ -n "$SESSION_LOGS" ]]; then
    echo "$SESSION_LOGS" | xargs rm -f 2>/dev/null || true
  fi

  # Keep only 20 most recent audit archives
  AUDIT_ARCHIVES=$(ls -t "${LOG_DIR}"/audit-*.log 2>/dev/null | tail -n +21)
  if [[ -n "$AUDIT_ARCHIVES" ]]; then
    echo "$AUDIT_ARCHIVES" | xargs rm -f 2>/dev/null || true
  fi
fi

# ── 4. Daemon shutdown (optional — leave running for fast restart) ─────────────
# The daemon is intentionally left running between sessions for faster startup.
# Uncomment below to stop it on session end:
#
# if [[ -f "$PID_FILE" ]]; then
#   DAEMON_PID=$(cat "$PID_FILE")
#   if kill -0 "$DAEMON_PID" 2>/dev/null; then
#     kill "$DAEMON_PID" 2>/dev/null || true
#     echo "safari-pilot: Daemon stopped (PID: $DAEMON_PID)" >&2
#   fi
#   rm -f "$PID_FILE"
# fi

echo "safari-pilot: Session ended" >&2
exit 0
