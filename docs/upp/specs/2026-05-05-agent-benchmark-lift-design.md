# Agent Benchmark Lift — Design Spec

**Date:** 2026-05-05
**Branch:** `feat/agent-benchmark-lift`
**Origin:** Deep research at `~/Claude Projects/Documents/safari-pilot-agent-benchmark-lift-research.md`
**Codified instructions:** `SPRINT-INSTRUCTIONS.md` (project root)

## Problem

v0.1.28 shipped locator-system v2 (T77/T78/T79/T80) at parity with Playwright. But "feature shipped" ≠ "agent uses feature in benchmark." The agent loop, given a tool surface and a task, picks the wrong tool, mis-fills params, or falls back to brittle CSS — because the surface doesn't *teach* it the right strategy.

The gap is **agentic plumbing and discovery**, not capability. Three concrete signals:
- 83 tools loaded statically every turn → prompt-cache bloat + selection ambiguity.
- Tool descriptions describe what the tool DOES, rarely WHEN to use it.
- T77 chain ops, T78 query_all, T79 selectorPack are silently available — no example, no nudge.

## Goal

Bridge the gap between shipped features and agent utilization. Measured against an agent loop on WebBench-style tasks. Target: **≥20% reduction in (wall time × tokens) per iteration over 3 iterations**, ending at ≈0.51× baseline TT cost.

## Non-goals

- Build extension or daemon (out of scope per user directive).
- Solve for partial (◆) or gap (✗) parity items per v3 matrix. Only ≥parity surface.
- New product capabilities. This sprint is purely about how the existing surface is exposed and discovered.

## Approach (inspired by Browser Use's `browser-harness`)

Browser Use's harness auto-generates per-domain skills from execution traces, persists them as playbooks with robust selectors, and compounds reliability over time. Adapt that to Safari Pilot:

1. **Sharpen the static surface** (Clusters A/B/C) — descriptions, schemas, locator-v2 nudges. Mechanical, parallelizable, low-risk.
2. **Build the agentic measurement loop** (Cluster H) — the harness that actually runs WebBench-style tasks against safari-pilot via MCP, with Claude as the agent. This is the eval gate for every other change.
3. **Add discovery infrastructure** (Cluster D) — `safari_tool_search` + `defer_loading` + a hot-set. Closes the prompt-bloat side.
4. **Add high-leverage skill bundles** (Cluster E) — `login`, `paginate_and_scrape`, `robust_form_fill`. Anthropic Skills format (SKILL.md + YAML frontmatter).
5. **Wire `suggested_next_tools` in result metadata** (Cluster G) — Stagehand-`Observe`-equivalent for our surface.
6. **Stand up recipe miner** (Cluster I) — reads `test-results/traces/**/tool-calls.jsonl`, extracts successful sequences, auto-emits skill candidates. Direct port of Browser Use's playbook concept.

## Architecture

```
┌─ Static surface (Clusters A/B/C) ──────────────────────────────┐
│  src/tools/*.ts inputSchemas + descriptions (rewritten)        │
│  src/locator.ts chain field documented in tool inputSchemas    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─ Agent benchmark harness (Cluster H) ──────────────────────────┐
│  bench/run.sh <variant>                                        │
│  bench/tasks/*.task.json (5–10 WebBench-style tasks)           │
│  bench/agent.ts (Claude SDK loop talking to safari-pilot MCP)  │
│  bench/score.ts (success bool, tool calls, tokens, wall time)  │
│  bench/baselines/<variant>.json (TT scoreboard)                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─ Discovery infra (Cluster D) ──────────────────────────────────┐
│  src/tools/tool-search.ts (safari_tool_search meta-tool)       │
│  src/discovery/index.ts (in-memory tool index by tag/keyword)  │
│  src/discovery/hotset.ts (always-loaded set, configurable)     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─ Skills + recipes (Clusters E + I) ────────────────────────────┐
│  skills/*.SKILL.md (YAML frontmatter + procedure markdown)     │
│  src/tools/skills.ts (safari_run_skill meta-tool)              │
│  src/discovery/recipe-miner.ts (reads tool-calls.jsonl)        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─ Result-side hints (Cluster G) ────────────────────────────────┐
│  src/types.ts ToolResponse.metadata.suggested_next_tools[]     │
│  Wired in: navigation, strict-mode violations, approval blocks │
└─────────────────────────────────────────────────────────────────┘
```

## File structure (new)

```
bench/
├── agent.ts              # Claude SDK loop client (TS, Node)
├── run.sh                # Wraps `tsx bench/agent.ts` against MCP server
├── score.ts              # Aggregates a run's metrics into JSON
├── tasks/
│   ├── 01-search-result.task.json
│   ├── 02-form-fill.task.json
│   ├── 03-table-extract.task.json
│   ├── 04-multi-page.task.json
│   └── 05-login-and-search.task.json
└── baselines/
    └── v0.1.28-baseline.json     # Pre-sprint scoreboard

skills/
├── login.SKILL.md
├── paginate-and-scrape.SKILL.md
└── robust-form-fill.SKILL.md

src/discovery/
├── tool-index.ts         # in-memory index for tool search
├── hotset.ts             # configurable hot-set
└── recipe-miner.ts       # reads tool-calls.jsonl, emits skill candidates

src/tools/
├── tool-search.ts        # safari_tool_search meta-tool
└── skills.ts             # safari_run_skill meta-tool

docs/upp/plans/
└── 2026-05-05-agent-benchmark-lift.md  # implementation plan
```

