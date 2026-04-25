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
*All shipped this sprint.* T34/T37/T38/T39/T40 + T35 + T36 resolved. See "Resolved this sprint" below.

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
| **T59** ⬅ IN PROGRESS | `src/tools/extraction.ts` (`safari_take_screenshot`) + `src/security/` | domain-allowlist screenshot policy — handler-level `ScreenshotPolicy` check, `ScreenshotBlockedError`, frontmost-tab AppleScript fallback, operator-configurable seed list. Threat-model decided 2026-04-26 (spec: `docs/upp/specs/2026-04-26-threat-model-decisions.md`). Plan: `docs/upp/plans/2026-04-26-t59-screenshot-domain-policy.md`. Branch: `fix/t59-screenshot-domain-policy`. |

### Deferred features (intentional, filed for later)

*SD-30 permanently closed 2026-04-26 (moved to Resolved). SD-33 split into 4 sub-items below (moved to Resolved).*

### HealthStore wiring sub-items (SD-33 split, P3)

| ID | Surface | One-liner |
|---|---|---|
| **SD-33a** | `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | Wire `incrementRoundtrip()` — call site: `handle()` success path after a command result is returned to the bridge. Discriminator: `roundtripCount1h` reads non-zero after dispatching one extension command. |
| **SD-33b** | `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` or `CommandDispatcher.swift` | Wire `incrementTimeout()` — call site: command deadline expiry branch where a command is aborted past its deadline. Discriminator: `timeoutCount1h` reads non-zero after forcing a command timeout. |
| **SD-33c** | `daemon/Sources/SafariPilotdCore/` (grep required) | INVESTIGATE `incrementUncertain()` — no verified production uncertain path found by grep. Phase 1: determine whether an uncertain state is reachable in the current storage-bus IPC flow. If path exists → wire. If no path → delete method, backing array, accessor, test. Do NOT wire to an invented call site. |
| **SD-33d** | `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Wire `incrementForceReload()` — call site: inside the `forceReloadExtension()` recovery flow. Discriminator: `forceReloadCount24h` reads non-zero after calling `forceReloadExtension()`. |

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
| SD-32 | `6b55ff9` | `170592e` | orphan-cleanup skips when other live sessions exist; multi-session contract restored |
| T37 | `d82c534` | `b4687de` | Deleted unused `recordPreExisting` + `isPreExisting` from `TabOwnership` (zero callers; positive-ownership model makes them redundant) |
| T39 | `cae41d8` | `1c7e310` | `recordHttpRequestError` now prunes entries older than 1h on append (re-scoped from 4 arrays to 1; the other three were unwired and filed as SD-33) |
| T34 | `b7d57b7` | `65c2297` | `ENGINE_CAPS.extension.framesCrossOrigin` flipped `true → false` to match manifest reality (no `all_frames` in content_scripts); cap-vs-manifest parity test guards future drift, will require flip-back when T55 lands |
| T38 | `1479e63` | `6effb86` | `recoverSession` now re-calls `registerWithDaemon()` after both success branches (window-only + extension-recovery), keeping the daemon session registry consistent across daemon restarts and preserving the SD-32 multi-session contract |
| T40 | `09d2bf7` | `09d2bf7` | `ARCHITECTURE.md` brought current — verified date refresh, cross-origin frames claim removed (T34), 12-of-17-modules drift, recoverSession T38 step, T39 + SD-33 caveat on the unwired `roundtrip`/`timeout`/`uncertain` counts. Of the audit's original 8 claims, 4 had been resolved by intervening commits (T8/T12/T24); 4 needed actual edits this commit; +1 found via parallel verification (12-vs-13 inconsistency). |
| T35 | `1626ca9` | `b1aa987` | Renamed `IdpiScanner` → `IdpiAnnotator` (file, class, method `scan()` → `annotate()`, type `ScanResult` → `AnnotationResult`); dropped "scanner" framing across ARCHITECTURE.md / CLAUDE.md / EXECUTION-FLOWS.md / e2e test header. No behavioural change — pure rename. Class header documents the well-defined route from annotator → scanner if a future threat-model review wants real blocking. |
| T36 | `74e4847` | (this commit) | Deleted `ScreenshotRedaction` no-op layer (164 LOC + 7 unit tests + 1 e2e test + wiring at server.ts:945-952). The module returned a CSS-blur script in `_meta.redactionScript` but the script was never injected before `screencapture -x`, and the OS-level capture is immune to CSS blur regardless. Domain-block screenshot policy (the actually-useful primitive) filed as T59 for separate scheduling. |
| SD-30 | — | `5800d8f` | Permanently deferred. Extension has 4 unique capabilities applescript lacks (httpOnly cookies, network intercept, CSP bypass, shadow DOM) — accepted risks. Complexity of per-domain engine restriction not justified by defense-in-depth marginal gain. Decision recorded in `docs/upp/specs/2026-04-26-threat-model-decisions.md`. |
| SD-33 | — | `5800d8f` | Wire decision: wire SD-33a/b/d; investigate SD-33c first. Split into 4 sub-items filed under "HealthStore wiring sub-items" in open table. Decision recorded in `docs/upp/specs/2026-04-26-threat-model-decisions.md`. |

Pre-2026-04-25 sprint resolved entries (SD-01..SD-28, T13..T25 originals): see archives.

---

## Tally

- **22** audit items (T-numbered) open — 0 P0, 4 in extension batch, 0 P2 quality debt (all shipped), 18 P3 missing-feature/cosmetic (T59 in progress).
- **4** SD open — SD-33a/b/c/d (HealthStore wiring sub-items, split from SD-33 parent 2026-04-26). SD-30 and SD-33 parent resolved.
- **2** ROADMAP backlog items — navigate_back/forward stale URL, NDJSON line-split flake.

Total open: **28**. SD-30 permanently closed + SD-33 split into 4 atomic sub-items (net +2 vs prior 26). T59 in progress — threat-model decided, spec and plan committed, branch `fix/t59-screenshot-domain-policy` pending. P2 quality debt remains empty.

Open follow-up flagged by SD-32 reviewer: an e2e companion test that spawns two concurrent MCP sessions and asserts Session A's keepalive survives Session B's startup would close the unit-test wiring gap (server.ts:1422 stores the otherSessions count into a private field; the unit tests poke the field directly; only an e2e exercises the full registerWithDaemon → field-write → cleanup-skip flow). Worth filing as SD-33 if anyone reports concurrent-session breakage.
