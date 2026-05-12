# Checkpoint
*Written: 2026-05-12 00:00*

## Current Task
v0.1.31 evidence-grounding sprint **shipped as v0.1.32 with full documentation refresh**. 23/24 implementation tasks complete + 1 docs-update commit. **Only T24 (175-task WebVoyager bench gate)** remains and is user-driven (Anthropic Max quota window + 6-10h wall-clock required).

## Progress

### Done (24 commits on `feat/v0131-evidence-grounding`, all from `main`)
- [x] T1-T9 (prior session, ending at `5820bca`): error codes, allowlist loader+content, scroll fixtures, scroll tool pair, scroll e2e, dismiss fixtures + 14 paired negative fixtures
- [x] T10+T11 (`27d77ef` atomic + `ea98091` path-fix): safari_dismiss_overlays tool + sentinel + IdpiAnnotator scan + sanitization + kill switch + paywall opt-in flag
- [x] T12+T13 (`c3460fa`): dismiss e2e 11/11 + locator shadow-DOM matchSignal fix + version bump 0.1.31→0.1.32 + extension rebuild (notarized)
- [x] T14 (`9fbe4de` + `25d1b73`): 14 per-pattern integration tests (28 assertions) + smart-app-banner pattern fix
- [x] T15-T17 (`2bb42a8`): 4 SKILL.md files + plugin.json registers all 8 skills + SessionStart date inject + hook unit test
- [x] T18+T19 (`60b2bed`): /safari-pilot:stats CLI + 4 unit + 1 e2e
- [x] T20+T21 (`a052e1a`): pre-tag-check 9→11 gates + content-only-patch.sh + CHANGELOG v0.1.32
- [x] T22+T23 (`2f02c39`): v0.1.32 notarized + stapled artifacts committed; pre-tag-check 11/11 PASS
- [x] TRACES iter 75 (`5feface`) + iter 76 (`dd5dddd` brief)
- [x] **Documentation refresh** (`dd5dddd`): ARCHITECTURE.md + CLAUDE.md + README.md updated for v0.1.32 — tool count 82→88 (was stale by 6: 5 prior un-documented modules + 1 new), Tool Modules table reflects current state, new sections for safari_scroll_to_element + safari_dismiss_overlays with sentinel/dispatch/mitigation detail, IDPI EXTRACTION_TOOLS extension noted, v0.1.30 + v0.1.32 entries in version history, test counts updated, Project Layout reflects new directories. Verified math: README section counts = 88 = real MCP runtime exposure.

### Not done (1/24, user-gated)

- [ ] **T24: 175-task WebVoyager bench gate.** Cannot run in this session. Requires:
  - Anthropic Max quota refresh (≥5h since last `claude -p` session)
  - 6-10 hours wall-clock for the 175-task dev sample
  - User to drive (needs your machine + quota window)
  - **Acceptance criteria** (do NOT push tag if any fails):
    - Allrecipes 12/12 holds (no regression on the most-stable site)
    - Any site with ≥80% baseline doesn't drop more than 1 task
    - `capture_failure_rate ≤ 10.4%` (no degradation from v0.1.30 partial baseline)
    - Per-failure-subset monotonic improvement: cookie/overlay ≥2 task flips, hallucination ≥1, temporal ≥1

## Key Decisions (not yet persisted)

**All decisions already persisted.** No untracked decisions remain. Specifically:
- v0.1.33 carry-forwards are documented in `CHANGELOG.md`'s `### Carry-forward to v0.1.33` section AND in TRACES iter 75 — see `feedback_v0132_carry_forwards` mental anchor (3 items: daemon Models.swift bool/int coercion; allowlist pattern over-broadness + collision; `skipped[]` sanitization + `MALFORMED_SENTINEL` error name distinct from NO_LOCATOR).
- The documentation audit surfaced one additional v0.1.33 candidate (now also persisted in TRACES iter 76 + ARCHITECTURE.md tool-modules table footnote): **`selector-pack.ts` module exists with 2 tool definitions but is wired into neither `listToolDefinitions()` nor `initialize()` modules array — dead code shipping in source.** Either remove the module or register it.

