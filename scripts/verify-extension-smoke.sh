#!/usr/bin/env bash
# scripts/verify-extension-smoke.sh — ≤6 min local gate for extension release
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[1/6] Building TypeScript..."
npm run build >/dev/null

echo "[2/6] Building daemon..."
bash scripts/update-daemon.sh >/dev/null

echo "[3/6] Building extension (signed + notarized)..."
SAFARI_PILOT_TEST_MODE=0 bash scripts/build-extension.sh >/dev/null

echo "[4/6] Artifact integrity canary..."
bash scripts/verify-artifact-integrity.sh

echo "[5/6] Computing artifact hashes..."
BUNDLE_SHA=$(find "bin/Safari Pilot.app" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')
DAEMON_SHA=$(shasum -a 256 "bin/SafariPilotd" | awk '{print $1}')

echo "[6/6] Running 5 critical e2e tests..."
npx vitest run \
  test/e2e/mcp-handshake.test.ts \
  test/e2e/extension-engine.test.ts \
  test/e2e/extension-lifecycle.test.ts \
  test/e2e/extension-health.test.ts \
  test/e2e/commit-1a-shippable.test.ts

COMMIT_SHA=$(git rev-parse HEAD)
cat > .verified-this-session <<EOF
{
  "commitSha": "$COMMIT_SHA",
  "appSha": "$BUNDLE_SHA",
  "daemonSha": "$DAEMON_SHA",
  "suiteResult": "pass",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "smokePassed": true
}
EOF

echo "Smoke verify: PASS (hashes recorded in .verified-this-session)"
