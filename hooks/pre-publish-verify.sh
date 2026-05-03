#!/usr/bin/env bash
# hooks/pre-publish-verify.sh — blocks LOCAL npm publish / gh release create
# if the developer hasn't run `npm run verify:extension:smoke` against current
# HEAD. Has no place in CI: the release.yml workflow runs equivalent verify
# steps (T47 extension+daemon verify) and is the canonical publish path.
#
# Original v0.1.24 publish failed because this hook ran during CI's
# `npm publish --access public` step; CI never creates `.verified-this-session`
# so it always blocked. Fixed 2026-05-03 by short-circuiting on CI env markers.
# Reference: scripts/pre-tag-check.sh contains the local SOP equivalent that
# developers run BEFORE pushing a release tag.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# CI short-circuit. GitHub Actions sets both CI=true and GITHUB_ACTIONS=true.
# Other CI providers all set CI=true. The release workflow's T47 verify steps
# are the real gate; this hook is a local-only safety net for human publishes.
if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "Pre-publish verify: skipped on CI (release workflow's T47 verify is the gate)."
  exit 0
fi

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
