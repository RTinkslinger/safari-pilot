#!/usr/bin/env python3
"""
v0.1.34 Bench Analysis — per-task + aggregate breakdown across speed, cost, turns, verdict.

Inputs:
  /tmp/wv-inline-runs-baseline-v0.1.33/*-r1.score.json  (and matching stream.jsonl)
  /tmp/wv-inline-runs-v0.1.34/*-r1.score.json           (first bench run)
  /tmp/wv-inline-runs-v0.1.34-retry/*-r1.score.json     (retry run)
  /tmp/wv-inline-runs/*-r1.score.json                   (overlay = baseline for non-retried, first-bench v0.1.34 for retried, judge verdicts intact)

Outputs:
  bench-runs/webvoyager-v0.1.34-bench-20260514/analysis.md  — full markdown report

Run:
  python3 bench/webvoyager/analyze-v0134.py
"""

import json
import glob
import os
import statistics
from collections import defaultdict, Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = REPO_ROOT / "bench-runs" / "webvoyager-v0.1.34-bench-20260514" / "analysis.md"

BASELINE_DIR = "/tmp/wv-inline-runs-baseline-v0.1.33"
V0134_FIRST_DIR = "/tmp/wv-inline-runs-v0.1.34"
V0134_RETRY_DIR = "/tmp/wv-inline-runs-v0.1.34-retry"
JUDGED_DIR = "/tmp/wv-inline-runs"  # overlaid + judged

CANONICAL_TASKS = "/tmp/wv-175-tasks.jsonl"


def load_canonical_task_ids():
    ids = set()
    sites = {}
    with open(CANONICAL_TASKS) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            t = json.loads(line)
            ids.add(t["id"])
            sites[t["id"]] = t["web_name"]
    return ids, sites


