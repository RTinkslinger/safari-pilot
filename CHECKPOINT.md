# Checkpoint — Safari MV3 Event-Page Pivot (Commit 1a ready to execute)
*Written: 2026-04-17*
*Supersedes prior 2026-04-17 checkpoint (Option D event-page pivot at research stage)*

## Where we are

The Safari MV3 event-page pivot has moved from research → synthesis → brainstorm → spec → plan. All four deliverables are committed. The next session picks up at **execution of the Commit 1a plan** (v0.1.5).

Full deliverable chain in git:
- `safari-mv3-event-page-*-2026-04-17.{json,md}` — 3 deep research reports (parallel-cli ultra2x-fast)
- `docs/superpowers/brainstorms/2026-04-17-safari-mv3-event-page-synthesis.md` — research synthesis (validator PASS)
- `docs/upp/specs/2026-04-17-safari-mv3-event-page-design.md` — design spec (4 audits consumed, including adversarial AI-falsification review; 12 findings applied)
- `docs/upp/plans/2026-04-17-safari-mv3-commit-1a.md` — 31 TDD tasks for v0.1.5

Commits on this branch made in this session:
- `1e2ee5b` — docs: Safari MV3 event-page pivot — research, synthesis, design spec
- `58cc8e5` — docs: Commit 1a (v0.1.5) implementation plan

## Next-session protocol

Open a fresh session. In the first turn:

1. Read this CHECKPOINT.md (then delete it per global protocol).
2. Read `docs/upp/specs/2026-04-17-safari-mv3-event-page-design.md` — the design source of truth.
3. Read `docs/upp/plans/2026-04-17-safari-mv3-commit-1a.md` — the 31-task plan.
4. Invoke the `upp:executing-plans` skill. Recommended mode: **subagent-driven** (fresh subagent per task with three-stage review: spec → quality → design).

Execute tasks 1 through 28 (daemon → types → tools → config → extension → tests → infra → docs) before any ship-cycle tasks. Tasks 29-30 are ship + monitoring; they require build + notarization which is slow and should run only after all prior tasks are green locally.

## Commit 1a scope reminder

- Manifest: `service_worker` → `scripts` + `persistent:false`
- Delete: `pollLoop`, `pollForCommands`, `pollLoopRunning`, `nativeMessageChain`, IIFE wrapper (semantic change, not cosmetic)
- Storage-backed command queue + drain-on-wake via sendNativeMessage (no connectNative in 1a)
- Daemon: `HealthStore` persisted state, `handleDisconnected` flips `delivered=true→false`, `handlePoll` returns all undelivered at once
- Per-tool `idempotent` flag REQUIRED on `ToolRequirements` (TypeScript compile-gate); 76 tools migrated
- `safari_extension_health` + `safari_extension_debug_dump` MCP tools
- Kill-switch: `safari-pilot.config.json` → `extension.enabled` boolean
- LaunchAgent hourly health-check with osascript breach notifications
- `__DEBUG_HARNESS__` compile flag for test-only force-unload (stripped in release)
- Pre-publish verify harness (≤6 min, local only) + `.verified-this-session` artifact-hash binding
- `latest-stable` release-channel state machine + rollback detector (stop-hook)
- v0.1.1-v0.1.3 regression canary (codesign + CFBundleVersion)
- Multi-profile manual QA anchor (`.multi-profile-verified-<commitSha>` flag gated by hook)

## Non-scope for 1a (do NOT implement)

- Reconcile protocol + `claimedByProfile` + daemon `executedLog` → **commit 1b (v0.1.6)**
- Two-tier timeout (30s PENDING + 90s TIMEOUT) + forceReload / soft degradation → **commit 1c (v0.1.7)**
- `connectNative` persistent port → **commit 2 (v0.1.8) pending Gate A**
- Full 90-task benchmark → pre-commit-2 release
- H3 descope path → **v0.2.0 reserved** if Gate A + Gate B both fail + 2 remediation cycles

## Validation gates (run AFTER respective commits ship)

- **Gate B** (post-v0.1.5, 48h observation): analyze `~/.safari-pilot/alarm-log.jsonl` for alarm reliability across idle/active/LPM/lid-closed/backgrounded scenarios.
- **Gate A** (post-v0.1.7, 1-2 days): disposable-branch prototype of `connectNative` in our sandboxed .appex handler architecture. Decides Commit 2 feasibility.
- **Gate C** (pre-Commit 1c, 1 day): disposable-branch prototype of `browser.runtime.reload()` safety on Safari 18+ event page. Decides whether 1c ships forceReload or softer degradation.

## Non-negotiable constraints (from user memory)

- NEVER run `pluginkit`, `lsregister`, `pkill` on Safari/pkd processes.
- NEVER edit Safari's internal plists.
- NEVER quit Safari programmatically.
- NEVER activate existing Safari windows/tabs; tests use `safari_new_tab` only.
- Every `extension/`, `daemon/`, `app/` source change requires full rebuild + re-sign + re-notarize + re-install.
- `scripts/build-extension.sh` is the ONLY blessed build path.
- Local e2e is always the publish gate; no CI/CD on GitHub Actions for Safari e2e (user directive).
- `upp:*` skills always for non-trivial work — not `superpowers:*`.

## Git state

- Branch: `feat/file-download-handling` (~72 commits ahead of main)
- Recent commits: `58cc8e5` (plan), `1e2ee5b` (spec+synthesis+research), `46a0958` (prior checkpoint that this supersedes), `7c4fd2a` (EngineProxy), `676df9b`, `9a660aa`, `5b5491d` (older).
- Uncommitted from prior (2026-04-16) push-wake investigation: source modifications in extension/, daemon/, bin/, test/ + CHECKPOINT.md changes (now overwritten). These are SUPERSEDED artifacts. Do NOT commit them as 1a code — they embody the invalidated push-wake design. The 1a plan rewrites `extension/background.js`, `extension/manifest.json`, and `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` from cleaner starting points — the in-flight working-copy diffs may conflict. **Recommended cleanup in the next session, BEFORE starting Task 1:** `git stash push -m "superseded push-wake source edits 2026-04-16" -- extension/ daemon/ test/unit/extension/ "bin/Safari Pilot.app" "bin/Safari Pilot.zip"` to clear the working tree. The stash + original `b24eedd` stash are preserved as historical record until Commit 1a ships successfully.
- Stashed: `b24eedd index on feat/file-download-handling` — original push-wake prototype (obsolete).

## Previously obsolete artifacts (kept for historical record)

- `docs/superpowers/specs/2026-04-16-push-wake-design.md` — rejected design, banner at top.
- `docs/superpowers/plans/2026-04-16-push-wake.md` — rejected plan.
- `EXTENSION_DEBUGGING_ISSUE.md` — pre-dates recent findings; do not rely on it.

## Summary

Pipeline position: **research ✓ → synthesis ✓ → brainstorm ✓ → spec ✓ → plan ✓ → execution [NEXT]**.

The 1a plan is the minimum-viable shippable unit. After it ships + 72h observation window, 1b gets its own spec/plan cycle, then 1c, then Commit 2 (Gate A). The pipeline is linear with explicit 72h stability gates between releases.