## Constraints & invariants

- **No mocks in e2e.** The agent loop talks to real safari-pilot via stdio MCP, real Safari extension, real fixture pages. Per `feedback-e2e-means-e2e`.
- **TDD red-green-refactor with test-reviewer gate** on every code change. No exceptions for "small" fixes.
- **Atomic ship units.** Each cluster's tasks land independently with passing tests. Re-run the benchmark after every cluster to confirm no regression.
- **Trace capture mandatory** per project CLAUDE.md. Every benchmark run writes `test-results/traces/<timestamp>/tool-calls.jsonl`. The recipe miner reads this format.
- **Scope filter:** every tool description rewrite, every example, every skill targets ≥parity capabilities only. Skip partial/gap items.
- **No daemon/extension changes.** Pure TypeScript + skill markdown work.

## Iteration loop

```
Iteration N:
  1. Cluster cluster work (TDD: red → reviewer gate → green per task)
  2. bench/run.sh iter-N → bench/baselines/iter-N.json
  3. Compare TT vs iter-(N-1). Must be ≤0.80 × prior.
  4. If lift target missed → systematic-debugging on which intervention failed
  5. CHECKPOINT.md after every 2 tasks
  6. Compact between iterations (recommended cadence)
```

Three iterations minimum. Stops when TT no longer drops or budget exhausted.

## UX flows (the agent's perspective)

### Primary flow (WebBench-style task)
1. Agent receives task description.
2. Agent reads system prompt — short, instructs to use `safari_tool_search` if a capability isn't visible.
3. Hot-set tools always visible: nav, snapshot, query_all, click, get_text, type, evaluate, list_tabs.
4. Agent picks initial action; if needs a niche tool, calls `safari_tool_search({query, tags?})`.
5. Tool result includes `suggested_next_tools` when there's a clear follow-up (post-nav → snapshot; strict-violation → query_all).
6. Agent runs to completion or aborts.
7. Trace captured. Score computed.

### Skill-triggered flow
1. Agent recognizes "log into example.com" pattern.
2. Calls `safari_run_skill({skill: "login", url, username, password})`.
3. Server loads `skills/login.SKILL.md` procedure, executes the underlying tool sequence (the skill is server-side orchestration, not just a prompt).
4. Single tool call replaces 4–6 in the agent loop. Time + tokens drop.

### Recipe-mined skill (Cluster I)
1. After multiple successful runs of a domain task, recipe miner extracts the common sequence.
2. Auto-generates `skills/<domain>-<task>.SKILL.md` candidate.
3. Human review (or a confidence threshold) promotes it to permanent.

## Design Artifacts

No `DESIGN.md` — this is backend/infrastructure work, no frontend UI. Skill markdown files use the Anthropic Agent Skills format directly per https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.

## Acceptance criteria (sprint-level)

- [ ] Baseline benchmark runs and produces `bench/baselines/v0.1.28-baseline.json` with reproducible TT measurement
- [ ] All ≥parity tool descriptions rewritten to "what + WHEN" with trigger phrases, ≤400 chars
- [ ] InputSchema enum/pattern coverage ≥80% on closed-set string params
- [ ] `safari_tool_search` meta-tool ships with passing e2e through MCP
- [ ] At least 3 SKILL.md bundles ship + `safari_run_skill` works e2e
- [ ] `suggested_next_tools` field wired on ≥3 tools + agent prompt updated
- [ ] Recipe miner reads `tool-calls.jsonl` and emits ≥1 candidate skill
- [ ] Iteration 1 TT ≤0.80 × baseline
- [ ] Iteration 2 TT ≤0.64 × baseline
- [ ] Iteration 3 TT ≤0.51 × baseline
- [ ] All e2e (agent-loop benchmark + existing 42 e2e) pass on `main` after merge
- [ ] No mock-based "e2e" tests added
- [ ] CHECKPOINT.md updated after every 2 atomic tasks

## Browser Use Harness reference (carry-through)

The `browser-harness` repo (https://github.com/browser-use/browser-harness) ships a system that:
- Treats successful trajectories as durable assets, not throwaway logs.
- Persists per-domain knowledge as playbooks with robust selectors.
- Self-heals: when a selector breaks, the harness retries with alternates from the playbook.
- Compounds reliability across users via PR-based skill contribution.

Translation to Safari Pilot:
- `tool-calls.jsonl` is our trajectory log (already shipping).
- `skills/*.SKILL.md` is our playbook format.
- The recipe miner is our auto-extraction.
- Future: the agent harness checks for an existing skill before calling raw tools (skill-first dispatch).
