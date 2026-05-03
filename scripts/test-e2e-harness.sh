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

echo "test:e2e:harness — Phase 5A · 5A.14"
echo "This script will:"
echo "  1. Build the extension with SAFARI_PILOT_TEST_MODE=1 (DEBUG_HARNESS retained)"
echo "  2. Wait for you to install bin/Safari Pilot.app in Safari"
echo "  3. Run the 5 harness-dependent e2e tests"
echo "  4. ALWAYS rebuild the release extension (SAFARI_PILOT_TEST_MODE=0)"
echo "  5. Wait for you to install the release bin/Safari Pilot.app"
