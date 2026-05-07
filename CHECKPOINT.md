# Checkpoint
*Written: 2026-05-08*

## Current Task
v0.1.30 sprint planned — WebVoyager canonical baseline + load-bearing discovery (small default tool surface + `safari_tool_search` as gateway to long tail). Plan written, engineering-lead reviewed, revised in place. Execution NOT started — last action was waiting for user go-ahead on `upp:executing-plans`.

## Progress

### Done in this session
- [x] ~31 controlled benchmark runs across 5 surface variants × 2 models on the 6/8-task fixture suite. Empirical finding: tool-list size is the dominant cost driver (-63% TT from 86→14), but a static "hotset 14" pick was wrong framing — overfit to this suite.
- [x] Bench harness extended: trace capture (stderr.log + server-trace.ndjson + daemon-trace.ndjson), extension preflight, `--surface full|iter1|hotset|midset|tinyset` flag, `--model` flag, two new held-out tasks (`bench/tasks/06-click-and-verify.task.json`, `bench/tasks/07-aggregate-count.task.json`)
- [x] `CLAUDE.md` — added "Benchmark Hierarchy (HARD RULES)" section (fixture for dev loop only, WebVoyager canonical for ship gates, no exclusions, sites change = signal not noise)
- [x] `docs/benchmarking.md` (NEW) — full WebVoyager protocol: dataset, GPT-4o judge, concurrency 8 default with empirical fallback to 4, `claude -p` driver via Max subscription, dev-sample (175 tasks N=1) vs ship-gate (full 643 N=3), co-measurement, locked decisions table
- [x] Memory `feedback-canonical-benchmark.md` (NEW + indexed in MEMORY.md)
- [x] `TRACES.md` iteration 71 entry covering this session's findings + protocol decisions
- [x] **Plan written** at `docs/upp/plans/2026-05-08-v0130-webvoyager-and-loadbearing-discovery.md`
- [x] **Engineering-lead review applied** — 18 critical/significant fixes integrated up-front (verbatim judge prompt, wall_ms cost metric, post-hoc screenshot, resume capability, explicit Gate C thresholds, opt-in trace hook, ~12 others)
- [x] **6 explicit gates marked** in the plan (PF-5a/b, PF-6, A, T4, T8, T12, B, C) — execution pauses there for evaluation

### Not done yet
- [ ] Pre-flight: PF-1..6 (production stack check, `claude -p` works headless, OpenAI key sourced, branch creation, dataset clone, concurrency smoke)
- [ ] Phase 1: WebVoyager harness (Tasks 1-8) — adapter, judge, sampler, scoreboard, runner with resume, bash driver
- [ ] Phase 2: v0.1.29 dev-sample baseline on real WebVoyager (Task 9)
- [ ] Phase 3: Architecture changes (Tasks 10-15) — surface registry, tools/list filter, e2e load-bearing test, companion skill, opt-in trace hook, config update
- [ ] Phase 4: v0.1.30 dev-sample baseline + Gate C decision (Task 16)
- [ ] Phase 5: Full N=3 ship-gate baselines + changelog + tag (Tasks 17-18)
- [ ] **Session work uncommitted on main** — needs commit or move to feat branch (see Context)
- [ ] **Notion ROADMAP** — pending (Notion MCP not loaded this session); user to add v0.1.30 work items + v2.0 long-horizon roadmap entry manually

## Key Decisions (not yet persisted)
All decisions already persisted:
- Benchmark hierarchy → `CLAUDE.md` + `docs/benchmarking.md` + memory
- WebVoyager protocol (dataset source, gpt-4o judge, concurrency 8, claude -p, dev-sample/ship-gate cadence, no exclusions, co-measurement) → `docs/benchmarking.md`
- v0.1.x = plugin perfection, v2.0 = agent product (own LLM loop, user API key, non-CC distribution) → `TRACES.md` iter 71 + plan
- 18 review fixes + 6 explicit gates → in the plan itself

## Next Steps

### Immediately on session resume
1. **Commit or move session work.** Current uncommitted changes on `main`:
   - Modified: `bench/agent.ts`, `bench/run.sh`, `CLAUDE.md`, `TRACES.md`
   - New: `bench/tasks/06-click-and-verify.task.json`, `bench/tasks/07-aggregate-count.task.json`, `docs/benchmarking.md`, `docs/upp/plans/2026-05-08-v0130-webvoyager-and-loadbearing-discovery.md`
   - New (memory dir): `~/.claude/projects/-Users-Aakash-Claude-Projects-Skills-Factory-safari-pilot/memory/feedback-canonical-benchmark.md`
   - Choice: (a) commit to main first then PF-4 creates feat branch from main with this work in history; or (b) create feat branch now with all session work, leave main clean. Recommend (a) — the session work is general-purpose harness improvements and docs, valuable on main regardless of v0.1.30 outcome.

2. **Invoke `upp:executing-plans` skill in subagent mode** with the plan path:
   `docs/upp/plans/2026-05-08-v0130-webvoyager-and-loadbearing-discovery.md`

3. **The skill will dispatch tasks one by one with two-stage review** (spec + code quality). For operational tasks (T9, T16, T17), controller runs inline since they're "schedule + wait + copy."

### Critical pause points (gates) — controller decides at each
- **PF-5a/b:** dataset path + verbatim judge prompt extraction must succeed
- **PF-6:** concurrency 8 vs 4 decided empirically, written to `bench/webvoyager/CONCURRENCY`
- **Gate A:** all Phase 1 unit + e2e tests pass + driver smoke produces a scoreboard
- **Gate T4:** judge prompt is byte-for-byte from upstream `auto_eval.py`
- **Gate T12:** long-tail tools callable by name even when hidden from `tools/list` (architectural prerequisite — if server rejects, may need to fix dispatch path)
- **Gate B:** `claude -p` calls `safari_tool_search` and gets long-tail candidates
- **Gate C (HARD):** v0.1.30 vs v0.1.29 dev-sample — proceed only if Δsuccess ≥ -2pp, Δwall ≤ +5%, worst per-site ≥ -10pp. Three options if fail (A=fix, B=narrow scope, C=abort architecture)

