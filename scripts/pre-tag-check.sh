#!/usr/bin/env bash
# scripts/pre-tag-check.sh — local SOP for verifying everything CI's release.yml
# will check, BEFORE pushing a tag. Catches the failure modes that wasted
# release cycles in v0.1.24:
#
#   - bin/Safari Pilot.zip contained AppleDouble (._*) metadata files because
#     ditto was invoked without --norsrc --noextattr --noqtn --noacl. The CI
#     verify step rejected the bundle as "a sealed resource is missing or
#     invalid". Fixed in scripts/build-extension.sh on 2026-05-03 (commit
#     d55fb18); this script enforces the invariant going forward.
#
#   - hooks/pre-publish-verify.sh blocked CI's `npm publish` because it
#     enforced a `.verified-this-session` marker that only exists locally.
#     Fixed 2026-05-03 to short-circuit on CI markers; this script's
#     "simulate prepublish hook" step now passes regardless.
#
# Run this BEFORE: git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z
# If anything fails, fix it and re-run. CI's release.yml will run the same
# checks plus daemon notarization — but daemon notarization can only happen
# on the CI runner with the Apple credentials, so we can't fully simulate it
# locally. Everything else is checked here.
#
# Usage: bash scripts/pre-tag-check.sh
# Exit:  0 = ready to tag, 1 = something broke

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
green(){ printf '\033[32m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

fail() { red "FAIL: $*"; exit 1; }
pass() { green "PASS: $*"; }

bold "=== Pre-tag check (mirrors release.yml) ==="

# ── 1. Working tree clean? ──────────────────────────────────────────────────
bold "[1/9] Working tree clean (excluding gitignored)"
if [[ -n "$(git status --porcelain | grep -v '^??' || true)" ]]; then
  red "FAIL: uncommitted tracked changes"
  git status --porcelain | grep -v '^??'
  exit 1
fi
pass "no uncommitted tracked changes"

# ── 2. Versions in lockstep ─────────────────────────────────────────────────
bold "[2/9] Versions in lockstep (package.json + extension/manifest.json)"
PKG_VER=$(node -p "require('./package.json').version")
EXT_VER=$(node -p "require('./extension/manifest.json').version")
if [[ "$PKG_VER" != "$EXT_VER" ]]; then
  fail "package.json=$PKG_VER but extension/manifest.json=$EXT_VER (must match per feedback-extension-version-both-fields)"
fi
pass "both at $PKG_VER"

# ── 3. Extension .app present and signed ───────────────────────────────────
bold "[3/9] bin/Safari Pilot.app signed + entitled"
APP="bin/Safari Pilot.app"
APPEX="$APP/Contents/PlugIns/Safari Pilot Extension.appex"
if [[ ! -d "$APP" ]]; then fail "$APP missing — run scripts/build-extension.sh"; fi
if [[ ! -d "$APPEX" ]]; then fail "$APPEX missing"; fi
codesign --verify --deep --strict --verbose=2 "$APP" >/dev/null 2>&1 \
  || fail "codesign --verify --deep --strict failed on $APP"
APP_ENT=$(codesign -d --entitlements :- "$APP" 2>/dev/null || true)
echo "$APP_ENT" | grep -q "com.apple.security.app-sandbox" \
  || fail "app missing app-sandbox entitlement (manual codesign disaster — see CLAUDE.md hard rule #1)"
APPEX_ENT=$(codesign -d --entitlements :- "$APPEX" 2>/dev/null || true)
echo "$APPEX_ENT" | grep -q "com.apple.security.app-sandbox" \
  || fail "appex missing app-sandbox entitlement"
echo "$APPEX_ENT" | grep -q "com.apple.security.network.client" \
  || fail "appex missing network.client entitlement"
xcrun stapler validate "$APP" >/dev/null 2>&1 \
  || fail "stapler validate failed — re-run scripts/build-extension.sh and ensure notarization succeeded"
pass "app + appex signed, entitled (sandbox + network.client), notarization stapled"

# ── 4. Extension .zip is clean (no AppleDouble) ─────────────────────────────
bold "[4/9] bin/Safari Pilot.zip free of AppleDouble (._*) metadata"
ZIP="bin/Safari Pilot.zip"
if [[ ! -f "$ZIP" ]]; then fail "$ZIP missing — run scripts/build-extension.sh"; fi
DOTFILE_COUNT=$(unzip -l "$ZIP" | grep -c "/\\._" || true)
if [[ "$DOTFILE_COUNT" -gt 0 ]]; then
  red "FAIL: $ZIP contains $DOTFILE_COUNT AppleDouble (._*) metadata files."
  echo "  This breaks codesign --verify --deep --strict in CI (T47 verify step)."
  echo "  scripts/build-extension.sh must use:"
  echo "    ditto -c -k --keepParent --norsrc --noextattr --noqtn --noacl SRC DST"
  exit 1
fi
pass "$ZIP clean (0 AppleDouble entries)"

# ── 5. Extracted .zip survives codesign --deep --strict ────────────────────
bold "[5/9] Extracted .zip survives codesign --deep --strict (mirrors CI T47)"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
unzip -qq "$ZIP" -d "$TMP"
codesign --verify --deep --strict --verbose=2 "$TMP/Safari Pilot.app" >/dev/null 2>&1 \
  || fail "extracted bundle fails codesign --verify --deep --strict — CI T47 will reject"
xcrun stapler validate "$TMP/Safari Pilot.app" >/dev/null 2>&1 \
  || fail "extracted bundle stapler validation failed — CI T47 will reject"
pass "extracted bundle would pass CI T47 verify"

# ── 6. Daemon binary present ────────────────────────────────────────────────
bold "[6/9] bin/SafariPilotd present and executable"
DAEMON="bin/SafariPilotd"
if [[ ! -f "$DAEMON" ]]; then fail "$DAEMON missing — run scripts/update-daemon.sh OR pull from GitHub Release"; fi
[[ -x "$DAEMON" ]] || fail "$DAEMON not executable"
DAEMON_FILE=$(file "$DAEMON")
echo "  $DAEMON_FILE"
# Local development build is often arm64-only. CI rebuilds universal, so this
# is informational not blocking. The npm publish step in CI re-copies the
# universal binary from dist-bin/ before the actual publish.
if echo "$DAEMON_FILE" | grep -q "Mach-O universal binary"; then
  pass "daemon is universal Mach-O (matches what CI publishes)"
else
  echo "  NOTE: local daemon is single-arch. CI will produce universal before publish."
fi

# ── 7. Tests still green ────────────────────────────────────────────────────
bold "[7/9] Unit tests pass"
npm run test:unit > /tmp/pre-tag-test-output.log 2>&1 \
  || { red "FAIL: unit tests failing — see /tmp/pre-tag-test-output.log"; tail -20 /tmp/pre-tag-test-output.log; exit 1; }
COUNT=$(grep -oE "Tests +[0-9]+ passed" /tmp/pre-tag-test-output.log | tail -1 || echo "")
pass "unit tests green ($COUNT)"

# ── 8. Tag doesn't already exist ────────────────────────────────────────────
bold "[8/9] Tag v$PKG_VER not yet created"
if git tag -l | grep -qx "v$PKG_VER"; then
  fail "tag v$PKG_VER already exists locally — bump version OR delete tag (git tag -d v$PKG_VER && git push origin :refs/tags/v$PKG_VER)"
fi
if git ls-remote --tags origin "v$PKG_VER" 2>/dev/null | grep -q "v$PKG_VER"; then
  fail "tag v$PKG_VER already exists on origin — bump version"
fi
pass "v$PKG_VER not yet on local or remote"

# ── 9. Prepublish hook simulation (uses real CI=true env) ───────────────────
bold "[9/9] Prepublish hook short-circuits on CI markers"
HOOK_OUTPUT=$(CI=true bash hooks/pre-publish-verify.sh 2>&1) \
  || fail "prepublish hook fails even with CI=true — would block CI publish (was the original v0.1.24 bug)"
echo "$HOOK_OUTPUT" | grep -q "skipped on CI" \
  || fail "prepublish hook didn't short-circuit on CI=true — message expected: 'Pre-publish verify: skipped on CI...'"
pass "prepublish hook will let CI publish proceed"

bold ""
green "=== ALL CHECKS PASSED — safe to tag v$PKG_VER and push ==="
echo ""
echo "Next steps:"
echo "  git tag -a v$PKG_VER -m 'release notes here'"
echo "  git push origin v$PKG_VER"
echo "  gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