def load_score(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def load_all_scores(directory, canonical_ids):
    scores = {}
    for path in glob.glob(f"{directory}/*-r1.score.json"):
        d = load_score(path)
        if d and d.get("task_id") in canonical_ids:
            scores[d["task_id"]] = d
    return scores


def count_tool_calls_from_stream(stream_path):
    """Returns (total_tool_calls, per_tool_counts, total_tool_ms)."""
    if not os.path.exists(stream_path):
        return 0, {}, 0
    per_tool = Counter()
    total_calls = 0
    total_ms = 0
    try:
        with open(stream_path) as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                # Tool calls are nested in assistant messages with content[].type=='tool_use'
                if ev.get("type") == "assistant":
                    msg = ev.get("message", {})
                    for item in msg.get("content", []) or []:
                        if item.get("type") == "tool_use":
                            name = item.get("name", "unknown")
                            # Strip mcp__safari__ prefix for readability
                            if name.startswith("mcp__safari__"):
                                name = name[len("mcp__safari__"):]
                            per_tool[name] += 1
                            total_calls += 1
                # Tool latency comes from the user-role 'tool_result' block, but
                # that's not standardized across the stream format. The pretty.log
                # shows __latencyMs in the result content; we'll skip per-call ms
                # extraction for now and rely on per-tool counts only.
    except Exception:
        pass
    return total_calls, dict(per_tool), total_ms


def fmt_money(usd):
    if usd is None:
        return "-"
    return f"${usd:.3f}"


def fmt_secs(ms):
    if ms is None:
        return "-"
    return f"{ms/1000:.0f}s"


def fmt_pct(num, denom):
    if not denom:
        return "0%"
    return f"{100*num/denom:.0f}%"


def main():
    canonical_ids, sites_by_id = load_canonical_task_ids()
    n_canonical = len(canonical_ids)

    baseline = load_all_scores(BASELINE_DIR, canonical_ids)
    first = load_all_scores(V0134_FIRST_DIR, canonical_ids)
    retry = load_all_scores(V0134_RETRY_DIR, canonical_ids)
    judged = load_all_scores(JUDGED_DIR, canonical_ids)

    # Build per-task rows. Order: baseline-success-first-bench-failure, then
    # baseline-failure (rerun targets), then everything else.
    rows = []
    for task_id in sorted(canonical_ids):
        site = sites_by_id.get(task_id, "?")
        b = baseline.get(task_id) or {}
        f = first.get(task_id) or {}
        r = retry.get(task_id) or {}
        j = judged.get(task_id) or {}

        # Verdict source-of-truth: judged overlay (which has the latest verdict
        # after the v0.1.34 first bench was judged). If retry exists and has a
        # judged verdict, prefer that; otherwise use judged-overlay verdict.
        v0134_verdict = j.get("verdict")
        if r and r.get("verdict") and r.get("verdict") not in ("PENDING_JUDGE", "UNKNOWN"):
            v0134_verdict = r.get("verdict")

        rows.append({
            "task_id": task_id,
            "site": site,
            "baseline_verdict": b.get("verdict"),
            "baseline_turns": b.get("turns"),
            "baseline_cost": b.get("cost_usd"),
            "baseline_wall_ms": b.get("wall_ms"),
            "baseline_agent_ms": b.get("agent_duration_ms"),
            "first_verdict": j.get("verdict") if j.get("variant", "").startswith("v0.1.34") else None,
            "first_turns": f.get("turns"),
            "first_cost": f.get("cost_usd"),
            "first_wall_ms": f.get("wall_ms"),
            "first_agent_ms": f.get("agent_duration_ms"),
            "retry_verdict": r.get("verdict"),
            "retry_turns": r.get("turns"),
            "retry_cost": r.get("cost_usd"),
            "retry_wall_ms": r.get("wall_ms"),
            "retry_agent_ms": r.get("agent_duration_ms"),
            "v0134_verdict": v0134_verdict,
        })

    lines = []
    lines.append("# v0.1.34 Bench — Thorough Per-Task + Aggregate Analysis")
    lines.append("")
    lines.append(f"Written {Path('/tmp').stat().st_mtime}.")
    lines.append("")
    lines.append("## Inputs")
    lines.append("")
    lines.append(f"- Canonical tasks: **{n_canonical}** from `/tmp/wv-175-tasks.jsonl`")
    lines.append(f"- v0.1.33 baseline scores: **{len(baseline)}** in `{BASELINE_DIR}`")
    lines.append(f"- v0.1.34 first-bench scores: **{len(first)}** in `{V0134_FIRST_DIR}`")
    lines.append(f"- v0.1.34 retry scores: **{len(retry)}** in `{V0134_RETRY_DIR}`")
    lines.append(f"- Judge-overlaid scores: **{len(judged)}** in `{JUDGED_DIR}`")
    lines.append("")

    # === AGGREGATES ===
    lines.append("## Aggregate Comparisons (Baseline vs v0.1.34)")
    lines.append("")

    def agg_for_set(scores, label):
        if not scores:
            return f"- {label}: no data"
        verdicts = Counter(s.get("verdict") for s in scores.values())
        n = len(scores)
        success = verdicts.get("SUCCESS", 0)
        failure = verdicts.get("FAILURE", 0)
        pending = verdicts.get("PENDING_JUDGE", 0)
        unknown = verdicts.get("UNKNOWN", 0)
        wall_ms = [s.get("wall_ms", 0) for s in scores.values() if s.get("wall_ms")]
        agent_ms = [s.get("agent_duration_ms", 0) for s in scores.values() if s.get("agent_duration_ms")]
        turns = [s.get("turns", 0) for s in scores.values() if s.get("turns")]
        costs = [s.get("cost_usd", 0) for s in scores.values() if s.get("cost_usd") is not None]
        return (
            f"- **{label}** (n={n}): "
            f"SUCCESS={success}/{n} ({fmt_pct(success, n)}) · FAILURE={failure} · "
            f"PENDING={pending} · UNKNOWN={unknown}\n"
            f"  - wall: median={statistics.median(wall_ms)/1000:.0f}s · "
            f"p95={int(statistics.quantiles(wall_ms, n=20)[18])/1000:.0f}s · "
            f"max={max(wall_ms)/1000:.0f}s\n"
            f"  - agent_duration: median={statistics.median(agent_ms)/1000:.0f}s · "
            f"p95={int(statistics.quantiles(agent_ms, n=20)[18])/1000:.0f}s\n"
            f"  - turns: median={int(statistics.median(turns))} · "
            f"p95={int(statistics.quantiles(turns, n=20)[18])} · max={max(turns)}\n"
            f"  - cost_usd: median={fmt_money(statistics.median(costs))} · "
            f"p95={fmt_money(statistics.quantiles(costs, n=20)[18])} · "
            f"max={fmt_money(max(costs))} · TOTAL={fmt_money(sum(costs))}"
        )

    lines.append(agg_for_set(baseline, "v0.1.33 baseline (all 175)"))
    lines.append(agg_for_set({k: v for k, v in judged.items() if v.get("variant", "").startswith("v0.1.34")}, "v0.1.34 first bench (104 retried tasks, judge-overlaid)"))
    lines.append(agg_for_set({k: v for k, v in retry.items() if v.get("verdict") not in (None, "UNKNOWN")}, "v0.1.34 retry round 2 (valid only)"))
    lines.append("")

    # === PER-SITE ===
    lines.append("## Per-Site Breakdown")
    lines.append("")
    by_site_baseline = defaultdict(list)
    by_site_v0134 = defaultdict(list)
    for s in baseline.values():
        by_site_baseline[s.get("variant"), s.get("verdict") or "?"].append(s)
    # For v0.1.34, build from judged overlay + retry override
    for tid in canonical_ids:
        site = sites_by_id.get(tid)
        if not site:
            continue
        # Pick latest valid verdict
        verdict = None
        ref = None
        if tid in retry and retry[tid].get("verdict") not in (None, "UNKNOWN", "PENDING_JUDGE"):
            verdict = retry[tid]["verdict"]
            ref = retry[tid]
        elif tid in judged and judged[tid].get("variant", "").startswith("v0.1.34"):
            verdict = judged[tid].get("verdict")
            ref = judged[tid]
        elif tid in judged:
            verdict = judged[tid].get("verdict")
            ref = judged[tid]
        if ref:
            by_site_v0134[site].append((verdict, ref))
    by_site_baseline_collapsed = defaultdict(list)
    for s in baseline.values():
        by_site_baseline_collapsed[sites_by_id.get(s["task_id"], "?")].append(s)

    lines.append("| Site | Baseline | v0.1.34 (latest) | Δ | Median wall (B→34) | Median cost (B→34) | Median turns (B→34) |")
    lines.append("|---|---|---|---|---|---|---|")
    for site in sorted(by_site_baseline_collapsed.keys()):
        b_scores = by_site_baseline_collapsed[site]
        v_scores = by_site_v0134.get(site, [])
        b_succ = sum(1 for s in b_scores if s.get("verdict") == "SUCCESS")
        v_succ = sum(1 for v, _ in v_scores if v == "SUCCESS")
        b_n = len(b_scores)
        v_n = len(v_scores)
        delta = v_succ - b_succ
        b_walls = [s.get("wall_ms", 0) for s in b_scores if s.get("wall_ms")]
        v_walls = [r.get("wall_ms", 0) for _, r in v_scores if r.get("wall_ms")]
        b_costs = [s.get("cost_usd", 0) for s in b_scores if s.get("cost_usd") is not None]
        v_costs = [r.get("cost_usd", 0) for _, r in v_scores if r.get("cost_usd") is not None]
        b_turns = [s.get("turns", 0) for s in b_scores if s.get("turns")]
        v_turns = [r.get("turns", 0) for _, r in v_scores if r.get("turns")]
        wall_str = f"{statistics.median(b_walls)/1000:.0f}s → {statistics.median(v_walls)/1000:.0f}s" if b_walls and v_walls else "-"
        cost_str = f"{fmt_money(statistics.median(b_costs))} → {fmt_money(statistics.median(v_costs))}" if b_costs and v_costs else "-"
        turn_str = f"{int(statistics.median(b_turns))} → {int(statistics.median(v_turns))}" if b_turns and v_turns else "-"
        lines.append(f"| {site} | {b_succ}/{b_n} | {v_succ}/{v_n} | {'+' if delta >= 0 else ''}{delta} | {wall_str} | {cost_str} | {turn_str} |")
    lines.append("")

    # === OUTLIERS ===
    lines.append("## Speed / Cost / Turn Outliers (from baseline + v0.1.34 combined)")
    lines.append("")
    all_scores = list(baseline.values()) + list(judged.values()) + list(retry.values())
    valid = [s for s in all_scores if s.get("verdict") not in (None, "PENDING_JUDGE", "UNKNOWN") and s.get("cost_usd")]

    by_cost = sorted(valid, key=lambda s: -s.get("cost_usd", 0))[:15]
    lines.append("### Top 15 most expensive task-runs")
    lines.append("")
    lines.append("| Task | Variant | Verdict | Cost | Wall | Agent | Turns |")
    lines.append("|---|---|---|---|---|---|---|")
    for s in by_cost:
        lines.append(f"| {s['task_id']} | {s.get('variant','?')} | {s.get('verdict')} | {fmt_money(s.get('cost_usd'))} | {fmt_secs(s.get('wall_ms'))} | {fmt_secs(s.get('agent_duration_ms'))} | {s.get('turns','-')} |")
    lines.append("")

    by_turns = sorted([s for s in valid if s.get("turns")], key=lambda s: -s.get("turns", 0))[:15]
    lines.append("### Top 15 highest-turn task-runs (proxy for retries / agent thrash)")
    lines.append("")
    lines.append("| Task | Variant | Verdict | Turns | Wall | Cost |")
    lines.append("|---|---|---|---|---|---|")
    for s in by_turns:
        lines.append(f"| {s['task_id']} | {s.get('variant','?')} | {s.get('verdict')} | {s.get('turns')} | {fmt_secs(s.get('wall_ms'))} | {fmt_money(s.get('cost_usd'))} |")
    lines.append("")

    by_wall = sorted([s for s in valid if s.get("wall_ms")], key=lambda s: -s.get("wall_ms", 0))[:15]
    lines.append("### Top 15 longest wall-time task-runs")
    lines.append("")
    lines.append("| Task | Variant | Verdict | Wall | Agent | Turns | Cost |")
    lines.append("|---|---|---|---|---|---|---|")
    for s in by_wall:
        lines.append(f"| {s['task_id']} | {s.get('variant','?')} | {s.get('verdict')} | {fmt_secs(s.get('wall_ms'))} | {fmt_secs(s.get('agent_duration_ms'))} | {s.get('turns','-')} | {fmt_money(s.get('cost_usd'))} |")
    lines.append("")

    # === VERDICT FLIPS ===
    lines.append("## Verdict Flips (Baseline → v0.1.34)")
    lines.append("")
    flips_to_fail = []
    flips_to_success = []
    for r in rows:
        b = r["baseline_verdict"]
        v = r["v0134_verdict"]
        if b == "SUCCESS" and v == "FAILURE":
            flips_to_fail.append(r)
        elif b == "FAILURE" and v == "SUCCESS":
            flips_to_success.append(r)
    lines.append(f"### Regressions: {len(flips_to_fail)} (was SUCCESS in baseline, FAILURE in v0.1.34)")
    lines.append("")
    if flips_to_fail:
        lines.append("| Task | Site | Baseline turns/cost | v0.1.34 turns/cost | Retry verdict |")
        lines.append("|---|---|---|---|---|")
        for r in flips_to_fail:
            lines.append(f"| {r['task_id']} | {r['site']} | {r['baseline_turns']}t / {fmt_money(r['baseline_cost'])} | {r['first_turns']}t / {fmt_money(r['first_cost'])} | {r.get('retry_verdict','-')} |")
    lines.append("")
    lines.append(f"### Recoveries: {len(flips_to_success)} (was FAILURE in baseline, SUCCESS in v0.1.34)")
    lines.append("")
    if flips_to_success:
        lines.append("| Task | Site | Baseline turns/cost | v0.1.34 turns/cost |")
        lines.append("|---|---|---|---|")
        for r in flips_to_success:
            lines.append(f"| {r['task_id']} | {r['site']} | {r['baseline_turns']}t / {fmt_money(r['baseline_cost'])} | {r['first_turns']}t / {fmt_money(r['first_cost'])} |")
    lines.append("")

    # === FULL PER-TASK TABLE ===
    lines.append("## Full Per-Task Table (175 canonical)")
    lines.append("")
    lines.append("| Task | Site | Baseline V/T/$/W | v0.1.34 First V/T/$/W | Retry V/T/$/W | Δ vs Baseline |")
    lines.append("|---|---|---|---|---|---|")
    for r in rows:
        b_str = f"{r['baseline_verdict'] or '-'} / {r['baseline_turns'] or '-'}t / {fmt_money(r['baseline_cost'])} / {fmt_secs(r['baseline_wall_ms'])}"
        first_present = r.get("first_verdict") is not None
        f_str = f"{r['first_verdict'] or '-'} / {r['first_turns'] or '-'}t / {fmt_money(r['first_cost'])} / {fmt_secs(r['first_wall_ms'])}" if first_present else "(not retried)"
        retry_present = r.get("retry_verdict") is not None
        r_str = f"{r['retry_verdict'] or '-'} / {r['retry_turns'] or '-'}t / {fmt_money(r['retry_cost'])} / {fmt_secs(r['retry_wall_ms'])}" if retry_present else "-"
        # Delta: turns/cost/wall vs baseline (use latest valid v0.1.34 metric)
        latest = None
        if retry_present and r['retry_verdict'] not in (None, "UNKNOWN", "PENDING_JUDGE"):
            latest = ("retry", r['retry_turns'], r['retry_cost'], r['retry_wall_ms'])
        elif first_present:
            latest = ("first", r['first_turns'], r['first_cost'], r['first_wall_ms'])
        delta_str = "-"
        if latest and r['baseline_turns'] is not None and r['baseline_cost'] is not None and r['baseline_wall_ms'] is not None:
            _, lt, lc, lw = latest
            if lt is not None and lc is not None and lw is not None:
                dt = lt - r['baseline_turns']
                dc = lc - r['baseline_cost']
                dw = lw - r['baseline_wall_ms']
                delta_str = f"{'+' if dt >= 0 else ''}{dt}t / {'+' if dc >= 0 else ''}{fmt_money(abs(dc))} / {'+' if dw >= 0 else ''}{dw/1000:.0f}s"
        lines.append(f"| {r['task_id']} | {r['site']} | {b_str} | {f_str} | {r_str} | {delta_str} |")
    lines.append("")

    # === IMPROVEMENT RECOMMENDATIONS ===
    lines.append("## Improvement Recommendations")
    lines.append("")
    lines.append("### Speed levers")
    lines.append("")
    # Top sites by median wall_ms
    site_walls = defaultdict(list)
    for r in rows:
        if r["v0134_verdict"] == "SUCCESS":
            w = r.get("retry_wall_ms") or r.get("first_wall_ms")
            if w:
                site_walls[r["site"]].append(w)
    site_wall_medians = sorted(
        [(site, statistics.median(walls), len(walls)) for site, walls in site_walls.items() if walls],
        key=lambda x: -x[1]
    )
    lines.append("Top 5 slowest sites by median SUCCESS wall_ms (under v0.1.34):")
    lines.append("")
    for site, med, n in site_wall_medians[:5]:
        lines.append(f"- **{site}** — median {med/1000:.0f}s (n={n}). Recipe candidate.")
    lines.append("")
    lines.append("### Cost levers")
    lines.append("")
    site_costs = defaultdict(list)
    for r in rows:
        if r["v0134_verdict"] == "SUCCESS":
            c = r.get("retry_cost") or r.get("first_cost")
            if c is not None:
                site_costs[r["site"]].append(c)
    site_cost_medians = sorted(
        [(site, statistics.median(costs), len(costs)) for site, costs in site_costs.items() if costs],
        key=lambda x: -x[1]
    )
    lines.append("Top 5 most expensive sites by median SUCCESS cost (under v0.1.34):")
    lines.append("")
    for site, med, n in site_cost_medians[:5]:
        lines.append(f"- **{site}** — median {fmt_money(med)} (n={n}). High-leverage for cost recipe / shorter prompt.")
    lines.append("")
    lines.append("### Retry / turn levers")
    lines.append("")
    site_turns = defaultdict(list)
    for r in rows:
        if r["v0134_verdict"] == "SUCCESS":
            t = r.get("retry_turns") or r.get("first_turns")
            if t:
                site_turns[r["site"]].append(t)
    site_turn_medians = sorted(
        [(site, statistics.median(t), len(t)) for site, t in site_turns.items() if t],
        key=lambda x: -x[1]
    )
    lines.append("Top 5 highest-turn sites by median SUCCESS turns (under v0.1.34) — high turn count = agent fumbling = recipe candidate:")
    lines.append("")
    for site, med, n in site_turn_medians[:5]:
        lines.append(f"- **{site}** — median {int(med)} turns (n={n}). Site-specific recipe + better tool docs would reduce this.")
    lines.append("")
    # Failure patterns
    failures = [r for r in rows if r["v0134_verdict"] == "FAILURE"]
    failure_sites = Counter(r["site"] for r in failures)
    lines.append("### Failure concentration")
    lines.append("")
    lines.append("Sites with the most v0.1.34 FAILUREs:")
    lines.append("")
    for site, count in failure_sites.most_common(8):
        total_at_site = sum(1 for r in rows if r["site"] == site)
        lines.append(f"- **{site}** — {count}/{total_at_site} failed ({fmt_pct(count, total_at_site)}). Investigate failure mode patterns.")
    lines.append("")

    # Write output
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text("\n".join(lines))
    print(f"Wrote {OUTPUT_PATH}")
    print(f"Total rows: {len(rows)}")
    print(f"Regressions: {len(flips_to_fail)}, Recoveries: {len(flips_to_success)}")


if __name__ == "__main__":
    main()
