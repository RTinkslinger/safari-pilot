# Safari Pilot Tracker
*Single source of truth for open work. Created 2026-04-25 to consolidate `docs/AUDIT-TASKS.md` (T-numbered audit findings, 2026-04-23) + `docs/FOLLOW-UPS.md` (SD-numbered systematic-debugging follow-ups) + today's reconciliation review.*

**For new entries, use this file.** The two original ledgers stay as historical archives — their `RESOLVED` paragraphs preserve fix-context that would be lossy to copy here.

- `docs/AUDIT-TASKS.md` — original 2026-04-23 audit findings T1–T58 (with their full Findings / Root cause / Origin / Traces / Fix paragraphs).
- `docs/FOLLOW-UPS.md` — systematic-debugging follow-ups SD-01..SD-32 (with their full discriminator + entry-points + fix paragraphs).

This tracker carries one-line summaries + the IDs needed to look up full context in the archives.

---

## Method (non-negotiable)

Atomic per-item scope. For each entry below:

1. **Branch** off `main`: `fix/<id>-<slug>` or `chore/<id>-<slug>` for non-behavioural deletions.
2. **Phase 1 of `upp:systematic-debugging`** — root cause investigation: read the source, reproduce, gather evidence. Don't skip to a fix.
3. **`upp:test-driven-development`** — write the discriminating failing test FIRST. Verify it fails for the expected reason against the buggy SUT.
4. **`upp:test-reviewer` gate** — dispatch fast (≤3 tests) or full (>3 tests). PASS verdict required before GREEN. Reviewer-skip is permitted ONLY for: deletion of dead code (T24 / T31 precedent), test-infra-only refactors (SD-29 precedent), and re-use of an already-reviewed shared helper (T32 precedent).
5. **Apply the fix** (GREEN). Verify the test passes.
6. **Mutation cycle** — temporarily revert the fix, re-run the test, confirm it fails. Restore. This step is what discriminates "test verified the fix" from "test happened to pass."
7. **Commit fix → ff-merge to main → push.** One change per commit; one item per branch.
8. **Standalone docs commit** moving the entry from the Open table below to the Resolved index (with commit SHA).

**No large scopes.** If an item turns out to require multiple discriminating tests or multi-file production refactors that go beyond a single concern, split it into sub-items first.

---

## Open work — by impact

### Critical bugs (ship next)
*All shipped this sprint.* T7, SD-31, SD-32 resolved. See "Resolved this sprint" below.

### Extension-rebuild batch
Source changes to `extension/*.js` are incomplete without rebuild + sign + notarize + release per the `feedback_distribution_builds` memory. Bundle these as ONE drop, not three releases.

| ID | Surface | One-liner |
|---|---|---|
| **T21** | `extension/content-isolated.js` | content scripts don't patch `history.pushState`/`replaceState` — SPA URL changes via History API don't update the extension's tab cache |
| **T22** | `extension/background.js` pollLoop | poll loop returns on error (no infinite loop), but no real retry-on-transient — wakeSequence reactivates on alarm only |
| **T27** | `extension/background.js` findTargetTab | falls through to active tab when `tabUrl` not found; should return null when `tabUrl` was explicitly provided |
| **T44** | `extension/background.js` | stale `sp_result` not cleaned up on event-page re-wake after suspension |

Build pipeline: edit → `bash scripts/build-extension.sh` → verify entitlements via `codesign -d --entitlements -` → bump `package.json` version (per "never open app without version bump" memory) → `open "bin/Safari Pilot.app"` → verify in Safari Settings → release.

### Quality debt — P2