## Next Steps

### When ready to ship v0.1.32 (T24 + tag push)

```bash
# 1. Confirm Anthropic Max quota is fresh (>5h since last claude -p session)
# 2. Run the 175-task WebVoyager dev sample (resume-aware)
#    Protocol: docs/benchmarking.md
bash bench/run.sh   # adjust to canonical bench harness invocation

# 3. Score the run
node dist/bench/webvoyager/score.js <run-dir>

# 4. Verify acceptance criteria (see this CHECKPOINT.md → T24 section)
#    Cross-check against v0.1.30 partial-67 baseline preserved at:
#    bench-runs/webvoyager-v0.1.30-baseline-20260508-050932/

# 5. Re-run pre-tag-check to confirm 11/11 still green after any final commits
bash scripts/pre-tag-check.sh

# 6. If acceptance gates pass, push branch + tag
git push -u origin feat/v0131-evidence-grounding
git tag -a v0.1.32 -m 'release notes — copy from CHANGELOG.md v0.1.32 section'
git push origin v0.1.32
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')

# 7. After CI release.yml succeeds, merge branch to main
git checkout main && git merge feat/v0131-evidence-grounding && git push origin main
git branch -d feat/v0131-evidence-grounding
```

### If T24 acceptance criteria fail

Do NOT modify the benchmark. Invoke `upp:systematic-debugging`. Most-likely v0.1.32-vs-v0.1.30 regression modes:
- Dismiss-overlays causing unintended page navigation (esc-key fallback)
- Scroll-to-element timing out on heavy pages
- Pattern false-positives dismissing legitimate UI on real sites
- Bool-coercion bug in daemon manifesting in score computation (use asInt normalizer if `verified` flags arrive as integers)

### Things explicitly NOT to do

