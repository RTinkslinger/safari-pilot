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

# Download signed Safari extension from GitHub Releases
EXTENSION_ZIP="$DAEMON_DIR/Safari Pilot.zip"
EXTENSION_APP="$DAEMON_DIR/Safari Pilot.app"

if [ ! -d "$EXTENSION_APP" ]; then
  echo "safari-pilot: Downloading signed Safari extension..."
  RELEASE_URL="https://github.com/RTinkslinger/safari-pilot/releases/latest/download/Safari%20Pilot.zip"
  if command -v curl &>/dev/null; then
    curl -fsSL "$RELEASE_URL" -o "$EXTENSION_ZIP" 2>/dev/null || true
  elif command -v wget &>/dev/null; then
    wget -q "$RELEASE_URL" -O "$EXTENSION_ZIP" 2>/dev/null || true
  fi

  if [ -f "$EXTENSION_ZIP" ]; then
    # Extract the .app from the zip
    ditto -x -k "$EXTENSION_ZIP" "$DAEMON_DIR/" 2>/dev/null || unzip -qo "$EXTENSION_ZIP" -d "$DAEMON_DIR/" 2>/dev/null || true
    rm -f "$EXTENSION_ZIP"

    if [ -d "$EXTENSION_APP" ]; then
      echo "safari-pilot: Safari extension downloaded successfully"
      echo ""
      echo "  ┌─────────────────────────────────────────────────────────────┐"
      echo "  │  Safari Extension Setup                                     │"
      echo "  │                                                             │"
      echo "  │  1. Open the app:                                           │"
      echo "  │     open \"$EXTENSION_APP\"                                   │"
      echo "  │                                                             │"
      echo "  │  2. Enable in Safari:                                       │"
      echo "  │     Safari > Settings > Extensions > Safari Pilot Extension │"
      echo "  │                                                             │"
      echo "  │  Signed with Developer ID and notarized by Apple.           │"
      echo "  └─────────────────────────────────────────────────────────────┘"
      echo ""
    else
      echo "safari-pilot: Extension extraction failed — download manually from:"
      echo "  https://github.com/RTinkslinger/safari-pilot/releases/latest"
    fi
  else
    echo "safari-pilot: Could not download extension — download manually from:"
    echo "  https://github.com/RTinkslinger/safari-pilot/releases/latest"
  fi
else
  echo "safari-pilot: Safari extension already present"
fi

echo "safari-pilot: Postinstall complete"
