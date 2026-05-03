# Phase 5A · 5A.14 · `npm run test:e2e:harness` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run test:e2e:harness` that auto-builds the extension with `SAFARI_PILOT_TEST_MODE=1`, runs the 5 harness-dependent e2e tests, and ALWAYS restores a release build (even on test failure or interrupt).

**Architecture:** Single bash wrapper (`scripts/test-e2e-harness.sh`) invoked by one new npm script. Uses bash `trap EXIT` to guarantee the release rebuild runs. Refuses to run on CI (no installed Safari with logged-in user). Two manual install prompts bracket the test run because Safari extensions require user interaction to install/reload (per the global `feedback-no-system-manipulation` rule).

**Tech Stack:** Bash 3.2 (macOS default), npm scripts, vitest. No new dependencies.

---

## Source-of-truth references

- `docs/ROADMAP.md:163` — 5A.14 row: "Auto-build with `SAFARI_PILOT_TEST_MODE=1` before running harness-dependent tests; restore release build after."
- `docs/TRACKER.md:86` — T64 RESOLVED-AS-DOCUMENTED, names 5A.14 as the followup.
- `scripts/build-extension.sh:65-97` — the strip-or-keep harness logic this script wraps.
- `scripts/verify-extension-smoke.sh` — reference style for a release-mode build wrapper.

## Harness-dependent test files (verified via `grep -rln SAFARI_PILOT_TEST_MODE test/`)

```
test/e2e/t21-spa-history-cache-refresh.test.ts
test/e2e/t22-poll-loop-transient-retry.test.ts
test/e2e/t27-find-target-tab-fail-closed.test.ts
test/e2e/t44-stale-storage-bus-cleanup.test.ts
test/e2e/t55a-url-change-relay-iframe-filter.test.ts
```

These five files reference `SAFARI_PILOT_TEST_MODE` or `__SP_TEST_HARNESS__` and require the harness blocks to be present in the installed extension. They are the complete set as of plan-write time.

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/test-e2e-harness.sh` | CREATE | Build TEST_MODE=1 → prompt → vitest 5 files → trap-restore release build → prompt → exit with vitest code |
| `package.json` (`scripts` block) | MODIFY | Add `"test:e2e:harness": "bash scripts/test-e2e-harness.sh"` |
| `AGENTS.md` (Repository-Specific Commands) | MODIFY | Add one line documenting the new command |
| `README.md` (Testing section) | MODIFY | Document the script alongside `test:e2e` |

No source code, no extension code, no test code is touched. Surgical infra change only.

---

## Task 1: Skeleton wrapper script that refuses on CI

**Files:**
- Create: `scripts/test-e2e-harness.sh`

- [ ] **Step 1: Create script with shebang, strict mode, and CI guard**

```bash
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
```

- [ ] **Step 2: Make script executable and run the CI guard manually to verify**

Run: `chmod +x scripts/test-e2e-harness.sh && CI=true bash scripts/test-e2e-harness.sh; echo "Exit: $?"`
Expected: stderr lines printed, last line `Exit: 2`

- [ ] **Step 3: Run without CI=true to verify the banner prints**

Run: `bash scripts/test-e2e-harness.sh`
Expected: banner prints, then script exits successfully (because no further logic is wired yet) with `set -e` allowing the implicit successful exit.

Note: at this point the script does nothing useful past the banner — that's fine. Subsequent tasks add the build, test, and trap-restore logic.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-e2e-harness.sh
git commit -m "feat(5A.14): scaffold test-e2e-harness wrapper with CI guard"
```

---

## Task 2: Build TEST_MODE=1 step + first install prompt

**Files:**
- Modify: `scripts/test-e2e-harness.sh`

- [ ] **Step 1: Append the TEST_MODE build + prompt block to the script**