- Do NOT push the v0.1.32 tag without T24 PASS.
- Do NOT touch the daemon `Models.swift` bool-coercion bug — v0.1.33 scope.
- Do NOT re-introduce `--skip-notarize` (memory `feedback-no-skip-notarize`).
- Do NOT modify benchmark tasks or eval criteria to inflate scores (memory `feedback-benchmarks-are-sacred`).
- Do NOT run `osascript 'quit'` or `pkill Safari` (CLAUDE.md hard rule #6).

## Context

### Repo state at checkpoint time

- **Branch:** `feat/v0131-evidence-grounding` at HEAD `dd5dddd`, **24 commits ahead of `main`**.
- **Working tree:** clean except 2 untracked v0.1.30 carry-forwards (`daemon/CLAUDE.md`, `daemon/TRACES.md`) — out of scope.
- **Active extension:** v0.1.32 (build 202605082306), notarized + stapled + Gatekeeper-accepted. All 5 health checks PASS at last verification. Daemon HTTP `/status` showed `ext: true` after the build-extension.sh + `open bin/Safari Pilot.app` sequence.
- **Tests:** 668 unit + 46 e2e PASS. Lint clean (only pre-existing TS6133 in untouched code at server.ts:125,551,1563 and content-main.js:112,263).
- **Pre-tag-check:** 11/11 PASS at last full run.
- **Published version:** v0.1.32 in both `package.json` and `extension/manifest.json`. Sprint scope-label was "v0.1.31"; published as v0.1.32 because mid-sprint marketing-version bump was required for Safari extension cache invalidation. The "v0.1.32 sprint" label originally referred to bool-coercion + pattern hardening — that scope shifts to **v0.1.33** (CHANGELOG documents).

### Commit chain (full sprint, oldest → newest)

```
dd5dddd docs: update ARCHITECTURE.md + CLAUDE.md + README.md for v0.1.32
5feface docs(traces): iter 75 — v0.1.31 sprint complete (published as v0.1.32), 23/24 done
2f02c39 build(extension): v0.1.32 notarized + stapled artifacts
a052e1a ci+docs(T20+T21): pre-tag-check allowlist gates + CHANGELOG v0.1.32 entry
60b2bed feat(cli): /safari-pilot:stats local metrics CLI + 4 unit + 1 e2e
2bb42a8 feat(plugin): 4 new skills + plugin.json registration + SessionStart date inject (T15-17)
25d1b73 fix(overlays): smart-app-banner pattern — body+fixed-position not head-meta+body
9fbe4de test(e2e): per-pattern integration tests (14 patterns × positive/negative) (Task 14)
c3460fa test(e2e): dismiss-overlays full suite (T12+T13) + locator shadow-DOM fix + v0.1.32
b5dafbd docs(traces): iter 74 — v0.1.31 Tasks 10+11 atomic dismiss-overlays pair shipped
ea98091 fix(dismiss): resolve overlays/ as sibling of server.js, not parent
27d77ef feat(dismiss): safari_dismiss_overlays tool + sentinel + IdpiAnnotator scan extension (T10+T11)
5820bca chore: checkpoint + TRACES iter 73 (v0.1.31 mid-sprint, 9/24 tasks)
a75e912 test(fixtures): per-pattern negative fixtures (safety net) (Task 9)
289e698 test(fixtures): dismiss-overlays positive fixtures + danger fixture (Task 8)
d93c09b test(e2e): scroll-to-element 6 assertions (Task 7)
f548d06 chore(build): remove --skip-notarize flag from build-extension.sh
36e2a47 chore(release): lockstep version bump to v0.1.31 (Task 22 pulled forward)
cecd587 feat(scroll): safari_scroll_to_element tool + sentinel + locator helpers (T5-6, atomic)
48c8051 docs(plan): correct Tasks 5+6 and 10+11 sentinel host (Option A)
bf65ffc test(fixtures): scroll-to-element fixtures (4 servers) (Task 4)
abbdd34 feat(overlays): v1 allowlist content — 4 categories, ~14 patterns (Task 3)
0843820 feat(overlays): allowlist loader + schema validator + two-signal rule (Task 2)
e8a93e2 feat(errors): add TARGET_NOT_FOUND, TARGET_HIDDEN metadata-only codes (Task 1)
```

### Two real bugs caught + fixed mid-sprint

1. `extension/locator.js matchSignal('selector')`: `hostDoc.querySelector(value)` → `el.matches(value)`. The former returns false for shadow-encapsulated elements (hostDoc is the outer light-DOM document). Fixed in `c3460fa`.
2. `smart-app-banner` allowlist pattern: head-meta + body-selector double-selector form was unmatchable. Replaced head-meta with `fixed-position` structural discriminator. Content-only patch (no extension rebuild). Fixed in `25d1b73`.

### v0.1.33 carry-forwards (DEFERRED, not addressed in v0.1.32)

1. **daemon `Models.swift` AnyCodable bool/int coercion** (live bug; tests use `asInt()` normalizer workaround)
2. **Allowlist pattern over-broadness + collision detection:** `generic-newsletter-modal`, `generic-aria-cookie`, `generic-newsletter-modal`-vs-`substack-bottom-banner` registry-order collision
3. **`skipped[]` field-level sanitization + outer try/catch error tagging:** sanitization stops at `dismissed[]`; `skipped[].candidate.hint` passes through; JSON.parse failures in dismiss intercept tag as `NO_LOCATOR` (semantic mismatch — should be `MALFORMED_SENTINEL`)
4. **`selector-pack.ts` dead code** (surfaced this session during doc audit): module exists with 2 tool definitions but neither `listToolDefinitions()` nor `initialize()` registers it. Either wire it (decide which) or remove the module.

### Anthropic Max quota status

Per CHECKPOINT iter 73 close: Max subscription was depleted by the v0.1.30 partial-67 run. Today is 2026-05-12 — 4 days since the prior depletion. Quota should be fresh; verify before kicking off T24.
