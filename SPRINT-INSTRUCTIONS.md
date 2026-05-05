# Sprint: Agent Benchmark Lift — Codified Instructions

**Source:** User directive 2026-05-05. Do NOT skip any. Reload before every tool call.

## Hard rules (codified)

1. **UPP pipeline:** plan via `upp:writing-plans` → execute via `upp:executing-plans`. Skill instructions are NEVER skipped.
2. **TDD:** every code change goes RED → test-reviewer gate → GREEN. No production code without a failing test first.
3. **E2E via agent loops:** integration tests are *agent loops* against fixture pages, modeled on WebBench tasks. Mock-based tests do not count.
4. **Atomic units:** each task is one shippable thing. Plan → execute → ship → measure → next.
5. **Build constraint:** DO NOT build extension or daemon. Scope is agentic usage plumbing and discovery only.
6. **Scope filter:** Only solve for capabilities at ≥parity vs Playwright per `safari-pilot-vs-playwright-parity-v3.html`. Skip partial (◆) and gap (✗) features.
7. **Autonomy:** do not stop. Run through all clusters to ship.
8. **Checkpoint cadence:** write `CHECKPOINT.md` after every 2 atomic tasks. Recommend compact at that point. Resume.
9. **Debugging:** any bug → `upp:systematic-debugging` skill. Never ad-hoc fix.
10. **Stuck:** RCA + deep+wide research (parallel-cli research). Never guess.
11. **Iterations:** ≥3 iterations. Target 20% reduction in (wall time × tokens) on the agent benchmark per iteration.
12. **Inspiration:** Browser Use's `browser-harness` auto-skill-creation pattern (https://github.com/browser-use/browser-harness) is the reference architecture for skill bundles + recipe extraction. Cite/follow it in spec, plan, and execution.

## Scope — features at ≥parity per v3 matrix (only solve for these)

- **Cluster 02 Element interaction** (all 12 parity rows; skip 1 gap)
- **Cluster 03 Locators** (all 12 parity — fully resolved by v0.1.28; this is the freshly shipped surface)
- **Cluster 04 Auto-wait** (all 4 parity)
- **Cluster 05 Extraction** (all 10 parity, including T78 query_all)
- **Cluster 07 Auth & state** (all 8 parity)
- **Cluster 01 Navigation** (6 parity rows only; skip 3 partial)
- **Cluster 06 Network** (7 parity rows only; skip 2 partial + 1 gap)
- **Cluster 11 Security** (9 parity, exclusive to SP — show in benchmark scaffolding but don't optimize for Playwright comparison)

## Performance targets

| Iteration | Wall time | Tokens | Cumulative vs baseline |
|---|---|---|---|
| Baseline (H-0) | T0 | K0 | 1.00x |
| Iter 1 | ≤ 0.8 × T0 | ≤ 0.8 × K0 | 0.80x |
| Iter 2 | ≤ 0.64 × T0 | ≤ 0.64 × K0 | 0.64x |
| Iter 3 | ≤ 0.512 × T0 | ≤ 0.512 × K0 | 0.51x |

**Combined metric:** time × tokens (TT). Each iteration must reduce TT by ≥20%.

## Reference docs

- Deep research report: `~/Claude Projects/Documents/safari-pilot-agent-benchmark-lift-research.md`
- Parity matrix v3: `~/Claude Projects/Documents/safari-pilot-vs-playwright-parity-v3.html`
- Browser Use Harness: https://github.com/browser-use/browser-harness
- Anthropic Agent Skills: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
- Anthropic Writing Tools for Agents: https://www.anthropic.com/engineering/writing-tools-for-agents

## Branch

`feat/agent-benchmark-lift` from `main` (HEAD = `bdfb654`, post-v0.1.28).

## Decision protocol

Before EVERY substantive tool call:
1. Re-read this file mentally — am I violating a hard rule?
2. Confirm: am I in scope (≥parity feature)?
3. Confirm: am I in the right phase (TDD red, gate, green, refactor)?
4. If stuck or buggy → switch to systematic-debugging skill, do not improvise.
