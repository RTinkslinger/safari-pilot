# WebVoyager Adapter

Canonical benchmark for Safari Pilot v0.1.x ship gates.

- **Source:** github.com/MinorJerry/WebVoyager (commit pinned in `DATASET_COMMIT`)
- **Dataset path:** see `TASKS_PATH` (resolved at PF-5)
- **Tasks:** 642 across 15 sites (upstream removed one of the original 643)
- **Eval:** gpt-4o judge with WebVoyager-verbatim prompt extracted to `judge-upstream.py`
  - Verdict tokens emitted by judge: `SUCCESS` / `NOT SUCCESS` (verbatim per upstream `auto_eval.py`)
- **Driver:** `claude -p` per task (Max subscription)
- **Concurrency:** see `CONCURRENCY` (decided at PF-6)
- **Cadence:** dev sample (175 tasks, fixed seed) weekly; full N=3 at ship gates
- **Cost metric:** `wall_ms` (token telemetry not available via claude -p)

Full protocol: `docs/benchmarking.md`.

Run dev sample: `bash bench/webvoyager/run.sh --variant <tag> --sample dev`
Run full ship gate: `bash bench/webvoyager/run.sh --variant <tag> --sample full --runs 3`
