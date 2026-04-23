#!/bin/bash
# Safe binary update via versioned path + symlink swap + launchctl kickstart
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$ROOT/bin"
DAEMON_BIN="$DAEMON_DIR/SafariPilotd"
LABEL="com.safari-pilot.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Only run on macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "update-daemon: macOS only"
  exit 1
fi

# Build new binary into a versioned staging path
VERSION="${1:-$(date +%Y%m%d%H%M%S)}"
STAGED="$DAEMON_DIR/SafariPilotd.$VERSION"

echo "update-daemon: Building daemon (version: $VERSION)..."

if ! command -v swift &>/dev/null; then
  echo "update-daemon: Swift not found — cannot build daemon"
  exit 1
fi

cd "$ROOT/daemon"
swift build -c release 2>&1
if [ ! -f ".build/release/SafariPilotd" ]; then
  echo "update-daemon: Build failed — binary not produced"
  exit 1
fi

cp .build/release/SafariPilotd "$STAGED"
chmod +x "$STAGED"
echo "update-daemon: New binary staged at $STAGED"

# Stop the running daemon if loaded
if launchctl list "$LABEL" &>/dev/null 2>&1; then
  echo "update-daemon: Stopping running daemon..."
  launchctl stop "$LABEL" || true
fi

# Kill any orphaned SafariPilotd processes (from old test runs, spawned child processes, etc.)
ORPHAN_COUNT=$(pgrep -f SafariPilotd | wc -l | tr -d ' ')
if [ "$ORPHAN_COUNT" -gt 0 ]; then
  echo "update-daemon: Killing $ORPHAN_COUNT orphaned SafariPilotd process(es)..."
  pkill -f SafariPilotd || true
  sleep 1
fi

# Atomic swap: replace current binary with staged version
mv "$STAGED" "$DAEMON_BIN"
echo "update-daemon: Binary swapped at $DAEMON_BIN"

# Kickstart (restart) the daemon if the plist is installed
if [ -f "$PLIST" ]; then
  # Reload to pick up new binary
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl start "$LABEL" || true
  echo "update-daemon: Daemon restarted via launchctl"
else
  echo "update-daemon: No LaunchAgent plist found — daemon not restarted automatically"
  echo "update-daemon: Run postinstall.sh to install the LaunchAgent"
fi

echo "update-daemon: Update complete (version: $VERSION)"
