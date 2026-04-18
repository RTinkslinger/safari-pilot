#!/usr/bin/env bash
# hooks/pre-publish-verify.sh — blocks npm publish / gh release create if not verified
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERIFIED_FILE=".verified-this-session"
if [[ ! -f "$VERIFIED_FILE" ]]; then
  echo "BLOCKED: .verified-this-session not found. Run 'npm run verify:extension:smoke' first." >&2
  exit 1
fi

EXPECTED_COMMIT=$(python3 -c "import json; print(json.load(open('$VERIFIED_FILE'))['commitSha'])")
CURRENT_COMMIT=$(git rev-parse HEAD)
if [[ "$EXPECTED_COMMIT" != "$CURRENT_COMMIT" ]]; then
  echo "BLOCKED: .verified-this-session is for $EXPECTED_COMMIT but HEAD is $CURRENT_COMMIT." >&2
  echo "Re-run 'npm run verify:extension:smoke' on current HEAD." >&2
  exit 1
fi

EXPECTED_APP=$(python3 -c "import json; print(json.load(open('$VERIFIED_FILE'))['appSha'])")
CURRENT_APP=$(find "bin/Safari Pilot.app" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')
if [[ "$EXPECTED_APP" != "$CURRENT_APP" ]]; then
  echo "BLOCKED: bin/Safari Pilot.app hash changed since verification." >&2
  exit 1
fi

EXPECTED_DAEMON=$(python3 -c "import json; print(json.load(open('$VERIFIED_FILE'))['daemonSha'])")
CURRENT_DAEMON=$(shasum -a 256 "bin/SafariPilotd" | awk '{print $1}')
if [[ "$EXPECTED_DAEMON" != "$CURRENT_DAEMON" ]]; then
  echo "BLOCKED: bin/SafariPilotd hash changed since verification." >&2
  exit 1
fi

PROFILE_FLAG=".multi-profile-verified-$CURRENT_COMMIT"
if [[ ! -f "$PROFILE_FLAG" ]]; then
  echo "BLOCKED: multi-profile manual QA not done for $CURRENT_COMMIT." >&2
  echo "See test/manual/multi-profile.md; touch $PROFILE_FLAG when complete." >&2
  exit 1
fi

echo "Pre-publish verify: PASS"