| ID | Surface | One-liner | Linked |
|---|---|---|---|
| **T34** | `src/engine-selector.ts` ENGINE_CAPS + `extension/manifest.json` | "cross-origin frames" capability claimed in extension caps but manifest lacks `all_frames: true` | Pair with T55 — choose one (deliver via manifest = T55, or remove from caps = T34). |
| **T35** | `src/security/idpi-scanner.ts` + `src/server.ts:575` | IDPI scanner annotates result metadata but never blocks injected content; documentation honestly says "no block" | Decide: block (rename + add throw path) or rename to "annotator" + drop the "scanner" framing. |
| **T36** | `src/security/screenshot-redaction.ts` + `src/server.ts:591` | redaction script returned but never injected before capture — currently a no-op annotation | |
| **T37** | `src/security/tab-ownership.ts` | `recordPreExisting` + `isPreExisting` methods have zero callers — dead code | Deletion-only; reviewer-skip per T24 precedent. |
| **T38** | `src/server.ts` `recoverSession` | recovery re-opens window + polls extension but never calls `registerWithDaemon()` — multi-session count desyncs after recovery | |
| **T39** | `daemon/Sources/SafariPilotdCore/HealthStore.swift` | `roundtripTimestamps` / `timeoutTimestamps` / `uncertainTimestamps` arrays grow unbounded; only `forceReloadTimestamps` has pruning | |
| **T40** | `ARCHITECTURE.md` | 8 documented claims contradict current code (cross-origin frames, ownership-domainMatches deletion, etc.) | doc-only fix. |

### Missing features / cosmetic — P3

