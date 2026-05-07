# Benchmarking Protocol

> Canonical reference for Safari Pilot benchmarking. This document is load-bearing for v0.1.x ship gates. Don't deviate without updating it first.

## Two benchmarks, two purposes

Safari Pilot maintains two benchmarks. They are NEVER interchangeable.

### Fixture suite — `bench/tasks/*.task.json`

- **Purpose:** development feedback loop. Cheap, fast, deterministic.
- **What it measures:** intervention deltas during sprint work — does change X make tool selection cheaper or faster on a controlled set of synthetic tasks?
- **Tasks:** 8 in-house tasks against a local Node fixture server (`test/helpers/fixture-server.ts`).
- **Eval:** programmatic (`successOracle` field per task — text contains, tool called, no strict violation, etc).
- **Cost:** negligible (cents per run).
- **Wall time:** ~5-15 min per run.
- **Run with:** `bash bench/run.sh --variant <tag> --surface <full|hotset|midset|tinyset|iter1>`.
- **Where it does NOT belong:** anywhere in shipping baselines, release notes, or competitor comparisons. The 8 tasks are a yardstick, not a benchmark.

### WebVoyager — `bench/webvoyager/`

- **Purpose:** canonical shipping baseline. Real-world product validation.
- **What it measures:** Safari Pilot's plugin performance on the same 643-task benchmark Browser Use / Stagehand / Anthropic computer-use publish against.
- **Source:** github.com/MinorJerry/WebVoyager (Yang et al. 2024, arxiv.org/abs/2401.13919). Used verbatim — no task subsetting, no eval modifications.
- **Tasks:** 643 across 15 real live sites (Allrecipes, Amazon, Apple, ArXiv, BBC News, Booking, Cambridge Dictionary, Coursera, ESPN, GitHub, Google Flights, Google Map, Google Search, Huggingface, Wolfram Alpha).
- **Eval:** `gpt-4o` as judge (full parity with current ecosystem standard). Receives screenshot + agent's final text answer, returns pass/fail/partial.
- **Cost per full ship-gate run (N=3):** ~$150 OpenAI API for judge. Agent execution runs through Claude Max subscription (no $ cost).
- **Wall time per N=3 full run:** ~9-24 hr depending on Anthropic rate-limit windows.
- **Run cadence:** dev sample weekly during heavy v0.1.x dev; full N=3 only at ship-gate boundaries.
- **Run with:** `bash bench/webvoyager/run.sh --variant <tag> [--sample dev|full]` (adapter to be built, see below).

## Protocol decisions (locked for v0.1.x)

| Decision | Value | Why |
|---|---|---|
| Dataset | MinorJerry/WebVoyager verbatim | Apples-to-apples with all published competitor numbers |
| Eval judge | `gpt-4o` | Current ecosystem standard; parity with Browser Use's recent benchmarks |
| Concurrency | 8 (fallback to 4 on contention) | Balances wall time against Safari focus contention + daemon serialization risk |
| Agent driver | `claude --dangerously-skip-permissions -p "..."` | Uses Max subscription tokens (no API spend); routes through real CC + plugin harness |
| Dev sample | 175 tasks, stratified across all 15 sites, fixed random seed, N=1 | Cheap dev cadence; same sample each run for comparability |
| Ship gate | Full 643 tasks, N=3, median per task | Statistical floor for cross-version claims |
| Site exclusion | NONE | Real world is the product. Site change = recipe to write, not a benchmark to fix |
| Re-baseline cadence | Co-measurement window | Always re-run prior version baseline alongside new version, within 72hr |
| Variance reporting | Per-site delta surfaced alongside aggregate | Site changes are signal, not noise — we surface them, not hide them |
| Site-state hashes | Captured per run | Detects site UI changes; informs whether comparison is fair |

## Empirical fallback rules

The defaults above are starting points. Adjust empirically based on first ship-gate run:

- **If concurrency 8 causes >10% task timeouts OR daemon trace shows >5sec serialization gaps** → drop to concurrency 4 for subsequent runs.
- **If Max subscription rate limits trigger mid-run** → window runs in 2-hour blocks with cooldown gaps; or stagger task starts with jitter.
- **If GPT-4o judge variance >15% on borderline tasks** → flag for human review, do not eval-cycle endlessly.

## Co-measurement protocol

When tagging a new v0.1.x version:

1. **Within the same week as the new-version run, re-baseline the prior shipped version** on the same machine, same daemon, same extension. Both versions get N=3 full WebVoyager.
2. **Both runs land in `bench/baselines/v0.1.x/<YYYY-MM-DD>/`** with explicit version + commit SHA + site-state hashes.
3. **Comparison reports use ONLY the same-window pair.** Never compare a v0.1.30 run from May to a v0.1.29 run from March — sites have changed.
4. **If a site's page-state hash changed between the two runs**, flag that site's delta with `(site changed)` note in the comparison.

## Outputs and locking

Each run writes to `bench-runs/<timestamp>/`:
- `tool-calls.jsonl` per task (existing format from fixture harness)
- `score.json` per task (`{ task_id, success, judge_verdict, judge_reasoning, agent_final_text, site_state_hash, ... }`)
- `scoreboard.json` aggregate at run root
- `stderr.log` per task
- `server-trace.ndjson`, `daemon-trace.ndjson` per task

**Locked baselines** (immutable, used for cross-version comparison) move from `bench-runs/` into `bench/baselines/v0.1.x/<YYYY-MM-DD>/v0.1.<N>-webvoyager.json` after a successful ship-gate run.

## Cost reality (v0.1.x lifecycle)

Estimating ~20-30 baseline runs across all of v0.1.x:

| Item | Per run | × Lifecycle |
|---|---|---|
| Agent execution (Max subscription) | $0 | $0 |
| GPT-4o judge | $50 (N=1 dev sample) → $150 (N=3 full) | ~$1500-3000 |
| Wall time | 6-24 hr | scheduled overnight on dev machine |

Acceptable for a v0.1.x productization budget. Cost dominantly OpenAI judge calls.

## What's explicitly NOT done

- **Custom evaluator.** Use WebVoyager's published judge prompt verbatim. Custom evaluators are how baselines drift from competitor parity.
- **Task subsetting "for stability."** Real-world flakiness is the product. Capture it, don't hide it.
- **Stable-site cherry picking.** All 15 sites count. If Booking is hard, that's where recipes need to ship.
- **Fixture-suite numbers in release notes.** The fixture exists for development feedback. WebVoyager numbers ship.

## v2.0+ scope (out of v0.1.x)

When Safari Pilot evolves into a full agent product (own LLM loop, user-supplied API key, non-CC distribution), the same WebVoyager protocol applies — but with a different agent driver (its own loop instead of `claude -p`). Cross-version continuity preserved.

## Sources

- WebVoyager paper: https://arxiv.org/abs/2401.13919
- WebVoyager dataset: https://github.com/MinorJerry/WebVoyager
- Browser Use benchmarking writeup (reference for harness structure): https://browser-use.com (recent posts)
- This document: load-bearing; update before deviating
