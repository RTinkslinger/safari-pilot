# Milestone 23: Agent Benchmark Lift — Tool Search, Skills, Recipe Miner
**Iterations:** 67-69 | **Dates:** 2026-05-05

## Summary
Shipped three Cluster components of the agent-benchmark-lift sprint: Cluster D-light (safari_tool_search meta-tool + in-memory ToolIndex), Cluster E (SKILL.md workflow bundles + safari_run_skill/safari_list_skills + SkillRegistry/SkillRunner), and Cluster I (recipe miner — Browser Use browser-harness pattern, reads tool-calls.jsonl traces, emits candidate SKILL.md files). All three are developer-side / agent-side tools that compound: ToolIndex improves as tool count grows, skills accumulate, recipe miner value grows as bench runs accumulate.

## Key Decisions
- ToolIndex registered in BOTH `listToolDefinitions()` and `initialize()` in server.ts — needed for both static introspection and runtime dispatch
- SkillTools not in ToolIndex (push order issue) — system prompt names `safari_list_skills` directly, covering this gap
- Sub-step dispatch in safari_run_skill bypasses security pipeline — outer call is gated; inner steps not individually audited (accepted trade-off per manifest)
- Recipe miner scoped to developer-side CLI (`bench/mine-recipes.ts`) — no MCP tool registration in this sprint
- `stat().catch(() => null)` pattern used in recipe miner over `let s; try{}` to satisfy tsc strict null checks

## Iteration Details

### Iteration 67 - 2026-05-05 — Cluster D-light: safari_tool_search meta-tool + ToolIndex (T8)
**What:** Shipped the discovery half of the "tool search + defer_loading" pattern. In-memory ToolIndex (keyword overlap scoring with name+tag boost) + ToolSearchTools module registered in both listToolDefinitions() and initialize(). TDD: 5 unit tests RED → ToolIndex implemented → GREEN; 2 e2e tests pass against real MCP server.
**Changes:** `src/discovery/tool-index.ts` (new: ToolIndex class — inferTags, tokenize, score, search, tagsFor), `src/tools/tool-search.ts` (new: ToolSearchTools with safari_tool_search handler), `src/server.ts` (imports + ToolIndex build + ToolSearchTools push in both listToolDefinitions and initialize), `test/unit/discovery/tool-index.test.ts` (new: 5 unit tests), `test/e2e/tool-search.test.ts` (new: 2 e2e tests via real MCP)
**Context:** ToolIndex registered in BOTH server.ts sites (listToolDefinitions for static introspection, initialize for runtime). safari_emergency_stop and safari_tool_search itself are not indexed (self-discovery not needed; emergency stop registered post-modules). 594/594 unit tests pass, lint clean. Commit 6baa8b8 on feat/agent-benchmark-lift.
---

### Iteration 68 - 2026-05-05 — Cluster E: SKILL.md bundles + safari_run_skill / safari_list_skills (T11)
**What:** Shipped 3 SKILL.md workflow bundles (login, paginate-and-scrape, robust-form-fill), SkillRegistry (async SKILL.md loader with YAML frontmatter + JSON steps block parser), SkillRunner (interpolation + _loop support), and SkillTools (safari_run_skill + safari_list_skills). TDD: 4 unit tests RED (module not found) → registry.ts implemented → GREEN. E2e test confirms safari_list_skills returns all 3 bundled skills via real MCP.
**Changes:** `skills/login.SKILL.md` (new), `skills/paginate-and-scrape.SKILL.md` (new), `skills/robust-form-fill.SKILL.md` (new), `src/skills/registry.ts` (new: SkillRegistry — fromDir, parse, list, get), `src/skills/runner.ts` (new: runSkill — interp, _loop, saveAs), `src/tools/skills.ts` (new: SkillTools — safari_run_skill + safari_list_skills), `src/server.ts` (imports + SkillTools push in listToolDefinitions with empty registry + async skillRegistry load + skillDispatch in initialize), `test/unit/skills/registry.test.ts` (new: 4 unit tests), `test/e2e/skill-runner.test.ts` (new: 1 e2e test)
**Context:** Sub-step dispatch bypasses security pipeline (tab-ownership, rate-limit, circuit-breaker, audit) — outer safari_run_skill call is gated; inner steps are not individually audited. Accepted trade-off per manifest design intent. SkillTools not in ToolIndex (pushed after ToolIndex build) — system prompt names safari_list_skills directly, covering this gap. 86 unit test files, 598 tests pass. Lint clean. Commit 61054e6 on feat/agent-benchmark-lift.
---

### Iteration 69 - 2026-05-05 — Cluster I: recipe miner (T14)
**What:** Shipped the recipe miner — Browser Use browser-harness pattern port. Reads `tool-calls.jsonl` + `score.json` from each run subdir, extracts recurring successful tool sequences grouped by host, emits candidate `*.SKILL.md` files. TDD: 4 unit tests RED (module not found) → `src/discovery/recipe-miner.ts` implemented → GREEN (4/4). CLI driver `bench/mine-recipes.ts` scans `bench-runs/` by default, aggregates across timestamp dirs, writes to `skills/candidates/`.
**Changes:** `src/discovery/recipe-miner.ts` (new: mineRecipes, collectTraces, signature, inferHost), `bench/mine-recipes.ts` (new: CLI aggregator driver), `test/unit/discovery/recipe-miner.test.ts` (new: 4 unit tests — happy path, skip-failed-runs, minLength filter, missing-score graceful)
**Context:** Uses `stat().catch(() => null)` pattern (not `let s; try{}`) for tsc strict null safety. No MCP tool registration — developer-side CLI only. 88 unit test files, 605 tests pass. Build + lint + lint:bench all clean. Commit on feat/agent-benchmark-lift.
---
