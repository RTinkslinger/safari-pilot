# Checkpoint
*Written: 2026-05-03 18:50 — v0.1.24 SHIPPED*

## Current Task
Phase 5A · Group A **COMPLETE** (9/9 shipped through v0.1.23+v0.1.24). T67 storage-quota wedge fix shipped and verified live. Release SOP codified. Documentation canonicalized. Standing by for Group B kickoff (next: 5A.14 test:e2e:harness automation).

## Progress

### Phase 5A Group A — closed
- [x] **5A.3** Right-click + middle-click (TS-only)
- [x] **5A.6** Multi-element extraction (TS-only)
- [x] **5A.4** XPath as first-class locator (TS-only)
- [x] **5A.5** Locator chaining nth/filter (TS-only)
- [x] **5A.8** Cookies HttpOnly via `browser.cookies` — v0.1.21
- [x] **5A.2** Download saveAs — v0.1.21
- [x] **5A.9** HTTP basic auth via DNR — v0.1.21
- [x] **5A.7** HAR record + replay — TS-only, no rebuild
- [x] **5A.1 (T41)** `safari_file_upload` — v0.1.23, 11/14 e2e PASS + 3 documented skips, smoke-tested

### Today's session (2026-05-03)
- [x] **T67** storage-quota wedge fix — shipped v0.1.24 (`f05265b` fix + `fda884f` release)
- [x] **CI ditto AppleDouble fix** — shipped v0.1.24 (`d55fb18`)
- [x] **Release SOP codified** — `c1effb2` (scripts/pre-tag-check.sh + hooks/pre-publish-verify.sh CI short-circuit + CLAUDE.md hard rules #8/#9/#10 + Release SOP subsection)
- [x] **Documentation canonicalization** — `30a5e81` (README + ARCHITECTURE + SKILL + AGENTS + v0.1.24 changelog)
- [x] **v0.1.24 SHIPPED** — tag pushed, GitHub Release `Safari.Pilot.zip` + `SafariPilotd-universal.tar.gz` live, npm `safari-pilot@0.1.24` published
- [x] **T67 fix verified live** — `lastReconcileTimestamp` advanced 17ms after first v0.1.24 alarm fire on previously-wedged install

### Phase 5A Group B — pending
- [ ] **5A.14** `npm run test:e2e:harness` automation (next, infra-only)
- [ ] **5A.12** NDJSON line-split fix (ROADMAP-flake)
- [ ] **5A.11** Concurrent MCP sessions e2e (SD-32-followup, closes Phase 4.4)
- [ ] **5A.10** Recovery/degradation e2e (T42)
- [ ] **5A.13** Cluster 1–7 e2e sweep (final closure verification)

### Open follow-ups (not in Group B)
- [ ] **T66** site-CSP blocks content-isolated→daemon fetch on strict-CSP origins (Gmail). Documented as known limitation in v0.1.23 changelog. Next-sprint scope decision: fix or accept.
- [ ] **T65** phase3-3.1 httpbin form-submission flake. Investigate during 5A.13 sweep.
- [ ] **TRACKER row T66** says "Blocks merge of feat/file-upload" — STALE. Branch already merged. Minor cleanup.

## Key Decisions (not yet persisted)

All decisions persisted. Today's session committed:
- T67 root cause + fix (commit `f05265b` + ARCHITECTURE.md Event-Page Lifecycle section + v0.1.24 changelog)
- Release SOP rules #8/#9/#10 (CLAUDE.md commit `c1effb2`)
- Tool count 78→82, macOS 12→14+ recommended (README + ARCHITECTURE)
- 5A.1 ship-with-limitation status (TRACKER T41 + changelog v0.1.23.md)

Pending TRACES iter 53 entry — captured in this checkpoint, will be folded into TRACES.md as part of step 2.

## Next Steps

### Group B kickoff — 5A.14 first

5A.14 = `npm run test:e2e:harness` automation. Auto-build with `SAFARI_PILOT_TEST_MODE=1` before running harness-dependent tests, restore release build after. Infra-only, no extension changes.

Per UPP and tracker method:
1. Branch: `feat/5A.14-test-e2e-harness`
2. `upp:writing-plans` — small plan (likely <10 tasks)
3. `upp:executing-plans` (subagent mode if 4+ tasks)
4. Single npm script + small wrapper around `scripts/build-extension.sh`
5. ff-merge to main once green

Subsequent locked order: 5A.12 → 5A.11 → 5A.10 → 5A.13.

### Pre-Group-B housekeeping (low priority)
- Update TRACKER T66 row — remove the stale "Blocks merge of feat/file-upload" sentence; branch is merged with limitation documented.
- Refresh parity-matrix PDF (`/Users/Aakash/Claude Projects/Documents/safari-pilot-vs-playwright-parity.pdf`) showing Group A closure (5A.1/2/3/4/5/6/7/8/9 all green; 5A.X1/X2/X3 annotated structural).

### Stale root-level scratch files (cleanup candidate, not blocking)
```
e2e-harness-best-practices-2026.md
EXTENSION_DEBUGGING_ISSUE.md
safari-extension-tab-execution-patterns.md
safari-extension-tabs-api-issues.md
safari-mv3-alternatives-2026-04-17.md
safari-mv3-event-page-native-messaging-2026-04-17.md
safari-mv3-event-page-wake-2026-04-17.md
safari-sendnativemessage-limits.md
```
Already covered by `docs/research/*`. Recommend moving to `docs/archive/` or deleting after grep confirms no canonical doc references them. Surfaced to user; awaiting decision.

## Context

### Branch state
- on `main`
- pushed: `30a5e81 docs: canonicalize all user-facing documentation against current state`
- v0.1.24 tag live; GitHub Release + npm registry both have artifacts
- working tree dirty only in untracked files (none of which should be committed):
  - `.claude/scheduled_tasks.lock`
  - `daemon/CLAUDE.md`, `daemon/TRACES.md` (sub-project files, not part of main project)
  - `handoffs/` (session handoff notes)

### Active extension version
- **v0.1.24** installed and confirmed by user
- Live verification: `lastReconcileTimestamp` advancing every 60s; T67 fix working
- Storage auto-recovered on first wake — no manual cleanup needed

### Test state at end of session
- 398/398 unit tests PASS (npm run test:unit)
- 153/153 Swift daemon tests PASS (cd daemon && swift test)
- 11/14 5A.1 file_upload e2e PASS + 3 documented skip
- 2/2 Phase 0 spike e2e PASS
- 31/31 extension structural unit tests PASS (T55a + T60 + T67 + route-command + storage-keys)

### Documentation canonicalization (this session)
| File | Status |
|---|---|
| `README.md` | ✓ tool count 74→82, macOS 12→14+ recommended, full catalog rewrite, test counts, release SOP pointer |
| `ARCHITECTURE.md` | ✓ date refreshed, tool count 78→82, modules table updated, T60+T67 paragraphs added, version history through v0.1.24 |
| `skills/safari-pilot/SKILL.md` | ✓ 7 tools added to allowed-tools, 1 non-existent removed, File Upload section added |
| `AGENTS.md` | ✓ pre-tag-check.sh command added |
| `docs/changelogs/v0.1.24.md` | ✓ NEW — T67 forensics + SOP codification + verification + carried-forward limitations |

### Memory rules (load-bearing for next session)
- `feedback-no-system-manipulation` — never invoke pluginkit/lsregister/pkill
- `feedback-extension-version-both-fields` — bump package.json AND extension/manifest.json in lockstep
- `feedback-never-open-app-without-version-bump`
- `feedback-distribution-builds`
- `feedback-e2e-means-e2e` — zero mocks in test/e2e/
- `feedback-e2e-tests-must-close-tabs` — URL markers `?sp_t<N>=`
- `feedback-never-switch-user-tabs`
- `feedback-no-scheduled-health-checks` — tests + telemetry only
- **NEW today:** Release SOP — always run `bash scripts/pre-tag-check.sh` before any tag push (CLAUDE.md hard rule #9)

### Known stale items
- TRACKER T66 row claims "Blocks merge of feat/file-upload" — branch already merged, sentence is stale.
- `bin/SafariPilotd` was replaced locally with the universal binary downloaded from GitHub Release v0.1.24 (for the manual npm publish). It's gitignored, won't be committed; on next `npm ci` it'll be replaced by the postinstall flow.

### Plan + spec locations (for resumption)
- 5A.1 spec: `docs/upp/specs/2026-05-03-safari-file-upload-design.md`
- 5A.1 plan: `docs/upp/plans/2026-05-03-safari-file-upload-plan.md`
- T67 unit tests: `test/unit/extension/t67-storage-quota-blocks-reconcile.test.ts`
- Pre-tag check: `scripts/pre-tag-check.sh`
- Release SOP doc: `CLAUDE.md` "Release SOP" subsection
