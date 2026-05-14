# Checkpoint
*Written: 2026-05-14 12:00 — pause requested mid-research*

## Current Task

**Phase 1 systematic-debugging COMPLETE. Research phase BEGUN but PAUSED before getting results.**

User invoked upp:systematic-debugging to find what to address (NO fixes), then asked me to research the addressable items + assumptions. Phase 1 diagnostic done — major reframe of what the "10 persistent regressions" actually are. Research dispatch was just starting (parallel:research with 10 topics R1-R10) when user requested pause-and-checkpoint.

## Progress

### v0.1.34 sprint final state
- 17 of 20 plan tasks completed (T1-T17 + T7b inserted task)
- T18 bench gate executed in 2 passes — FAIL all 3 acceptance criteria
- T19 (docs) drafted, REVERTED (won't ship v0.1.34)
- T20 (ship) NOT executed — sprint deferred per user choice (B')
- Branch `feat/v0134-csp-bypass` at HEAD `3daddce`

### Phase 1 diagnostic (NEW, just completed)
Durable on disk: `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md`

**Key reframe:** of "10 persistent regressions" — only 2 are real product bugs.
- 5 are judge-strictness (correct text answer; screenshot doesn't visually confirm)
- 3 are stale-date tasks (Google Flights Jan-Mar 2024 dates that the site rejects)
- 2 are real agent mistakes (Booking--5 shortcut, Google Search--14 wrong person)

**Bigger structural finding:** 41% of baseline failures (19/46) are stale-date tasks UNRECOVERABLE for any agent. The spec acceptance criterion `≥30/47 recovery` was unrealistic from the start.

**Sentinel envelope drift hypothesis: FULLY REFUTED** — verified all 7 refactored tools (click/fill/type/scroll/get_text/query_all/snapshot) return byte-equivalent shapes to v0.1.33.

**Real v0.1.34 behavioral shift:** 4 distinct nudges away from safari_evaluate accumulate (3 new tool descriptions say "Use in place of safari_evaluate" + safari_evaluate's own description says "prefer query_all" + 7 tools added requiresCspBypass). Result: agent dropped safari_evaluate usage 50%, picked up query_all+click combos which are 2× tool calls on multi-step tasks.

### Research phase — DISPATCHED but NOT RECEIVED
Just kicked off `parallel:research` with 10 topics R1-R10:
- R1 WebVoyager SOTA (Browser Use, Stagehand, Anthropic computer-use, Convergence)
- R2 WebVoyager judge mechanism + community alternatives
- R3 Stale-date task handling
- R4 Agent honesty vs fabrication
- R5 Tool description bias
- R6 Compound tools (evaluate_then_act)
- R7 Site recipes / playbook architectures
- R8 Anti-thrash mechanisms
- R9 Alternative bench evals (Mind2Web, WebArena, BrowseComp, etc.)
- R10 Bench protocol best practices (single-run vs majority-of-N)

Pause arrived before parallel:research returned. Resume by re-invoking the skill with the same args (full prompt preserved in TRACES iter 84 below + in the assistant message just before this checkpoint).

## Key Decisions (just made, codifying here)

1. The "v0.1.34 bench gate failure" framing is misleading. v0.1.34 is +5 net aggregate AND median per-task is BETTER (-1 turn, -$0.027). The acceptance failures are bench-design issues + 4-nudge tool description bias + 2 real agent bugs.
2. The user-chosen v0.1.35 H1-H10 plan needs RE-RANKING based on this diagnostic:
   - **H3a Google Flights site recipe is REFUTED** as a fix — Google Flights regressions are 100% stale-date, not date-picker fumbles. No recipe can search past dates.
   - **H1 (soften CSP nudging) is now BACKED by quantified evidence** — 4 distinct nudges, agent's safari_evaluate usage halved.
   - **The 5 judge-strictness regressions** require either bench changes (not in our control) OR screenshot-improvement strategies (post-action snapshot, scroll-to-evidence-before-screenshot).
   - **The 3 stale-date regressions** are not addressable in the product — need to research date-substitution practices in WebVoyager community.
3. The v0.1.35 sprint plan should be re-formulated AFTER the research returns. The current v0.1.35 starter spec at `docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md` is rooted in the WRONG diagnosis (assumed regressions are sentinel bugs); it needs revision.

## Next Steps

### Resume command for fresh session
```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
git log --oneline -5    # verify HEAD includes 3daddce
cat bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md  # the corrected diagnostic
cat docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md  # OLD plan (needs revision per Phase 1 reframe)
```

### To resume research (Phase 2)
Re-invoke `parallel:research` with the same prompt that's in TRACES iter 84 (or in the assistant message immediately preceding this checkpoint). Expected output: structured report with citations + confidence + ranked v0.1.35 recommendations. ~5-15 min wall-clock for parallel:research with 10 topics.

### After research returns
1. Re-rank v0.1.35 hypotheses per Phase 1 + research findings
2. Discard H3a (Google Flights recipe refuted)
3. Likely promote: H1 (4-nudge unwind), bench-design changes (custom date substitution per stale-date research), screenshot-strategy changes (per judge-strictness research)
4. Discuss alternative bench (R9 findings) — maybe v0.1.35 chases Mind2Web or BrowseComp instead of WebVoyager
5. Revise v0.1.35 starter spec
6. Then invoke upp:writing-plans

## Context

### Repo state
- Branch: `feat/v0134-csp-bypass` at HEAD `3daddce`
- Working tree: clean modulo CHECKPOINT.md modified now + 2 daemon/ untracked
- Extension binary: 0.1.34-dev.4 (16 sentinels in binary, verified)
- Daemon: v0.1.33

### Files added this Phase 1 session (durable)
- `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md` — corrected diagnostic with assumption audit + per-task root cause categorization + 4-nudge analysis + items-to-address list

### Files NOT yet updated (deferred to post-research)
- `docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md` — based on wrong diagnosis; will revise after research returns
- TRACES iter 84 — will write when research returns; should record both Phase 1 reframe + research findings together

### Cumulative session accounting
- Wall-clock this multi-session sprint: ~24+ hours
- Bench spend: $116.10
- Subagent + analysis spend: ~$70-90
- Total: ~$190-210
- v0.1.34 ship outcome: NONE (deferred); v0.1.35 plan being re-formulated based on Phase 1 reframe + pending research

### v0.1.35 sprint REVISED carry-forwards (from Phase 1 reframe)
- 2 real agent bugs (Booking--5 + Google Search--14)
- 4-nudge stack against safari_evaluate (H1-equivalent)
- Snapshot thrash on impossible tasks (related to honesty-vs-fabrication asymmetry)
- 5 judge-strictness regressions (need bench-side or screenshot-strategy work)
- 3 stale-date regressions (need WebVoyager community research — not product work)
- Bench protocol decisions deferred to research (single-run vs majority-of-N)
- ALL of v0.1.34's known limitations carry forward (5 secondary interaction tools, bfcache idempotency, generateQueryAllJs not rerouted, etc.)
