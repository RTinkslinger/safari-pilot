#!/usr/bin/env bash
# scripts/test-e2e-harness.sh — Build extension with SAFARI_PILOT_TEST_MODE=1,
# run the 5 harness-dependent e2e tests, then ALWAYS rebuild the release extension.
# Fully non-interactive — designed to run via `! npm run test:e2e:harness` from chat
# or `npm run test:e2e:harness` from a terminal.
#
# Local-only: refuses to run on CI because Safari has no installed extension there.
#
# Caching note: Safari caches extension code by CFBundleShortVersionString. If your
# release extension is at the same version (0.1.24) as the test build, Safari may
# keep the cached release code instead of loading the new TEST_MODE=1 build. If
# tests fail with `__SP_TEST_HARNESS__ undefined` or similar, force-reload via
# Safari → Settings → Extensions → toggle Safari Pilot off and back on.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "test:e2e:harness is local-only." >&2
  echo "CI has no installed Safari extension; the harness tests cannot run there." >&2
  exit 2
fi

RELEASE_REBUILT=0
cleanup() {
  local rc=$?
  if [[ "$RELEASE_REBUILT" -eq 0 ]]; then
    echo
    echo "[cleanup] Rebuilding release extension (SAFARI_PILOT_TEST_MODE=0)..."
    if SAFARI_PILOT_TEST_MODE=0 bash scripts/build-extension.sh; then
      RELEASE_REBUILT=1
      open "bin/Safari Pilot.app" || true
      echo "[cleanup] Release extension rebuilt + reopened. Test exit code: $rc"
    else
      echo "[cleanup] WARNING: release rebuild FAILED. bin/Safari Pilot.app may still be TEST_MODE=1." >&2
      echo "  Run: bash scripts/build-extension.sh" >&2
      if [[ $rc -eq 0 ]]; then rc=3; fi
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

echo "test:e2e:harness — Phase 5A · 5A.14 (fully automated)"
echo

echo "[1/3] Building extension with SAFARI_PILOT_TEST_MODE=1..."
SAFARI_PILOT_TEST_MODE=1 bash scripts/build-extension.sh

echo
echo "[2/3] Loading test build into Safari..."
open "bin/Safari Pilot.app"
echo "Waiting 15s for Safari to register the new extension build..."
sleep 15

echo
echo "[3/3] Running 5 harness-dependent e2e tests..."
npx vitest run \
  test/e2e/t21-spa-history-cache-refresh.test.ts \
  test/e2e/t22-poll-loop-transient-retry.test.ts \
  test/e2e/t27-find-target-tab-fail-closed.test.ts \
  test/e2e/t44-stale-storage-bus-cleanup.test.ts \
  test/e2e/t55a-url-change-relay-iframe-filter.test.ts
