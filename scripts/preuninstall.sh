#!/bin/bash
set -euo pipefail

# Only run on macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

LABEL="com.safari-pilot.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Unload LaunchAgent
if [ -f "$PLIST" ]; then
  launchctl bootout gui/$(id -u) "$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "safari-pilot: LaunchAgent removed"
fi

# Clean up data directory
DATA_DIR="$HOME/.safari-pilot"
if [ -d "$DATA_DIR" ]; then
  echo "safari-pilot: Keeping data at $DATA_DIR (remove manually if desired)"
fi

echo "safari-pilot: Uninstall complete"
