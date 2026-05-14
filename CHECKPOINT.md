# Checkpoint
*Written: 2026-05-14 12:45 — Phase 2 research complete*

## Current Task

**Phase 1 systematic-debugging COMPLETE. Phase 2 research COMPLETE. Awaiting user direction on whether to revise v0.1.35 spec now.**

User invoked upp:systematic-debugging to find what to address (NO fixes), then asked to research the addressable items + assumptions. Both phases done. Next step is revising the v0.1.35 starter spec per Phase 1 reframe + Phase 2 research findings, then invoking upp:writing-plans.

## Progress

### v0.1.34 sprint final state
- 17 of 20 plan tasks completed (T1-T17 + T7b inserted task)
- T18 bench gate executed in 2 passes — FAIL all 3 acceptance criteria
- T19 (docs) drafted, REVERTED (won't ship v0.1.34)
- T20 (ship) NOT executed — sprint deferred per user choice (B')
- Branch `feat/v0134-csp-bypass` at HEAD `4960ae3`

### Phase 1 diagnostic — DONE
Durable on disk: `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md`

**Key reframe:** of "10 persistent regressions" — only 2 are real product bugs.
- 5 are judge-strictness (correct text answer; screenshot doesn't visually confirm)
- 3 are stale-date tasks (Google Flights Jan-Mar 2024 dates that the site rejects)
- 2 are real agent mistakes (Booking--5 shortcut, Google Search--14 wrong person)

**Structural finding:** 41% of baseline failures (19/46) are stale-date tasks UNRECOVERABLE for any agent. Spec acceptance criterion `≥30/47 recovery` was unrealistic.

**Sentinel envelope drift hypothesis: FULLY REFUTED** — all 7 refactored tools return byte-equivalent shapes to v0.1.33.

**Real v0.1.34 behavioral shift:** 4 distinct nudges away from safari_evaluate accumulate. safari_evaluate usage halved (2.17 → 1.07/task), agent shifted to query_all+click combos.

### Phase 2 research — DONE
Durable: `bench-runs/webvoyager-v0.1.34-bench-20260514/research-r1-r10.md` (27 KB synthesis) + `.json` (full 600 KB data + basis citations).

**Critical findings (validate Phase 1 hard):**

1. **All SOTA performers patch the benchmark.** Magnitude 93.9% with `patches.json` for stale-date + impossible task removals. Browserable 90.4% after removing 56 tasks (643→567). Kura 87% with documented "Benchmark Adjustments." This is the industry norm, not an edge case.

2. **Anthropic Computer Use scored 56% on a 50-task subset (Kura's head-to-head).** Safari Pilot at 73.7% on the unpatched 184 is competitive on raw score; the gap to SOTA is partly the patching gap.

3. **Original WebVoyager paper itself uses 3-run mean ± std** with κ≈0.70 human agreement. Single-run is below the canonical protocol.

4. **WebVoyager auto-judge is GPT-4V on last-k screenshots** — practitioners universally acknowledge it produces false negatives, manual review is standard.

5. **WebArena explicitly tests honesty via "N/A" tasks** — abstention is a designed-in evaluation dimension. Safari Pilot's stale-date "honest fail" pattern is a feature, not a bug, against bench evolution.

6. **Anthropic BrowseComp documents "eval awareness"** — agents searching for benchmark answer keys is a real threat. Need to guard against this.

### Top-ranked recommendations from research (full list in research-r1-r10.md)

| # | Recommendation | Maps to |
|---|---|---|
| 1 | Establish patched WebVoyager protocol (`patches.json` for dates, formal removal of impossible tasks) | R3 — addresses 19/46 stale-date failures |
| 2 | Multi-run audited judge (majority-of-3 + human spot-audits) | R2 — addresses 5 judge-strictness regressions |
| 3 | Anti-thrash controls (step caps, loop detection, reflective checkpoints) | R8 — addresses snapshot thrash on impossible tasks |
| 4 | "Final-proof" tool (compose evidence-grounded screenshot before answer) | R2 — addresses judge-strictness |
| 5 | Light-weight site-specific playbooks (date normalization, cookie/captcha handling, rate-aware pacing) | R7 — addresses BBC News, GitHub rate-limit etc. |
| 6 | Dual-metric reporting (efficacy + efficiency: Pass@1 + steps + wall + cost) | R1 |
| 7 | Abstention policy for impossible tasks | R4 |
| 8 | Multi-benchmark portfolio (add VisualWebArena, Online-Mind2Web) | R9 |
| 9 | Anti-contamination (blocklist benchmark search terms, audit traces) | R4 |
| 10 | Internal A/B on tool-description wording bias | R5 |

## Key Decisions (codified)

1. The "v0.1.34 bench gate failure" framing was misleading. v0.1.34 is +5 net aggregate AND median per-task is BETTER (-1 turn, -$0.027). The acceptance failures are bench-design issues + 4-nudge tool description bias + 2 real agent bugs.

2. **The current v0.1.35 starter spec at `docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md` is rooted in the WRONG diagnosis** (assumes regressions are sentinel bugs / agent fumbles). Needs full revision.

3. **H3a Google Flights site recipe is REFUTED.** 100% of GF regressions are stale-date — no recipe can search past dates. Recipe approach should pivot to date-normalization + abstention, not date-picker logic.

4. **The right v0.1.35 framing per research:** bench-protocol changes (patched bench + multi-run + anti-thrash) FIRST, then product changes (4-nudge unwind + 2 real bugs + final-proof tool + abstention + light playbooks).

## Next Steps

### Awaiting user direction
- (A) **Revise the v0.1.35 spec now** based on Phase 1 + Phase 2 findings, then invoke upp:writing-plans (Recommended path).
- (B) **Pause for user review of the research findings** before any further work.
- (C) **Different direction** — e.g. switch primary bench to Online-Mind2Web, run a tighter focused sprint (just bench-patching + final-proof tool), etc.

### If (A): revised spec outline
1. Section 1 — diagnosis (Phase 1 reframe + research validation)
2. Section 2 — NEW acceptance criteria (patched-2026 + comparable-original split, multi-run, dual-metric)
3. Section 3 — bench-protocol slice (patches.json, majority-of-3 judge, anti-thrash, multi-bench portfolio decision)
4. Section 4 — product slice (4-nudge unwind, 2 bug fixes, final-proof tool, abstention policy, light playbooks for date-normalization + cookie/rate-limit)
5. Section 5 — out of scope (drop H2 compound tool unless research surfaces specific evidence; drop H3a; drop H6 tier surface unless prioritized)

## Context

### Repo state
- Branch: `feat/v0134-csp-bypass` at HEAD `4960ae3`
- Working tree: CHECKPOINT.md modified now + 2 daemon/ untracked
- Extension binary: 0.1.34-dev.4 (16 sentinels in binary, verified)
- Daemon: v0.1.33

### Files added Phase 1+2 (durable, gitignored but on disk)
- `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md` — corrected diagnostic
- `bench-runs/webvoyager-v0.1.34-bench-20260514/research-r1-r10.md` — Phase 2 synthesis
- `bench-runs/webvoyager-v0.1.34-bench-20260514/research-r1-r10.json` — full citations + basis

### Files to update post-direction
- `docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md` — full revision pending
- `TRACES.md` iter 84 — pending (will record both Phase 1 + Phase 2 together)

### Cumulative session accounting
- Wall-clock this multi-session sprint: ~24+ hours
- Bench spend: $116.10
- Subagent + analysis spend: ~$70-90
- Phase 2 research: ~$3 (pro-fast deep research, 8m20s)
- Total: ~$190-210
- v0.1.34 ship outcome: NONE (deferred); v0.1.35 plan being re-formulated based on Phase 1 + 2

### v0.1.35 sprint REVISED carry-forwards (from Phase 1 + 2)
- Patches.json infrastructure (bench-side, applies to baseline + future runs)
- Multi-run majority-of-3 judge protocol
- Anti-thrash controls (step caps, loop detection, reflective checkpoints)
- 4-nudge unwind on tool descriptions
- 2 real agent bugs (Booking--5 + Google Search--14)
- Final-proof tool (evidence-grounded screenshot before answer)
- Abstention policy for impossible tasks
- Light playbooks (date normalization, cookie handling, rate-aware pacing) — NOT site-specific recipes
- Dual-metric reporting (Pass@1 + steps + wall + cost)
- Eval-contamination guards
- ALL of v0.1.34's known limitations carry forward (5 secondary interaction tools, bfcache idempotency, generateQueryAllJs not rerouted, etc.)