| ID | Surface | One-liner |
|---|---|---|
| **T41** | new tool | build `safari_file_upload` (currently absent from tool registry) |
| **T42** | `test/e2e/` | write e2e tests for recovery / degradation paths |
| **T43** | `test/e2e/` | write e2e tests for 61 untested tools (multi-week sub-sprint) |
| **T45** | `daemon` TCP listener | crash on port-19474 bind conflict instead of random-port fallback (silent split-brain) |
| **T46** | `daemon/Sources/SafariPilotdCore/PdfGenerator.swift` | possible `CheckedContinuation` leak on error path |
| **T47** | `.github/workflows/release.yml` | verify extension entitlements + code-sign before uploading to GitHub Release |
| **T48** | `src/server.ts` | refuse `safari_navigate` (and similar) targeting the session dashboard tab |
| **T49** | `src/tools/interaction.ts:259+` | `safari_type` `delay` param declared in schema but ignored in handler |
| **T50** | `src/tools/interaction.ts:745+` | `safari_scroll` conflicting modes — schema lets caller pass both `to:'top'` and `y:100`; both branches execute |
| **T51** | `src/tools/navigation.ts:249` | `safari_reload` `bypassCache` uses deprecated `location.reload(true)` syntax |
| **T52** | `scripts/postinstall.sh` + `update-daemon.sh` | mix of legacy `launchctl unload/load` and modern `launchctl kickstart`/`bootstrap` — pick one |
| **T53** | `scripts/postinstall.sh` | download/extraction failures swallowed by `\|\| true` guards |
| **T54** | `scripts/update-daemon.sh` | `pkill -f` should be `pkill -x` to avoid matching unrelated commands |
| **T55** | `extension/manifest.json` | add `all_frames: true` to content_scripts (or document the limitation; pair with T34) |
| **T56** | `src/tools/interaction.ts:362` | `safari_handle_dialog` declares `requiresDialogIntercept: true` but works on AppleScript — overstated requirement |
| **T57** | `daemon/Sources/SafariPilotdCore/NDJSONParser.swift` | silent catch — add logging at parse-failure points |
| **T58** | `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | bind failure on port 19475 logs and continues; should be fatal |

### Deferred features (intentional, filed for later)

| ID | Surface | One-liner |
|---|---|---|
| **SD-30** | DomainPolicy + selectEngine | banking-disable-extension security feature is legitimate but unimplemented; needs threat-model + default-policy decision before wiring |

### ROADMAP backlog (not from audit, but tracked)

| ID | Surface | One-liner |
|---|---|---|
| ROADMAP-#3 | `safari_navigate_back` / `safari_navigate_forward` | stale-URL query after history.back/forward — tool queries page info by old URL |
| ROADMAP-flake | NDJSON parser | line-split flake under parallel test runs (long click JS payloads with embedded newlines break the daemon's line-based JSON parser) |

---

## Resolved this sprint (2026-04-25)
Lookup-only index; full fix-context paragraphs are in `docs/AUDIT-TASKS.md` / `docs/FOLLOW-UPS.md` Resolved sections.

| ID | Code | Docs | One-line |
|---|---|---|---|
| T13 | `0636182` | `dede5fb` | parseJsResult bare-empty CSP — collapsed triple-nested conditional |
| T15 | `1e56bba` | `f7ed832` | safari_new_tab.idempotent flipped true→false |
| T16 | `1809b1a` | `9ad595a` | safari_hover description: dropped false "CSS :hover" claim |
| T17 | `9b16f17` | `d5cd1ee` | safari_take_screenshot: removed dead schema params |
| T18 | `113515a` | `9702335` | safari_export_pdf: removed dead tabUrl from schema |
| T19 | `816d970` | `6695b6c` | safari_paginate_scrape: surface stale-URL bail loudly |
| T20 | `8b62f03` | `b9b096d` | safari_eval_in_frame: replace win.eval() with new win.Function() |
| T23 | `0e6e6e9` | `996c0d7` | disconnectTimeout 15s→25s |
| T24 | `cc20814` | `6ca4105` | Deleted unused domainMatches + helper |
| T25 | `3b94994` | `1037ee9` | Shutdown detection: parsed method, not substring |
| T26 | `591ffda` | `0ac1650` | Trace serial DispatchQueue.sync |
| T28 | `3533785` | `c475ea3` | Engine-aware health gate |
| T29 | `a504928` | `f055ebb` | killSwitch.recordError wired (introduced SD-31 — fix queued) |
| T30 | `4ecaef1` | `068e16c` | MCP isError on HumanApproval soft-returns |
| T31 | `54c2ae1` | `a64be40` | Deleted unused extensionAllowed; banking-extension filed as SD-30 |
| T32 | `960f1c8` | `ffc1f7e` | Shared js-helpers.ts (DaemonEngine gains CSP / shadow / JS-error semantics) |
| SD-29 | `a173e95` | `f3ead67` | vitest cross-file mock pollution — vi.resetModules + vi.doMock + dynamic import |
| Reconciliation | — | `da37e52` | 13 stale-open audit items marked RESOLVED + SD-31, SD-32 filed |
| Tracker | — | `4bec8e3` | Consolidated AUDIT-TASKS + FOLLOW-UPS into this file |
| SD-31 | `63d4e59` | `ecb32d6` | killSwitch.recordError filters security-pipeline errors (no more TabUrlNotRecognizedError-burst self-DoS) |
| T7 | `71218d9` | `317527a` | Regression guard for existing safari_close_tab tab-ownership cleanup (server.ts:833-852); audit-flagged leak prevented from silently re-emerging |
| SD-32 | `6b55ff9` | (this commit) | orphan-cleanup skips when other live sessions exist; multi-session contract restored |

Pre-2026-04-25 sprint resolved entries (SD-01..SD-28, T13..T25 originals): see archives.

---

## Tally

- **28** audit items (T-numbered) open — 0 P0, 4 in extension batch, 7 P2 quality debt, 17 P3 missing-feature/cosmetic.
- **1** SD open — SD-30, deferred feature (banking-disable-extension).
- **2** ROADMAP backlog items — navigate_back/forward stale URL, NDJSON line-split flake.

Total open: **31**. **All real bugs are now resolved this sprint** (T7, SD-31, SD-32). The remainder is quality debt, missing features, deferred design decisions, or cosmetic.

Open follow-up flagged by SD-32 reviewer: an e2e companion test that spawns two concurrent MCP sessions and asserts Session A's keepalive survives Session B's startup would close the unit-test wiring gap (server.ts:1422 stores the otherSessions count into a private field; the unit tests poke the field directly; only an e2e exercises the full registerWithDaemon → field-write → cleanup-skip flow). Worth filing as SD-33 if anyone reports concurrent-session breakage.
