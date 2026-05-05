# Baselines

`v0.1.28-baseline.json` — anchor for the agent benchmark lift sprint.

| Field | Value |
|---|---|
| Variant | v0.1.28-baseline |
| Date | 2026-05-05 |
| Branch | feat/agent-benchmark-lift @ 5f17d78 |
| Tools registered | 83 |
| Model | claude-haiku-4-5-20251001 |
| Success rate | 4/6 (67%) |
| Total tool calls | 31 |
| Total tokens | 729,620 |
| Total wall ms | 77,309 |
| **Total TT** | **12,396,305,183** |

TT = sum over tasks of `wall_ms × (input_tokens + output_tokens)`. Single-number cost metric.

## Iteration targets

| Iteration | TT target (× baseline) | TT cap |
|---|---|---|
| Iter 1 | ≤ 0.80 | ≤ 9,917,044,146 |
| Iter 2 | ≤ 0.64 | ≤ 7,933,635,317 |
| Iter 3 | ≤ 0.51 | ≤ 6,322,115,643 |

## Per-task (baseline)

| Task | Status | Tool calls | TT |
|---|---|---|---|
| 00-smoke | FAIL (budget) | 3 | 386,692,163 |
| 01-extract-h1 | OK | 2 | 335,926,022 |
| 02-multi-element-list | OK | 3 | 1,062,418,328 |
| 03-form-fill | OK | 6 | 1,666,627,410 |
| 04-paginate-extract | OK | 11 | 7,389,406,080 |
| 05-strict-mode | FAIL (budget) | 6 | 1,555,235,180 |

**Notes on baseline failures:**
- `00-smoke`: budget exhausted on a trivial task — agent loaded all 83 tools' definitions on every turn (~20K input tokens × 3 turns hit the 60K budget). This is the prompt-bloat problem Cluster A (description rewrite) and Cluster D (tool search + defer-loading) directly address.
- `05-strict-mode`: budget exhausted while iterating on the multi-Sign-In-button page. Without locator-v2 strategy guidance (Cluster C), the agent didn't reach for `safari_query_all` + chain ops to disambiguate.

These two failures bound the lift opportunity for the sprint.