Add this BELOW the banner (before the script's implicit end), keeping `set -euo pipefail` semantics:

```bash
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
```

- [ ] **Step 2: Confirm the script wires through to build-extension.sh**

Run: `bash -n scripts/test-e2e-harness.sh && echo OK`
Expected: `OK` (syntax valid, no execution).

Do NOT run the script end-to-end yet — Task 5 verifies the full flow.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-e2e-harness.sh
git commit -m "feat(5A.14): build extension with SAFARI_PILOT_TEST_MODE=1 + install prompt"
```

---

## Task 3: Trap-based restore-release-build (runs even on failure)

The cleanup step MUST run regardless of how the script exits — vitest failure, Ctrl+C, or shell error. Bash's `trap` on EXIT is the canonical pattern.

**Files:**
- Modify: `scripts/test-e2e-harness.sh`

- [ ] **Step 1: Insert the trap definition near the top of the script**

Add this block IMMEDIATELY AFTER the CI guard's closing `fi` and BEFORE the user-facing banner. The trap must be installed before any operation that can fail, so cleanup always runs.

```bash
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
      # Preserve the original test exit code, but if rc==0 surface the rebuild failure
      if [[ $rc -eq 0 ]]; then rc=3; fi
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
```

The `RELEASE_REBUILT` guard prevents double-execution if the trap fires twice (e.g., via signal then exit).

- [ ] **Step 2: Verify the trap fires when the script exits early**

Add a temporary `exit 7` line just before `read -rp` in the script. Then run:

```bash
bash scripts/test-e2e-harness.sh
```

Expected: TEST_MODE build runs, then `[4/5] Rebuilding release extension...` runs, final exit code is `7`.

After verifying, REMOVE the temporary `exit 7` line.

- [ ] **Step 3: Verify trap on Ctrl+C**

Run `bash scripts/test-e2e-harness.sh`. When prompted with `Press Enter...`, hit Ctrl+C.

Expected: trap fires, release rebuild runs, exit code is non-zero (typically 130 for SIGINT).

- [ ] **Step 4: Commit**

```bash
git add scripts/test-e2e-harness.sh
git commit -m "feat(5A.14): trap-based release rebuild guarantees release-build restoration"
```

---

## Task 4: Run the 5 harness-dependent vitest files

**Files:**
- Modify: `scripts/test-e2e-harness.sh`

- [ ] **Step 1: Insert the vitest run between the install prompt and end of script**

Add AFTER the `read -rp` line (Task 2) and BEFORE the script's implicit end (the trap handles cleanup):

```bash
echo
echo "[3/5] Running 5 harness-dependent e2e tests..."
npx vitest run \
  test/e2e/t21-spa-history-cache-refresh.test.ts \
  test/e2e/t22-poll-loop-transient-retry.test.ts \
  test/e2e/t27-find-target-tab-fail-closed.test.ts \
  test/e2e/t44-stale-storage-bus-cleanup.test.ts \
  test/e2e/t55a-url-change-relay-iframe-filter.test.ts
```

`set -e` propagates a vitest non-zero exit, the EXIT trap runs, and the script exits with vitest's code (preserved by the trap's `local rc=$?` capture).

- [ ] **Step 2: Verify the script's syntax is still valid**

Run: `bash -n scripts/test-e2e-harness.sh && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/test-e2e-harness.sh
git commit -m "feat(5A.14): run 5 harness-dependent e2e files between install prompts"
```

---

## Task 5: Wire the npm script and run the full flow once

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the new script entry**

Find the `"scripts"` block in `package.json`. After the `"verify:extension:full"` line and before `"prepublishOnly"`, insert:

```json
    "test:e2e:harness": "bash scripts/test-e2e-harness.sh",
```

The complete `scripts` block should now look like:

```json
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "npm run test:unit",
    "test:unit": "vitest run -c vitest.config.unit.ts",
    "test:e2e": "vitest run test/e2e/",
    "test:canary": "vitest run -c vitest.config.canary.ts",
    "test:all": "npm run test:unit && npm run test:canary && npm run test:e2e",
    "benchmark": "node dist/benchmark/runner.js",
    "benchmark:dry": "node dist/benchmark/runner.js --dry-run",
    "lint": "tsc --noEmit",
    "postinstall": "bash scripts/postinstall.sh",
    "preuninstall": "bash scripts/preuninstall.sh",
    "verify:extension:smoke": "bash scripts/verify-extension-smoke.sh",
    "verify:extension:full": "npm run verify:extension:smoke && npx vitest run test/e2e/",
    "test:e2e:harness": "bash scripts/test-e2e-harness.sh",
    "prepublishOnly": "bash hooks/pre-publish-verify.sh"
  },
