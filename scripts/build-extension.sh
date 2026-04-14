#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$ROOT/extension"
APP_DIR="$ROOT/app"
XCODE_PROJECT_DIR="$APP_DIR/Safari Pilot"
BUNDLE_ID="com.safari-pilot.app"
SIGN_IDENTITY="Developer ID Application: Aakash Kumar (V37WLKRXUJ)"
TEAM_ID="V37WLKRXUJ"

VERSION=$(python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])")
BUILD_NUMBER=$(date +%Y%m%d%H%M)

echo "=== Safari Pilot Extension Build ==="
echo "Version: $VERSION (build $BUILD_NUMBER)"

# ── Step 1: Generate Xcode project ──────────────────────────────────────────

echo "Generating Xcode project..."
xcrun safari-web-extension-packager "$EXT_DIR" \
  --project-location "$APP_DIR" \
  --app-name "Safari Pilot" \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only \
  --no-open \
  --no-prompt \
  --force

if [ ! -d "$XCODE_PROJECT_DIR/Safari Pilot.xcodeproj" ]; then
  echo "ERROR: Xcode project not found"
  exit 1
fi

# ── Step 1b: Replace generated stub handler with TCP proxy handler ──────────
# safari-web-extension-packager generates a stub SafariWebExtensionHandler that
# just echoes messages. We replace it with our TCP proxy that forwards native
# messages to the daemon's socket listener on localhost:19474.

CUSTOM_HANDLER="$EXT_DIR/native/SafariWebExtensionHandler.swift"
GENERATED_HANDLER="$XCODE_PROJECT_DIR/Safari Pilot Extension/SafariWebExtensionHandler.swift"

if [ -f "$CUSTOM_HANDLER" ]; then
  echo "Replacing stub handler with TCP proxy handler..."
  cp "$CUSTOM_HANDLER" "$GENERATED_HANDLER"
else
  echo "WARNING: Custom handler not found at $CUSTOM_HANDLER — using generated stub"
fi

# ── Step 2: Patch Xcode project ─────────────────────────────────────────────

PBXPROJ="$XCODE_PROJECT_DIR/Safari Pilot.xcodeproj/project.pbxproj"

echo "Fixing bundle identifier..."
sed -i '' "s/PRODUCT_BUNDLE_IDENTIFIER = \"com.safari-pilot.Safari-Pilot\";/PRODUCT_BUNDLE_IDENTIFIER = \"$BUNDLE_ID\";/g" "$PBXPROJ"

echo "Setting version $VERSION (build $BUILD_NUMBER)..."
sed -i '' "s/MARKETING_VERSION = .*;/MARKETING_VERSION = $VERSION;/g" "$PBXPROJ"
sed -i '' "s/CURRENT_PROJECT_VERSION = .*;/CURRENT_PROJECT_VERSION = $BUILD_NUMBER;/g" "$PBXPROJ"

echo "Setting manual signing with Developer ID..."
sed -i '' "s/CODE_SIGN_STYLE = Automatic;/CODE_SIGN_STYLE = Manual;/g" "$PBXPROJ"
sed -i '' "s/DEVELOPMENT_TEAM = \"\";/DEVELOPMENT_TEAM = $TEAM_ID;/g" "$PBXPROJ"

# ── Step 3: Create entitlements files for manual signing ────────────────────

APP_ENTITLEMENTS="$XCODE_PROJECT_DIR/Safari Pilot/Safari Pilot.entitlements"
EXT_ENTITLEMENTS="$XCODE_PROJECT_DIR/Safari Pilot Extension/Safari Pilot Extension.entitlements"

cat > "$APP_ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
</dict>
</plist>
PLIST

cat > "$EXT_ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.app-sandbox</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-only</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
</dict>
</plist>
PLIST

# Inject entitlements paths into the pbxproj build settings
# Use python3 for reliable tab insertion (macOS sed doesn't interpret \t)
python3 -c "
import re
with open('$PBXPROJ', 'r') as f:
    content = f.read()

