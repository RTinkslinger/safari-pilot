#!/usr/bin/env bash
# scripts/test-e2e-harness.sh — Build extension with SAFARI_PILOT_TEST_MODE=1,
# run the 5 harness-dependent e2e tests, then ALWAYS restore the release build.
#
# Local-only: refuses to run on CI because installing/reloading the Safari
# extension requires user interaction (Safari does not allow programmatic
# install — see the feedback-no-system-manipulation rule in CLAUDE.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "test:e2e:harness is local-only." >&2
  echo "CI cannot install Safari extensions — extension reload requires user interaction." >&2
  echo "If the harness-dependent tests must run in CI, build a separate test runner that does not depend on Safari." >&2
  exit 2
fi

RELEASE_REBUILT=0
cleanup() {
  local rc=$?
  if [[ "$RELEASE_REBUILT" -eq 0 ]]; then
    echo
    echo "[4/5] Rebuilding release extension (SAFARI_PILOT_TEST_MODE=0)..."
    if SAFARI_PILOT_TEST_MODE=0 bash scripts/build-extension.sh; then
      RELEASE_REBUILT=1
      echo
      echo "[5/5] Install the RELEASE build:"
      echo "  1. Open Finder and double-click bin/Safari Pilot.app"
      echo "  2. Confirm Safari Pilot is enabled in Safari → Settings → Extensions"
      echo
      echo "Test exit code: $rc"
    else
      echo "WARNING: release rebuild FAILED. bin/Safari Pilot.app is still TEST_MODE=1." >&2
      echo "Run: SAFARI_PILOT_TEST_MODE=0 bash scripts/build-extension.sh" >&2
      if [[ $rc -eq 0 ]]; then rc=3; fi
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

echo "test:e2e:harness — Phase 5A · 5A.14"
echo "This script will:"
echo "  1. Build the extension with SAFARI_PILOT_TEST_MODE=1 (DEBUG_HARNESS retained)"
echo "  2. Wait for you to install bin/Safari Pilot.app in Safari"
echo "  3. Run the 5 harness-dependent e2e tests"
echo "  4. ALWAYS rebuild the release extension (SAFARI_PILOT_TEST_MODE=0)"
echo "  5. Wait for you to install the release bin/Safari Pilot.app"

echo
echo "[1/5] Building extension with SAFARI_PILOT_TEST_MODE=1..."
SAFARI_PILOT_TEST_MODE=1 bash scripts/build-extension.sh

echo
echo "[2/5] Install the test build:"
echo "  1. Open Finder and double-click bin/Safari Pilot.app"
echo "  2. In Safari → Settings → Extensions, confirm Safari Pilot is enabled"
echo "  3. If Safari shows version mismatch, restart Safari and re-enable"
echo
read -rp "Press Enter once the test extension is installed and enabled..."

echo
echo "[3/5] Running 5 harness-dependent e2e tests..."
npx vitest run \
  test/e2e/t21-spa-history-cache-refresh.test.ts \
  test/e2e/t22-poll-loop-transient-retry.test.ts \
  test/e2e/t27-find-target-tab-fail-closed.test.ts \
  test/e2e/t44-stale-storage-bus-cleanup.test.ts \
  test/e2e/t55a-url-change-relay-iframe-filter.test.ts
