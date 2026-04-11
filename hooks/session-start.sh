#!/bin/bash
# safari-pilot session-start hook
# Runs at the start of every Claude Code session when safari-pilot is installed.
# Gates: OS check → macOS version → Safari presence → daemon startup → health check

set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(cd "$(dirname "$0")" && pwd)")}"
DAEMON_BIN="${PLUGIN_ROOT}/bin/SafariPilotd"
LOG_DIR="${SAFARI_PILOT_DATA:-$HOME/.safari-pilot}/logs"
SESSION_LOG="${LOG_DIR}/session-$(date +%Y%m%d-%H%M%S).log"

# ── 1. OS gate ─────────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "safari-pilot: Skipped (not macOS)" >&2
  exit 0
fi

# ── 2. macOS version check (require 12.0+) ────────────────────────────────────
OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo "0.0")
OS_MAJOR=$(echo "$OS_VERSION" | cut -d. -f1)
if [[ "$OS_MAJOR" -lt 12 ]]; then
  echo "safari-pilot: Warning — macOS ${OS_VERSION} detected. Requires macOS 12.0 (Monterey) or later." >&2
  exit 0
fi

# ── 3. Log directory setup ────────────────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── 4. Safari running check ───────────────────────────────────────────────────
SAFARI_RUNNING=$(osascript -e 'tell application "System Events" to (name of processes) contains "Safari"' 2>/dev/null || echo "false")
if [[ "$SAFARI_RUNNING" != "true" ]]; then
  echo "safari-pilot: Safari is not running. Opening Safari..." >&2
  open -a Safari 2>/dev/null || true
  # Give Safari a moment to start
  sleep 1
fi

# ── 5. Daemon startup ─────────────────────────────────────────────────────────
if [[ -x "$DAEMON_BIN" ]]; then
  # Check if daemon is already running
  if ! pgrep -f "SafariPilotd" > /dev/null 2>&1; then
    echo "safari-pilot: Starting daemon..." >&2
    "$DAEMON_BIN" --daemon >> "$SESSION_LOG" 2>&1 &
    DAEMON_PID=$!
    echo "safari-pilot: Daemon started (PID: $DAEMON_PID)" >&2
    echo "$DAEMON_PID" > "${SAFARI_PILOT_DATA:-$HOME/.safari-pilot}/daemon.pid"
  else
    echo "safari-pilot: Daemon already running" >&2
  fi
else
  echo "safari-pilot: Daemon binary not found at ${DAEMON_BIN} — running in AppleScript-only mode" >&2
fi

# ── 6. JS from Apple Events check ────────────────────────────────────────────
JS_CHECK=$(osascript -e 'tell application "Safari" to do JavaScript "1+1" in current tab of front window' 2>&1 || true)
if echo "$JS_CHECK" | grep -q "2"; then
  echo "safari-pilot: Ready (JS from Apple Events enabled)" >&2
else
  echo "safari-pilot: Warning — JS from Apple Events may be disabled." >&2
  echo "  Enable in Safari: Develop menu → Allow JavaScript from Apple Events" >&2
  echo "  (If no Develop menu: Safari → Settings → Advanced → Show features for web developers)" >&2
fi

echo "safari-pilot: Session started on macOS ${OS_VERSION}" >&2
exit 0