## Context

### Repo state
- Branch: `main` (feat branch NOT yet created — that's PF-4)
- Working tree: dirty with the session work listed above
- Last TRACES iter: 71
- Last commit on main: needs `git log --oneline -1` to verify (was `1ad7080` at start of session, may have advanced if anything committed mid-session — review session was non-committing)

### Plan structure (5 phases, 18 tasks, 6 gates)
- **Pre-flight:** PF-1..6 (lock dataset paths, verbatim judge prompt, concurrency)
- **Phase 1 (T1-T8):** WebVoyager harness — types, sampler, judge, adapter (post-hoc screenshot via `mcp-direct.ts`), scoreboard (FAILURE on ties, per-site median over all runs), runner with `--resume`, bash driver, sample CLI
- **Phase 2 (T9):** v0.1.29 dev-sample baseline (175 tasks N=1, ~$15-30 OpenAI)
- **Phase 3 (T10-T15):** `src/surface.ts` registry, `tools/list` filter, e2e load-bearing test, companion skill (anchored trigger), opt-in trace hook (Node-based), config update
- **Phase 4 (T16):** v0.1.30 dev-sample baseline + comparison report + Gate C decision
- **Phase 5 (T17-T18):** Full N=3 ship-gate (~$300-450 OpenAI), changelog with rollback plan, version bump, tag

### Key locked decisions for plan execution
- Dataset: github.com/MinorJerry/WebVoyager verbatim
- Judge model: `gpt-4o` (fixed, no fallback)
- Agent driver: `claude --dangerously-skip-permissions -p` (uses Max subscription, no API spend)
- Concurrency: 8 default, empirically validated at PF-6
- Cost metric: `wall_ms` only (token counts not available via `claude -p`)
- N: 1 for dev sample, 3 for ship gate
- Hotset = 14 tools (snapshot, navigate, click, fill, get_text, get_html, query_all, evaluate, paginate_scrape, new_tab, list_tabs, close_tab, health_check, wait_for, tool_search) + safari_tool_search makes 15
- Surface filter at server-side (not client-side); env var `SAFARI_PILOT_SURFACE=hotset|midset|full`
- Trace hook opt-in via `SAFARI_PILOT_TRACE_CC_SESSIONS=1` (default off, privacy-respecting)

### Things NOT in scope for v0.1.30 (deferred to v0.1.31+ or v2.0)
- Per-host knowledge base / persistent recipes per origin
- Skill auto-promotion from recipe miner
- Full agent product (own LLM loop, takes user API key) — that's v2.0
- Tiered skill catalog with semantic search ranking
- Hot-set optimization for stronger models (sonnet may want tinyset 10) — v0.1.31

### Cost reality for v0.1.x lifecycle
- Per dev-sample baseline: ~$15-30 OpenAI judge + 6-12hr wall on this Mac (overnight)
- Per ship-gate baseline (N=3 full 643): ~$150 OpenAI judge + 24-48hr wall
- Across 20-30 v0.1.x baselines: ~$1500-3000 total OpenAI spend
- Anthropic spend on agent: $0 (Max subscription)

### Empirical findings worth re-reading before execution (already in TRACES iter 71)
- The 4/6 vs 6/6 success "lift" claim was largely budget-floor artifact — fat-budget run got 6/6 at 15.12B TT proving 86 tools is expensive not broken
- Tinyset (10 tools) deterministic-fails 05-strict-mode for haiku because removing `safari_wait_for` kills the wait primitive; sonnet recovers via JS-eval — minimum viable surface is model-dependent
- Sonnet has consistent +63-68% TT markup vs haiku across all surface sizes
- Per-tool overhead is ~80-250M TT on this suite, higher when adding 14→30 (relevant tools dilute attention) than 30→86 (long tail mostly ignored)
- Static surface pruning was wrong direction — discovery + skills is the right architecture, partially shipped in v0.1.29

### Known caveats / risks for execution
- **`claude -p` plugin loading.** PF-2 verifies safari-pilot loads via `claude -p` and can call a tool. If this fails, the entire plan can't execute — abort and debug `~/.claude/plugins/` first.
- **Daemon serialization at concurrency 8.** Unknown until PF-6 measures it. Fallback to 4 if daemon trace shows long gaps between commands.
- **Long-tail dispatch when hidden from `tools/list`.** Gate T12 — if MCP server rejects calls to filtered-out tools, need to update `tools/call` handler. Architectural prerequisite for the whole discovery model.
- **Companion skill auto-load false positives.** Trigger description anchored to "safari_* tool calls" — verify it doesn't fire on unrelated form-fill conversations during T13 step 4.
- **Site changes during co-measurement window.** Run v0.1.29 + v0.1.30 baselines within 72hr of each other on same machine state.

### What this session already wrote
- `bench/agent.ts` — has `--surface full|iter1|hotset|midset|tinyset` and `--model` flags, trace capture, extension preflight (this is the v0.1.29 fixture-suite harness; the new WebVoyager harness in `bench/webvoyager/` is separate)
- `bench/run.sh` — passes through `--surface` and `--model`
- `bench/tasks/06-click-and-verify.task.json` — strict locator + post-nav extraction held-out task
- `bench/tasks/07-aggregate-count.task.json` — multi-page aggregation held-out task
