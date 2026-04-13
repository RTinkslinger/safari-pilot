#!/bin/bash
# Enforcement: e2e tests must NEVER use mocks or import source modules directly.
# Blocks commits that violate e2e testing rules in test/e2e/.

STAGED_E2E=$(git diff --cached --name-only -- 'test/e2e/' 2>/dev/null)
if [ -z "$STAGED_E2E" ]; then
  exit 0
fi

VIOLATIONS=""
for file in $STAGED_E2E; do
  if [ -f "$file" ]; then
    # Check for mocks
    if grep -nE 'vi\.(mock|spyOn)|jest\.mock|\.mockImplementation|\.mockResolvedValue|\.mockReturnValue|vi\.fn\(\)' "$file" >/dev/null 2>&1; then
      VIOLATIONS="$VIOLATIONS\n  $file — contains mock patterns (vi.mock, vi.spyOn, etc.)"
    fi
    # Check for direct source imports
    if grep -nE "from ['\"](\.\./)+src/" "$file" >/dev/null 2>&1; then
      VIOLATIONS="$VIOLATIONS\n  $file — imports directly from src/ (e2e must spawn real processes)"
    fi
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "BLOCKED: E2E test violations detected."
  echo ""
  echo "E2E tests must use REAL processes, REAL protocols, REAL Safari."
  echo "  - No vi.mock, vi.spyOn, jest.mock, or mock implementations"
  echo "  - No importing from ../../src/ (spawn the real binary instead)"
  echo ""
  echo "Violations:$VIOLATIONS"
  echo ""
  echo "If this is an integration test, move it to test/integration/."
  exit 1
fi

exit 0