```

- [ ] **Step 2: Verify package.json is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Verify CI guard via npm**

Run: `CI=true npm run test:e2e:harness; echo "Exit: $?"`
Expected: stderr lines explaining local-only, last line `Exit: 2`. (npm forwards bash exit codes, so the `2` propagates.)

- [ ] **Step 4: Run the full flow end-to-end (manual gate)**

Run: `npm run test:e2e:harness`

Expected sequence:
1. Banner prints, build phase 1 runs (`SAFARI_PILOT_TEST_MODE=1`).
2. Script pauses at `Press Enter once the test extension is installed and enabled...`. Open `bin/Safari Pilot.app`, confirm enabled in Safari, return to terminal, press Enter.
3. Vitest runs the 5 files. They should PASS.
4. Trap fires, release rebuild runs (`SAFARI_PILOT_TEST_MODE=0`).
5. Final prompt to install release build. Open `bin/Safari Pilot.app` again.
6. Exit code 0.

After completion, sanity-check the live extension is the release build:

```bash
grep -c "DEBUG_HARNESS" "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex/Contents/Resources/background.js" || true
```
Expected: `0` (release build strips the markers).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(5A.14): add test:e2e:harness npm script"
```

---

## Task 6: Documentation — AGENTS.md and README.md

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Update AGENTS.md Repository-Specific Commands**

In `AGENTS.md`, find the `## Repository-Specific Commands` section (around line 69). After the existing `- E2E suite: \`npm run test:e2e\`` line and before `- Single test file:`, insert:

```
- E2E harness suite (TEST_MODE build, local-only): `npm run test:e2e:harness`
```

- [ ] **Step 2: Update README.md Testing section**

In `README.md`, find the `### Testing` section (around line 306). In the `# Real Safari required (production stack must be running)` block, AFTER the `npm run test:e2e` line, append:

```bash
npm run test:e2e:harness    # 5 tests requiring DEBUG_HARNESS build (auto-rebuilds release after)
```

The Testing block should read:

```bash
# Real Safari required (production stack must be running)
npm run test:e2e            # ~30 e2e tests across 12+ files
npm run test:e2e:harness    # 5 tests requiring DEBUG_HARNESS build (auto-rebuilds release after)
```

Then in the **Test policy** bulleted list, after the existing E2E bullet, add a new bullet:

```
- The harness-dependent tests (`t21`, `t22`, `t27`, `t44`, `t55a`) require `SAFARI_PILOT_TEST_MODE=1` build markers stripped from production. `npm run test:e2e:harness` automates the test build → run → release-rebuild flow. Local-only (refuses on CI).
```

- [ ] **Step 3: Verify both files render markdown without breaking existing structure**

Run: `head -100 AGENTS.md | grep -A 1 "test:e2e:harness"`
Expected: the new line appears in the commands section.

Run: `sed -n '305,330p' README.md`
Expected: the new line and bullet are present, the surrounding structure is intact.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs(5A.14): document npm run test:e2e:harness"
```

---

## Task 7: Final verification + ship

**Files:**
- (no code changes — this is a verification + merge task)

- [ ] **Step 1: Re-run the CI guard one more time**

Run: `CI=true npm run test:e2e:harness; echo "Exit: $?"`
Expected: `Exit: 2`. (Confirms the guard wasn't accidentally regressed during docs edits.)

- [ ] **Step 2: Confirm working tree is clean**

Run: `git status --short`
Expected: only the untracked files that were already there at branch creation (`.claude/scheduled_tasks.lock`, `daemon/CLAUDE.md`, `daemon/TRACES.md`, `handoffs/`). No tracked files dirty.

- [ ] **Step 3: Diff review against main**

Run: `git diff main..feat/5A.14-test-e2e-harness --stat`
Expected: 4 files changed:

```
 AGENTS.md                          | 1 +
 README.md                          | ~5 +-
 package.json                       | 1 +
 scripts/test-e2e-harness.sh        | <total lines created>
