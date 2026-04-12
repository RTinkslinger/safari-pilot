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

DAEMON_DIR="$ROOT/bin"
DAEMON_BIN="$DAEMON_DIR/SafariPilotd"
mkdir -p "$DAEMON_DIR"

# Step 1: Use pre-built binary if present (npm install path)
if [ -f "$DAEMON_BIN" ]; then
  echo "safari-pilot: Daemon binary found (pre-built)"

# Step 2: Build from source if available (developer clone path)
elif [ -f "$ROOT/daemon/Package.swift" ] && command -v swift &>/dev/null; then
  echo "safari-pilot: Building daemon from source..."
  if (cd "$ROOT/daemon" && swift build -c release 2>&1); then
    cp "$ROOT/daemon/.build/release/SafariPilotd" "$DAEMON_BIN"
    chmod +x "$DAEMON_BIN"
    echo "safari-pilot: Daemon built successfully"
  else
    echo "safari-pilot: Source build failed — downloading pre-built binary..."
  fi
fi

# Step 3: Download from GitHub Releases if still missing
if [ ! -f "$DAEMON_BIN" ]; then
  DAEMON_URL="https://github.com/RTinkslinger/safari-pilot/releases/latest/download/SafariPilotd-universal.tar.gz"
  DAEMON_TAR="$DAEMON_DIR/SafariPilotd.tar.gz"
  echo "safari-pilot: Downloading daemon binary..."
  if command -v curl &>/dev/null; then
    curl -fsSL "$DAEMON_URL" -o "$DAEMON_TAR" 2>/dev/null || true
  elif command -v wget &>/dev/null; then
    wget -q "$DAEMON_URL" -O "$DAEMON_TAR" 2>/dev/null || true
  fi

  if [ -f "$DAEMON_TAR" ]; then
    tar -xzf "$DAEMON_TAR" -C "$DAEMON_DIR/" 2>/dev/null || true
    rm -f "$DAEMON_TAR"
    if [ -f "$DAEMON_BIN" ]; then
      chmod +x "$DAEMON_BIN"
      echo "safari-pilot: Daemon downloaded successfully"
    fi
  fi
fi

if [ ! -f "$DAEMON_BIN" ]; then
  echo "safari-pilot: Could not obtain daemon binary — download manually from:"
  echo "  https://github.com/RTinkslinger/safari-pilot/releases/latest"
fi

# Install LaunchAgent if daemon was built
if [ -f "$DAEMON_DIR/SafariPilotd" ]; then
  PLIST_SRC="$ROOT/daemon/com.safari-pilot.daemon.plist"
  PLIST_DST="$HOME/Library/LaunchAgents/com.safari-pilot.daemon.plist"

  if [ -f "$PLIST_SRC" ]; then
    # Replace placeholders
    sed "s|__DAEMON_PATH__|$DAEMON_DIR/SafariPilotd|g; s|__LOG_PATH__|$HOME/.safari-pilot|g" "$PLIST_SRC" > "$PLIST_DST"
    mkdir -p "$HOME/.safari-pilot"
    # Register with launchd (unload first in case of upgrade)
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST" 2>/dev/null || true
    echo "safari-pilot: LaunchAgent installed and registered at $PLIST_DST"
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
