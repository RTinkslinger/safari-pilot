#!/usr/bin/env bash
# Asserts: build-extension.sh accepts --skip-notarize and skips the notarytool step.
# Runs in a `bash -n` syntax check + a dry-run grep for the conditional.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/build-extension.sh"

# 1. Syntax must be valid
bash -n "$SCRIPT"

# 2. The script must define SKIP_NOTARIZE based on flag/env
grep -q 'SKIP_NOTARIZE' "$SCRIPT" || { echo "FAIL: SKIP_NOTARIZE not referenced in $SCRIPT"; exit 1; }

# 3. The notarytool invocation must be guarded by SKIP_NOTARIZE
if grep -B 5 'xcrun notarytool submit' "$SCRIPT" | grep -q 'if.*SKIP_NOTARIZE.*!=.*1\|if.*\[\[.*-z.*SKIP_NOTARIZE'; then
  echo "PASS: notarytool guarded by SKIP_NOTARIZE"
else
  echo "FAIL: notarytool block is not guarded by SKIP_NOTARIZE"
  exit 1
fi

# 4. The stapler block must also be guarded
if grep -B 5 'xcrun stapler staple' "$SCRIPT" | grep -q 'if.*SKIP_NOTARIZE'; then
  echo "PASS: stapler guarded by SKIP_NOTARIZE"
else
  echo "FAIL: stapler block is not guarded by SKIP_NOTARIZE"
  exit 1
fi

# 5. --skip-notarize must be parsed as a CLI flag
grep -qE -- '--skip-notarize' "$SCRIPT" || { echo "FAIL: --skip-notarize flag not parsed in $SCRIPT"; exit 1; }

echo "ALL TESTS PASSED"