# App target: add CODE_SIGN_ENTITLEMENTS after PRODUCT_BUNDLE_IDENTIFIER for app
content = content.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = \"com.safari-pilot.app\";',
    'PRODUCT_BUNDLE_IDENTIFIER = \"com.safari-pilot.app\";\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = \"Safari Pilot/Safari Pilot.entitlements\";'
)

# Extension target: add CODE_SIGN_ENTITLEMENTS after PRODUCT_BUNDLE_IDENTIFIER for extension
content = content.replace(
    'PRODUCT_BUNDLE_IDENTIFIER = \"com.safari-pilot.app.Extension\";',
    'PRODUCT_BUNDLE_IDENTIFIER = \"com.safari-pilot.app.Extension\";\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = \"Safari Pilot Extension/Safari Pilot Extension.entitlements\";'
)

with open('$PBXPROJ', 'w') as f:
    f.write(content)
"

echo "Entitlements created and wired into project"

# ── Step 4: Create placeholder Icon.png if missing ──────────────────────────

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

# ── Step 5: Archive ─────────────────────────────────────────────────────────

ARCHIVE_PATH="$ROOT/.build/extension/Safari Pilot.xcarchive"

echo "Archiving app (Release)..."
cd "$XCODE_PROJECT_DIR"
xcodebuild archive \
  -project "Safari Pilot.xcodeproj" \
  -scheme "Safari Pilot" \
  -configuration Release \
  -archivePath "$ARCHIVE_PATH" \
  CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  OTHER_CODE_SIGN_FLAGS="--timestamp" \
  2>&1

if [ ! -d "$ARCHIVE_PATH" ]; then
  echo "ERROR: Archive not created"
  exit 1
fi

echo "Archive created at: $ARCHIVE_PATH"

# ── Step 6: Export archive ──────────────────────────────────────────────────

EXPORT_DIR="$ROOT/.build/extension/Export"
EXPORT_OPTIONS="$ROOT/scripts/ExportOptions.plist"

cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>developer-id</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingCertificate</key>
    <string>Developer ID Application</string>
</dict>
</plist>
PLIST

echo "Exporting archive..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  2>&1

EXPORTED_APP="$EXPORT_DIR/Safari Pilot.app"
if [ ! -d "$EXPORTED_APP" ]; then
  echo "ERROR: Export failed — app not found in $EXPORT_DIR"
  exit 1
fi

echo "Exported to: $EXPORTED_APP"

# ── Step 7: Copy to bin/ ────────────────────────────────────────────────────

mkdir -p "$ROOT/bin"
rm -rf "$ROOT/bin/Safari Pilot.app"
cp -R "$EXPORTED_APP" "$ROOT/bin/Safari Pilot.app"
echo "Copied to bin/Safari Pilot.app"

APP_PATH="$ROOT/bin/Safari Pilot.app"

# ── Step 8: Verify signature and entitlements ───────────────────────────────

echo "=== Verification ==="

echo "Code signature:"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo ""
echo "App entitlements:"
codesign -d --entitlements - "$APP_PATH" 2>&1 | grep -v "^Executable"

echo ""
echo "Extension entitlements:"
codesign -d --entitlements - "$APP_PATH/Contents/PlugIns/Safari Pilot Extension.appex" 2>&1 | grep -v "^Executable"

# ── Step 9: Notarize ────────────────────────────────────────────────────────

echo "=== Notarizing ==="

ditto -c -k --keepParent "$APP_PATH" "$ROOT/bin/Safari Pilot.zip"

xcrun notarytool submit "$ROOT/bin/Safari Pilot.zip" \
  --keychain-profile "apple-notarytool" --wait

xcrun stapler staple "$APP_PATH"

# Re-zip with stapled ticket
rm "$ROOT/bin/Safari Pilot.zip"
ditto -c -k --keepParent "$APP_PATH" "$ROOT/bin/Safari Pilot.zip"

# ── Step 10: Final Gatekeeper check ─────────────────────────────────────────

echo "=== Final Verification ==="
spctl -a -t exec -vv "$APP_PATH"
xcrun stapler validate "$APP_PATH"

echo "=== Build Complete: v$VERSION (build $BUILD_NUMBER) ==="
