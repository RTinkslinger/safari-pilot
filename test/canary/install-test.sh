#!/bin/bash
set -euo pipefail
# Simulate fresh install via npm pack
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMP=$(mktemp -d)

echo "=== Canary Install Test ==="
cd "$ROOT"

# Pack
TARBALL=$(npm pack 2>/dev/null)
echo "Packed: $TARBALL"

# Install in temp dir
cd "$TMP"
npm init -y > /dev/null 2>&1
npm install "$ROOT/$TARBALL" 2>&1

# Verify
echo "Checking installed files..."
[ -f node_modules/safari-pilot/.claude-plugin/plugin.json ] && echo "✓ plugin.json" || echo "✗ plugin.json MISSING"
[ -f node_modules/safari-pilot/.mcp.json ] && echo "✓ .mcp.json" || echo "✗ .mcp.json MISSING"
[ -f node_modules/safari-pilot/dist/index.js ] && echo "✓ dist/index.js" || echo "✗ dist/index.js MISSING"
[ -f node_modules/safari-pilot/skills/safari-pilot/SKILL.md ] && echo "✓ SKILL.md" || echo "✗ SKILL.md MISSING"
[ -f node_modules/safari-pilot/README.md ] && echo "✓ README.md" || echo "✗ README.md MISSING"
[ -f node_modules/safari-pilot/LICENSE ] && echo "✓ LICENSE" || echo "✗ LICENSE MISSING"

# Verify NO test files leaked into package
[ ! -d node_modules/safari-pilot/test ] && echo "✓ test/ excluded" || echo "✗ test/ LEAKED into package"
[ ! -d node_modules/safari-pilot/daemon/Sources ] && echo "✓ daemon/Sources excluded" || echo "✗ daemon/Sources LEAKED"

# Cleanup
cd /
rm -rf "$TMP" "$ROOT/$TARBALL"
echo "=== Canary test complete ==="
