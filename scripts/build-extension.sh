#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$ROOT/extension"
APP_DIR="$ROOT/app"
XCODE_PROJECT_DIR="$APP_DIR/Safari Pilot"
BUNDLE_ID="com.safari-pilot.app"

echo "=== Safari Pilot Extension Build ==="

# Step 1: Generate Xcode project from extension source
echo "Generating Xcode project..."
xcrun safari-web-extension-packager "$EXT_DIR" \
  --project-location "$APP_DIR" \
  --app-name "Safari Pilot" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --no-open \
  --no-prompt \
  --force

# The packager generates the project inside a subdirectory named after the app
# Resulting path: app/Safari Pilot/Safari Pilot.xcodeproj
if [ ! -d "$XCODE_PROJECT_DIR/Safari Pilot.xcodeproj" ]; then
  echo "ERROR: Xcode project not found at expected location: $XCODE_PROJECT_DIR/Safari Pilot.xcodeproj"
  exit 1
fi

# Step 2: Fix bundle identifier in generated project
# The packager sets the app's bundle ID to com.safari-pilot.Safari-Pilot (derived from name)
# instead of our explicit com.safari-pilot.app — causing embedded binary validation failure.
# Fix: replace the auto-derived ID with our explicit bundle ID in both Debug and Release configs.
PBXPROJ="$XCODE_PROJECT_DIR/Safari Pilot.xcodeproj/project.pbxproj"
echo "Fixing bundle identifier in Xcode project..."
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = \"com.safari-pilot.Safari-Pilot\";/PRODUCT_BUNDLE_IDENTIFIER = \"$BUNDLE_ID\";/g" "$PBXPROJ"

# Step 3: Create placeholder Icon.png if missing
# The packager references Icon.png in the project but doesn't create it.
ICON_PATH="$XCODE_PROJECT_DIR/Safari Pilot/Resources/Icon.png"
if [ ! -f "$ICON_PATH" ]; then
  echo "Creating placeholder Icon.png..."
  python3 -c "
import struct, zlib

def png_chunk(name, data):
    chunk = name + data
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)

w, h = 16, 16
raw = b''
for y in range(h):
    raw += b'\x00'
    for x in range(w):
        raw += bytes([100, 100, 100])

sig = b'\x89PNG\r\n\x1a\n'
ihdr_data = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
idat_data = zlib.compress(raw)

png = sig + png_chunk(b'IHDR', ihdr_data) + png_chunk(b'IDAT', idat_data) + png_chunk(b'IEND', b'')

with open('$ICON_PATH', 'wb') as f:
    f.write(png)
"
fi

# Step 4: Build the app
echo "Building app (Release)..."
cd "$XCODE_PROJECT_DIR"
xcodebuild \
  -project "Safari Pilot.xcodeproj" \
  -scheme "Safari Pilot" \
  -configuration Release \
  -derivedDataPath "$ROOT/.build/extension" \
  build 2>&1

# Step 5: Copy built app to bin/
APP_PATH=$(find "$ROOT/.build/extension" -name "Safari Pilot.app" -type d | head -1)
if [ -n "$APP_PATH" ]; then
  echo "Built app at: $APP_PATH"
  mkdir -p "$ROOT/bin"
  rm -rf "$ROOT/bin/Safari Pilot.app"
  cp -R "$APP_PATH" "$ROOT/bin/Safari Pilot.app"
  echo "Copied to bin/Safari Pilot.app"
else
  echo "ERROR: Built app not found in derived data"
  exit 1
fi

echo "=== Build complete ==="
