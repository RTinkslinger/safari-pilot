#!/usr/bin/env bash
# Content-only patch CI proof — proves the v0.1.31 §9.3 rollback claim is real.
# Mutates a single allowlist JSON entry, runs npm build, fresh-spawns the loader,
# asserts the patched pattern is loaded, and asserts bin/Safari Pilot.app mtime
# is unchanged (proves no extension rebuild fired).

set -euo pipefail

cd "$(dirname "$0")/../.."

EXTENSION_PATH="bin/Safari Pilot.app"
EXTENSION_MTIME_BEFORE=$(stat -f %m "$EXTENSION_PATH" 2>/dev/null || echo "0")

# Backup the cookie-consent allowlist
BACKUP=$(mktemp)
cp src/overlays/cookie-consent.json "$BACKUP"

cleanup() {
  cp "$BACKUP" src/overlays/cookie-consent.json
  rm -f "$BACKUP"
  npm run build > /dev/null 2>&1 || true
}
trap cleanup EXIT

# Mutate: bump version + add a sentinel pattern
node -e "
const fs = require('fs');
const f = JSON.parse(fs.readFileSync('src/overlays/cookie-consent.json'));
f.version = f.version + 1;
f.patterns.push({
  id: 'ci-test-sentinel-' + Date.now(),
  signals: [
    { type: 'selector', value: '#ci-test-marker' },
    { type: 'aria-role', value: 'dialog' }
  ],
  dismiss: { action: 'click', selector: '#ci-test-accept' },
  verify: { type: 'node-removed', stabilityMs: 100 }
});
fs.writeFileSync('src/overlays/cookie-consent.json', JSON.stringify(f, null, 2));
"

# Build (Node-only — does NOT touch extension/)
npm run build > /dev/null

# Verify the new pattern is loaded by a fresh loader process
node -e "
const { loadAllAllowlists } = require('./dist/overlays/index.js');
const registry = loadAllAllowlists('./dist/overlays');
const found = registry.find(p => p.id.startsWith('ci-test-sentinel-'));
if (!found) { console.error('FAIL: patched pattern not loaded'); process.exit(1); }
console.log('  patched pattern loaded:', found.id);
"

# Verify bin/Safari Pilot.app mtime unchanged — npm build must not touch the .app
EXTENSION_MTIME_AFTER=$(stat -f %m "$EXTENSION_PATH" 2>/dev/null || echo "0")
if [ "$EXTENSION_MTIME_BEFORE" != "$EXTENSION_MTIME_AFTER" ]; then
  echo "FAIL: bin/Safari Pilot.app mtime changed (was $EXTENSION_MTIME_BEFORE, now $EXTENSION_MTIME_AFTER) — npm build touched the extension"
  exit 1
fi

echo "  content-only patch flow verified: allowlist patches do NOT trigger extension rebuild"
