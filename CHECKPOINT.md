# Checkpoint
*Written: 2026-05-14 11:30*

## Current Task

**v0.1.34 sprint DEFERRED.** Bench gate failed all 3 acceptance criteria; user chose option (B') to fold into v0.1.35. Branch `feat/v0134-csp-bypass` (HEAD `d3fee62`) stays unmerged. v0.1.35 starter spec written.

## Progress

### v0.1.34 sprint final state
- 17 of 20 plan tasks completed (T1-T17 + T7b inserted task)
- T18 bench gate executed — FAIL on all 3 acceptance criteria (see deep-analysis.md)
- T19 (docs) had placeholder edits drafted; REVERTED since v0.1.34 not shipping
- T20 (ship) NOT executed
- All sprint code preserved on branch as v0.1.35 foundation

### Bench numbers (final)
- Aggregate: 133/184 = **72.3%** vs baseline 128/184 = 69.6% (+5 net)
- Failure recovery: 18/46 (need ≥30) — short by 12
- Spot-check regressions: 10 (need 0)
- Per-site: Apple 8/12 ✅ | Google Flights 2/11 ❌ | Google Search 8/11 ❌
- Total spend: $116.10 ($83.23 first bench + $32.29 retry + $0.58 smokes)
- Of 13 originally-flagged regressions: 3 flake, 10 persistent

### v0.1.35 starter sprint (NEXT)
Spec at `docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md`. 10 hypotheses (H1-H10) ranked by ROI. Estimated 13 eng days, target +8-15 bench tasks + −30-40% cost.

Top 3 highest-ROI:
- **H1 (1h)** — Soften CSP_BLOCKED error UX nudging (agent learned to fear safari_evaluate)
- **H2 (1.5d)** — `safari_evaluate_then_act` compound MCP tool (collapses query_all + click → 1 call)
- **H3a-c (5.5d)** — Site recipes for Google Flights, Booking, Google Map (50% of bench cost)

## Key Decisions (codified in TRACES iter 83)

1. v0.1.34 deferred per user choice (B'). Branch stays.
2. v0.1.34 bench data is **rich diagnostic input**, not a failure to bury. Same-task pair analysis shows v0.1.34 median is BETTER (−1 turn / −$0.027 cost). The bench-acceptance failure is dominated by site-specific multi-step task fumbling (Google Flights date pickers).
3. The "agent learned to fear safari_evaluate" finding is the **central root cause**. Tool usage shifted: evaluate −50%, query_all +440%. H1 reverses this.
4. The 10 persistent regressions cluster on 3 patterns: date pickers (H2 + H3a/b), noisy data shortcuts (H5), and site complexity (H3a-c). All addressed in v0.1.35 plan.
5. WebVoyager flake confirmed empirically: 3/13 originally-flagged regressions resolved on retry. v0.1.35 will use 3-run bench protocol (H10) for cleaner acceptance signal.

## Next Steps

### Resume command for fresh session
```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
git log --oneline -5    # verify HEAD includes d3fee62 (harness opt-in patch) or beyond
git branch --show-current  # feat/v0134-csp-bypass
cat docs/upp/specs/2026-05-14-safari-pilot-v0135-efficiency-and-recovery.md  # the v0.1.35 plan
cat bench-runs/webvoyager-v0.1.34-bench-20260514/deep-analysis.md  # the diagnostic foundation
```

### v0.1.35 sprint kickoff
1. **Decide branching strategy:** keep working on `feat/v0134-csp-bypass` (and rename for clarity) OR cut a new `feat/v0135-efficiency-recovery` branch off it. Same code in both cases; cosmetic.
2. **Invoke `upp:writing-plans`** with the v0.1.35 spec as input to produce a detailed task-by-task plan
3. **Execute via `upp:executing-plans`** in subagent mode
4. Estimated wall-clock: ~13 eng days

### Bench data preserved (do NOT delete)
- `/tmp/wv-inline-runs-baseline-v0.1.33/` — v0.1.33 pristine baseline (184 score files)
- `/tmp/wv-inline-runs-v0.1.34/` — v0.1.34 first bench (106 score files)
- `/tmp/wv-inline-runs-v0.1.34-retry/` — retry round 2 (31 score files)
- `/tmp/wv-inline-runs/` — overlaid + judged (184 score files = current source-of-truth)
- `/tmp/wv-inline-runs-prejudge-snapshot/` — pre-retry-judge snapshot
- `/tmp/wv-judge-staging-retry/` — staging artifact
- `bench-runs/webvoyager-v0.1.34-bench-20260514/` — runner logs + analysis (gitignored but durable)

## Context

### Repo state
- Branch: `feat/v0134-csp-bypass` at HEAD (will be `d3fee62` + iter-83 TRACES + analysis commits below)
- v0.1.34 work preserved across ~28 commits (sentinels, locator port, rollback flag, etc.)
- Working tree: TRACES.md modified + CHECKPOINT.md modified + bench artifacts staged + v0.1.35 spec staged
- Extension binary on disk: 0.1.34-dev.4 (will be replaced by v0.1.35 builds)
- 16 sentinels in installed extension binary

### Cumulative session accounting (v0.1.34 sprint)
- Wall-clock this multi-session sprint: ~20+ hours
- Subagent spend: ~$50-70
- Bench spend: $116.10
- Total: ~$170-190
- v0.1.34 ship outcome: NONE (deferred)
- Knowledge produced: deep-analysis.md (sentinel envelope analysis, tool-shift quantification, site-specific patterns) + v0.1.35 starter spec

### v0.1.35 carry-forwards (still pending after v0.1.34 deferral)
ALL of v0.1.34's known limitations carry forward, plus:
- 10 persistent regressions (3 Google Flights, 2 ESPN, 1 Booking, 4 misc)
- The agent-fearing-evaluate behavioral shift (H1 priority fix)
- Site-recipe gap on cost-heavy sites (H3 priority)
- Bench protocol fragility (H10 priority)
