#!/bin/bash
# Stop hook: if source files changed this session, verify e2e tests exist and pass.
# This runs when Claude Code is about to end the session.

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Check if any src/ files were modified (staged or unstaged)
CHANGED_SRC=$(git diff --name-only HEAD -- 'src/' 2>/dev/null)
if [ -z "$CHANGED_SRC" ]; then
  # No source changes — nothing to enforce
  exit 0
fi

# Source files changed. Check that e2e tests exist.
E2E_COUNT=$(find test/e2e -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')
if [ "$E2E_COUNT" -eq 0 ]; then
  echo "WARNING: Source files changed but no e2e tests exist in test/e2e/"
  echo "Changed files:"
  echo "$CHANGED_SRC" | sed 's/^/  /'
  echo ""
  echo "E2E tests verify the shipped artifact works. Add real e2e tests before shipping."
  # Don't block — warn only. The user may be mid-development.
  exit 0
fi

# Check if e2e tests were run this session (look for recent test output)
# This is a soft check — we can't force test execution, but we can remind.
echo "REMINDER: Source files changed this session."
echo "  Changed: $(echo "$CHANGED_SRC" | wc -l | tr -d ' ') files in src/"
echo "  E2E tests: $E2E_COUNT test files in test/e2e/"
echo ""
echo "  Before shipping, run: npx vitest run test/e2e/"
echo "  E2E tests must pass on the shipped artifact (compile with npx tsc first)."
