#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Only run on macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "safari-pilot: Skipping postinstall — macOS only"
  exit 0
fi

# Detect architecture
ARCH=$(uname -m)  # arm64 or x86_64

# Download pre-built daemon binary from GitHub Releases
DAEMON_DIR="$ROOT/bin"
mkdir -p "$DAEMON_DIR"

# For now, try to build locally if swift is available
if command -v swift &>/dev/null; then
  echo "safari-pilot: Building daemon locally..."
  cd "$ROOT/daemon" && swift build -c release 2>&1 || true
  if [ -f ".build/release/SafariPilotd" ]; then
    cp .build/release/SafariPilotd "$DAEMON_DIR/SafariPilotd"
    chmod +x "$DAEMON_DIR/SafariPilotd"
    echo "safari-pilot: Daemon built successfully"
  fi
else
  echo "safari-pilot: Swift not available — daemon will not be available"
  echo "safari-pilot: Install Xcode Command Line Tools for daemon support"
fi

# Install LaunchAgent if daemon was built
if [ -f "$DAEMON_DIR/SafariPilotd" ]; then
  PLIST_SRC="$ROOT/daemon/com.safari-pilot.daemon.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.safari-pilot.daemon.plist"

  if [ -f "$PLIST_SRC" ]; then
    # Replace placeholders
    sed "s|__DAEMON_PATH__|$DAEMON_DIR/SafariPilotd|g; s|__LOG_PATH__|$HOME/.safari-pilot|g" "$PLIST_SRC" > "$PLIST_DST"
    mkdir -p "$HOME/.safari-pilot"
    echo "safari-pilot: LaunchAgent installed at $PLIST_DST"
  fi
fi

echo "safari-pilot: Postinstall complete"