```

No source files (`src/`), no test files (`test/`), no extension files (`extension/`), no daemon files (`daemon/`).

- [ ] **Step 4: Update TRACES.md with iter 54**

Add a new iteration entry at the top of the "Current Work" section in `TRACES.md`:

```markdown
### Iteration 54 - 2026-05-03
**What:** Phase 5A.14 — `npm run test:e2e:harness` infra: auto TEST_MODE=1 build + 5 harness-dependent tests + trap-restore release build.
**Changes:** `scripts/test-e2e-harness.sh` (new wrapper, ~50 lines), `package.json` (one new script entry), `AGENTS.md` (one new command line), `README.md` (Testing section).
**Context:** Closes T64 followup. Local-only — refuses on CI because Safari extension install requires user interaction (per `feedback-no-system-manipulation`). Trap-based cleanup guarantees `bin/Safari Pilot.app` is the release build at script exit, regardless of test result or interrupt. No source/test/extension/daemon changes.
---
```

- [ ] **Step 5: Update docs/TRACKER.md and docs/ROADMAP.md**

In `docs/TRACKER.md`, find the T64 row (line ~86). The row already says "Followup tracked as Phase 5A · 5A.14". No change needed — 5A.14 closure will be reflected in the ROADMAP, not TRACKER.

In `docs/ROADMAP.md`, find the 5A.14 row (line ~163) and the 5A.14 entry in the visual table (line ~229). Mark both as SHIPPED. Use the existing pattern from 5A.1 ship entries for formatting consistency.

- [ ] **Step 6: Commit docs sweep**

```bash
git add TRACES.md docs/ROADMAP.md
git commit -m "docs(5A.14): TRACES iter 54 + ROADMAP shipped marker"
```

- [ ] **Step 7: Merge to main**

```bash
git checkout main
git merge --ff-only feat/5A.14-test-e2e-harness
git branch -d feat/5A.14-test-e2e-harness
git push origin main
```

If `--ff-only` fails (someone pushed to main mid-task), rebase onto main first:

```bash
git checkout feat/5A.14-test-e2e-harness
git rebase main
git checkout main
git merge --ff-only feat/5A.14-test-e2e-harness
git branch -d feat/5A.14-test-e2e-harness
git push origin main
```

- [ ] **Step 8: Final sanity check on main**

Run: `CI=true npm run test:e2e:harness; echo "Exit: $?"`
Expected: `Exit: 2`. (Confirms the merged version still has the CI guard.)

---

## Self-review

**1. Spec coverage:**
- Wrapper script with build → prompt → test → trap-restore → prompt → exit → Tasks 1-4
- npm script entry → Task 5
- CI refusal → Task 1, verified again Task 5 step 3 + Task 7 step 1
- Trap-restore even on failure → Task 3 (with two manual verifications: explicit `exit 7` and Ctrl+C)
- AGENTS.md + README.md docs → Task 6
- TRACES + ROADMAP closure → Task 7

All spec acceptance items covered.

**2. Placeholder scan:** No "TBD", no "TODO", no `<...>` placeholders. All commit messages, paths, code blocks are concrete.

**3. Type/name consistency:** `SAFARI_PILOT_TEST_MODE`, `RELEASE_REBUILT`, `cleanup`, `bin/Safari Pilot.app` used consistently throughout. Five test file paths repeated verbatim where they appear (Task 4 + harness-dependent list at top).

**Design checks:** N/A — no DESIGN.md, all tasks use standard structure, no design verification needed.

---

## Execution Handoff

Plan complete and saved to `docs/upp/plans/2026-05-03-5A14-test-e2e-harness.md`.

**Execute with:** the executing-plans skill

Recommendation: **inline mode**. The plan is small (7 tasks, all infra), no design context, no complex review needed. Several tasks (Task 3 step 2/3, Task 5 step 4) require interactive verification that subagents cannot perform — these need a human at the terminal anyway. Inline execution with checkpoints after each task is the right fit.

If you'd prefer subagent mode, Tasks 1, 2, 4, 5 (steps 1-3), and 6 are dispatchable — but Task 3's trap verification, Task 5 step 4's full-flow run, and Task 7's interactive merge all need to come back to the controller. The mode-switching overhead would exceed the value.
