#!/usr/bin/env bash
# scripts/verify-artifact-integrity.sh
#
# Catches v0.1.1-v0.1.3 class failures: stripped entitlements + stale bundle versions.
# Exit 0 on green, non-zero with diagnostic on red.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/bin/Safari Pilot.app"
APPEX="$APP/Contents/PlugIns/Safari Pilot Extension.appex"
PKG_VERSION=$(node -p "require('$ROOT/package.json').version")

echo "Checking artifact integrity for v${PKG_VERSION}..."

# 1. App bundle exists
if [ ! -d "$APP" ]; then
  echo "FAIL: $APP not found — run build-extension.sh first" >&2
  exit 1
fi

# 2. Extension appex exists
if [ ! -d "$APPEX" ]; then
  echo "FAIL: $APPEX not found — build may be incomplete" >&2
  exit 1
fi

# 3. Entitlements: app-sandbox must be present on both .app and .appex
for target in "$APP" "$APPEX"; do
  if ! codesign -d --entitlements - "$target" 2>&1 | grep -q 'com.apple.security.app-sandbox'; then
    echo "FAIL: $target missing app-sandbox entitlement" >&2
    exit 1
  fi
done

# 4. CFBundleVersion on .app matches package.json version
APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
if [[ "$APP_VERSION" != "$PKG_VERSION" ]]; then
  echo "FAIL: .app CFBundleShortVersionString=$APP_VERSION != package.json=$PKG_VERSION" >&2
  exit 1
fi

# 5. CFBundleVersion of .appex matches regex ^\d{12}$ (timestamp format YYYYMMDDHHMM)
APPEX_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APPEX/Contents/Info.plist")
if ! [[ "$APPEX_VERSION" =~ ^[0-9]{12}$ ]]; then
  echo "FAIL: .appex CFBundleVersion=$APPEX_VERSION not in YYYYMMDDHHMM format" >&2
  exit 1
fi

# 6. package.json version newer than last tag (skip if no tags)
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
LAST_VERSION=${LAST_TAG#v}
if [[ "$LAST_VERSION" != "0.0.0" ]]; then
  if [[ "$(printf '%s\n' "$LAST_VERSION" "$PKG_VERSION" | sort -V | head -1)" == "$PKG_VERSION" ]] && [[ "$LAST_VERSION" != "$PKG_VERSION" ]]; then
    echo "FAIL: package.json version ($PKG_VERSION) not newer than last tag ($LAST_TAG)" >&2
    exit 1
  fi
fi

echo "Artifact integrity: PASS (v${PKG_VERSION}, appex build ${APPEX_VERSION})"
