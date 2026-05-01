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
# T53 — pre-fix the curl/wget/tar errors were swallowed via `2>/dev/null || true`,
# so a failed download (network outage, 404 from a renamed asset, transient
# Cloudflare error) silently produced "Could not obtain daemon binary" with
# zero diagnostic context. Now stderr propagates, the curl→wget fallback is
# explicit, and each step's success/failure is reported.
if [ ! -f "$DAEMON_BIN" ]; then
  DAEMON_URL="https://github.com/RTinkslinger/safari-pilot/releases/latest/download/SafariPilotd-universal.tar.gz"
  DAEMON_TAR="$DAEMON_DIR/SafariPilotd.tar.gz"
  echo "safari-pilot: Downloading daemon binary..."

  DOWNLOAD_OK=0
  if command -v curl &>/dev/null; then
    if curl -fsSL "$DAEMON_URL" -o "$DAEMON_TAR"; then
      DOWNLOAD_OK=1
    else
      echo "safari-pilot: curl download failed (will try wget if available)"
    fi
  fi
  if [ "$DOWNLOAD_OK" -eq 0 ] && command -v wget &>/dev/null; then
    if wget -q "$DAEMON_URL" -O "$DAEMON_TAR"; then
      DOWNLOAD_OK=1
    else
      echo "safari-pilot: wget download failed"
    fi
  fi

  if [ "$DOWNLOAD_OK" -eq 1 ] && [ -f "$DAEMON_TAR" ]; then
    if tar -xzf "$DAEMON_TAR" -C "$DAEMON_DIR/"; then
      rm -f "$DAEMON_TAR"
      if [ -f "$DAEMON_BIN" ]; then
        chmod +x "$DAEMON_BIN"
        echo "safari-pilot: Daemon downloaded successfully"
      fi
    else
      echo "safari-pilot: tar extraction failed (corrupt download?) — keeping $DAEMON_TAR for inspection"
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
    # T52 — modern launchctl style: bootout/bootstrap instead of legacy
    # unload/load. The line 130 health-check registration already uses
    # bootstrap; this paragraph used unload/load. Pick one (per audit) =
    # bootstrap, since modern is preferred and unload/load are deprecated
    # for LaunchAgents/Daemons since macOS 10.10.
    LABEL="com.safari-pilot.daemon"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
    echo "safari-pilot: LaunchAgent installed and registered at $PLIST_DST"
  fi
fi

# Download signed Safari extension from GitHub Releases
EXTENSION_ZIP="$DAEMON_DIR/Safari Pilot.zip"
EXTENSION_APP="$DAEMON_DIR/Safari Pilot.app"

if [ ! -d "$EXTENSION_APP" ]; then
  echo "safari-pilot: Downloading signed Safari extension..."
  RELEASE_URL="https://github.com/RTinkslinger/safari-pilot/releases/latest/download/Safari%20Pilot.zip"

  # T53 — same pattern as the daemon download above: explicit fallback,
  # stderr propagated, status reported per step.
  EXT_DOWNLOAD_OK=0
  if command -v curl &>/dev/null; then
    if curl -fsSL "$RELEASE_URL" -o "$EXTENSION_ZIP"; then
      EXT_DOWNLOAD_OK=1
    else
      echo "safari-pilot: extension curl download failed (will try wget if available)"
    fi
  fi
  if [ "$EXT_DOWNLOAD_OK" -eq 0 ] && command -v wget &>/dev/null; then
    if wget -q "$RELEASE_URL" -O "$EXTENSION_ZIP"; then
      EXT_DOWNLOAD_OK=1
    else
      echo "safari-pilot: extension wget download failed"
    fi
  fi

  if [ "$EXT_DOWNLOAD_OK" -eq 1 ] && [ -f "$EXTENSION_ZIP" ]; then
    # Extract the .app from the zip. Try ditto first (preserves macOS extended
    # attributes), fall back to unzip. Errors propagate now — silent extraction
    # failures previously left users with no .app and no clue why.
    if ditto -x -k "$EXTENSION_ZIP" "$DAEMON_DIR/" 2>/dev/null \
       || unzip -qo "$EXTENSION_ZIP" -d "$DAEMON_DIR/"; then
      rm -f "$EXTENSION_ZIP"
    else
      echo "safari-pilot: extension extraction failed (corrupt download?) — keeping $EXTENSION_ZIP for inspection"
    fi

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

# Install hourly health-check LaunchAgent
HC_TEMPLATE="$ROOT/launchagents/com.safari-pilot.health-check.plist"
HC_INSTALL="$HOME/Library/LaunchAgents/com.safari-pilot.health-check.plist"
HC_SCRIPT="$ROOT/scripts/health-check.sh"
HC_LOG="$HOME/.safari-pilot/health-check.log"

if [[ -f "$HC_TEMPLATE" ]]; then
  sed -e "s|__SCRIPT_PATH__|$HC_SCRIPT|g" -e "s|__HEALTH_LOG_PATH__|$HC_LOG|g" "$HC_TEMPLATE" > "$HC_INSTALL"
  launchctl bootstrap "gui/$(id -u)" "$HC_INSTALL" 2>/dev/null || true
fi

echo "safari-pilot: Postinstall complete"
