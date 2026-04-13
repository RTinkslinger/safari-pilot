#!/bin/bash
# Enforcement: e2e tests must NEVER use mocks.
# Blocks commits that add vi.mock, vi.spyOn, jest.mock, or mock imports to test/e2e/.

STAGED_E2E=$(git diff --cached --name-only -- 'test/e2e/' 2>/dev/null)
if [ -z "$STAGED_E2E" ]; then
  exit 0
fi

VIOLATIONS=""
for file in $STAGED_E2E; do
  if [ -f "$file" ]; then
    if grep -nE 'vi\.(mock|spyOn)|jest\.mock|\.mockImplementation|\.mockResolvedValue|\.mockReturnValue|vi\.fn\(\)' "$file" >/dev/null 2>&1; then
      VIOLATIONS="$VIOLATIONS\n  $file"
    fi
  fi
done

if [ -n "$VIOLATIONS" ]; then
  echo "BLOCKED: Mocks detected in e2e tests."
  echo ""
  echo "E2E tests must use REAL processes, REAL protocols, REAL Safari."
  echo "No vi.mock, vi.spyOn, jest.mock, or mock implementations."
  echo ""
  echo "Files with violations:$VIOLATIONS"
  echo ""
  echo "If this is an integration test, move it to test/integration/."
  exit 1
fi

exit 0
