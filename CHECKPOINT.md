# Checkpoint
*Written: 2026-05-05 — after T11 of agent-benchmark-lift sprint*

## Current Task
Sprint: `docs/upp/plans/2026-05-05-agent-benchmark-lift.md`. Branch: `feat/agent-benchmark-lift`. Codified rules: `SPRINT-INSTRUCTIONS.md`.

Up next: **Task 5 — Cluster B InputSchema enum/pattern hardening.**

## Progress

- [x] T1 — Bench harness scaffold (`02c7a07` + fix `e3df72c`)
- [x] T2 — Six fixture tasks + 7 fixture routes (`fab42f2`)
- [x] T3 — Baseline locked (`cdf8ef6`). **TT0 = 12,396,305,183. Success 4/6.** Anchor at `bench/baselines/v0.1.28-baseline.json`.
- [x] T4 — Cluster A description rewrite (`4126f6e`). 46 parity-tier tools rewritten across 13 files.
- [x] T5 — Cluster B schema hardening (`b16667e` + fix `0025f6e`). Enums: console.level, snapshot.format, wait.condition. timeout min/max. selector minLength≥1 on 11 locator-using tools. 15/15 tests pass.
- [x] T6 — Cluster C locator-v2 adoption (`0dd6003`). 4 descriptions amended with chain/query_all/pack:<name> nudges.
- [x] T7 — **Iter-1 PASS** (`7cb9539`). TT=8.4B, ratio 0.677 vs target 0.80. Cluster F (system prompt) shipped early during RCA fix.
- [x] T8 — Cluster D-light tool search (`6baa8b8`). ToolIndex + safari_tool_search MCP tool.
- [x] T9 — Cluster F system prompt — already shipped in T7 RCA fix.
- [x] T10 — **Iter-2 close** (`7cb9539`). TT=8.82B, ratio 0.711 vs target 0.64 (missed by 7%). Temperature=0 added to agent for determinism. Success 5/6.
- [x] T11 — Cluster E skills (`61054e6`). 3 SKILL.md + safari_run_skill/list_skills.
- [x] T12 — Cluster G suggested_next_tools (`f35582b`). ToolResponseMetadata + navigate suggestion + HumanApproval block hint + system prompt directive.
- [x] T13 — **Iter-3 close** (`57205d3`). TT=11.0B, ratio 0.891 (target 0.51 missed). Per-iter trajectory: baseline 1.000 → iter-1 0.677 (best) → iter-2 0.711 → iter-3 0.891. Empirical finding: more surface past iter-1 hurt at the margin.
- [x] T14 — Cluster I recipe miner (`d66f53c`). mineRecipes + bench/mine-recipes.ts CLI. Browser Use harness pattern.
- [ ] **T15 — Final ship v0.1.29** (in_progress)
- [ ] T8 — Cluster D-light tool search
- [ ] T9 — Cluster F system prompt
- [ ] **T10 — Iter 2 measure** (gate ≤7.93B TT)
- [ ] T11 — Cluster E skills + safari_run_skill
- [ ] T12 — Cluster G suggested_next_tools
- [ ] **T13 — Iter 3 measure** (gate ≤6.32B TT)
- [ ] T14 — Cluster I recipe miner
- [ ] T15 — Final ship v0.1.29

## Iteration targets

| Iter | TT cap (× baseline) |
|---|---|
| Iter 1 | ≤ 9,917,044,146 (0.80×) |
| Iter 2 | ≤ 7,933,635,317 (0.64×) |
| Iter 3 | ≤ 6,322,115,643 (0.51×) |

## Baseline failures (= lift opportunity)
- 00-smoke: budget exhausted before completion (~20K input tokens × 3 turns hit 60K cap). Prompt-bloat problem → Cluster A/D should fix.
- 05-strict-mode: budget exhausted on multi-Sign-In disambiguation. Locator-v2 adoption (Cluster C) should fix.

## Compact-readiness
Safe to compact. State captured:
- Branch + HEAD: `feat/agent-benchmark-lift` @ `4126f6e`
- Plan + spec + sprint instructions on disk
- Bench harness operational (verified by baseline run)
- Fixture server still running on port 18080 (background process; PID in /tmp/fixture-bg.pid)
- Anthropic API key in ~/.secrets.zsh — must `source ~/.secrets.zsh` before bench runs

## Resume
1. Read `SPRINT-INSTRUCTIONS.md`, `docs/upp/plans/2026-05-05-agent-benchmark-lift.md`
2. Verify fixture: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/bench-smoke` (should be 200)
3. Continue with T5 (Cluster B schema hardening)

## Context
- 32 commits ahead of `main`'s previous head, but on a feature branch `feat/agent-benchmark-lift` (8 commits ahead of `main`).
- Tasks #107-#121 in TaskList track plan tasks. T1-T4 completed. T5 pending.
- Safari extension v0.1.28 enabled (user-confirmed prior session).
