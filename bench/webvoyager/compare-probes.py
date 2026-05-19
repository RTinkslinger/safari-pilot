#!/usr/bin/env python3
"""Systematic cross-runner probe comparator.

For every task_id present in either probe directory, joins the score.json,
stream.jsonl, pretty.log, and screenshot for both runners and emits:

  1. A per-task CSV with structured features (verdicts, turns, wall, tool
     counts by code, screenshot dimensions, answer similarity, judge
     reasoning excerpts).
  2. An aggregate classification of SP=lost-vs-PW failure modes drawn from
     the actual judge_reasoning text — not from a single hypothesis.
  3. A cross-tab of (SP verdict × PW verdict) and per-site rates.

Usage:
  python3 compare-probes.py <sp-dir> <pw-dir> <tasks-jsonl> [--csv out.csv]

Output to stdout is the structured report; CSV is optional.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
import struct
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


# ─── Screenshot dim helpers (zero deps — read PNG IHDR directly) ──────────
def png_dims(path: Path | None) -> tuple[int, int] | None:
    if not path or not path.exists():
        return None
    try:
        with path.open("rb") as f:
            sig = f.read(8)
            if sig != b"\x89PNG\r\n\x1a\n":
                return None
            # IHDR is the first chunk after signature.
            f.read(4)  # IHDR length
            f.read(4)  # 'IHDR'
            width, height = struct.unpack(">II", f.read(8))
            return (width, height)
    except (OSError, struct.error):
        return None


# ─── Stream-jsonl extractors ────────────────────────────────────────────
def extract_tool_stats(stream_path: Path) -> dict[str, Any]:
    """Return tool_calls (count), tools_used (set of tool names),
    error_codes (Counter), tool_use_id_to_name (for tool_result pairing).
    """
    tools_used: Counter[str] = Counter()
    error_codes: Counter[str] = Counter()
    use_by_id: dict[str, str] = {}

    if not stream_path.exists():
        return {"tool_calls": 0, "tools_used": Counter(), "error_codes": Counter()}

    with stream_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("type") not in ("assistant", "user"):
                continue
            msg = d.get("message") or {}
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "tool_use":
                    name = block.get("name", "") or ""
                    use_by_id[block.get("id", "")] = name
                    short = name.split("__")[-1] if "__" in name else name
                    tools_used[short] += 1
                elif btype == "tool_result":
                    if not block.get("is_error"):
                        continue
                    use_id = block.get("tool_use_id", "")
                    inner = block.get("content")
                    text = ""
                    if isinstance(inner, list) and inner and isinstance(inner[0], dict):
                        text = inner[0].get("text", "") or ""
                    elif isinstance(inner, str):
                        text = inner
                    code = None
                    try:
                        payload = json.loads(text) if text else None
                        if isinstance(payload, dict):
                            code = payload.get("error") or payload.get("code")
                    except json.JSONDecodeError:
                        pass
                    if not code:
                        # Fall back to substring detection on the raw error text.
                        for c in (
                            "DAEMON_TIMEOUT", "TAB_NOT_FOUND", "TAB_URL_NOT_RECOGNIZED",
                            "CSP_BLOCKED", "EXTENSION_ERROR", "EXTENSION_TIMEOUT",
                            "WALL_CAP_EXCEEDED", "SCREENSHOT_FAILED", "LOCATOR_FAILED",
                            "STORAGE_BUS_NOT_READY", "Browser is already in use",
                            "File access denied",
                            "rate limit",
                        ):
                            if c.lower() in text.lower():
                                code = c
                                break
                    error_codes[code or "OTHER"] += 1
    return {
        "tool_calls": sum(tools_used.values()),
        "tools_used": tools_used,
        "error_codes": error_codes,
    }


# ─── Failure-mode classifier ────────────────────────────────────────────
JUDGE_PATTERNS = [
    # (regex, label) — applied to lower-cased judge_reasoning.
    (re.compile(r"screenshot.+(does not|no|cannot|insuff|lack).+(contain|verify|evidence|support|show|inform)"),
     "judge_screenshot_lacks_evidence"),
    (re.compile(r"(blank|black|empty).+screenshot|screenshot.+(blank|black|empty)"),
     "judge_screenshot_blank"),
    (re.compile(r"daemon[_ ]timeout|technical (issues|difficulties)|persistent (errors|technical|timeouts)"),
     "judge_technical_issues_cited"),
    (re.compile(r"answer.+(wrong|incorrect|not match|fabricat|hallucin)"),
     "judge_answer_incorrect"),
    (re.compile(r"abstain|gave up|did not complete|insufficient"),
     "judge_abstained"),
    (re.compile(r"(not the latest|outdated|stale)"),
     "judge_stale_data"),
]


def classify_judge(reasoning: str) -> list[str]:
    if not reasoning:
        return []
    r = reasoning.lower()
    return [label for pat, label in JUDGE_PATTERNS if pat.search(r)]


# ─── Answer-similarity ──────────────────────────────────────────────────
def answer_overlap(a: str, b: str) -> float:
    """Cheap word-set Jaccard, lowercased, alphanumeric only."""
    def toks(s: str) -> set[str]:
        return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if len(w) >= 3}
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# ─── Main ───────────────────────────────────────────────────────────────
def load_probe(probe_dir: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(probe_dir.glob("*.score.json")):
        try:
            score = json.loads(p.read_text())
        except json.JSONDecodeError:
            continue
        tid = score.get("task_id")
        if not tid:
            continue
        base = p.parent / p.name.replace(".score.json", "")
        stream = Path(str(base) + ".stream.jsonl")
        screenshot = Path(score["screenshot_path"]) if score.get("screenshot_path") else None
        dims = png_dims(screenshot)
        tstats = extract_tool_stats(stream)
        out[tid] = {
            "score": score,
            "stream": stream,
            "screenshot": screenshot,
            "dims": dims,
            "tstats": tstats,
        }
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sp_dir")
    ap.add_argument("pw_dir")
    ap.add_argument("tasks_jsonl")
    ap.add_argument("--csv", default=None)
    args = ap.parse_args(argv[1:])

    sp_dir, pw_dir = Path(args.sp_dir), Path(args.pw_dir)
    tasks: dict[str, dict[str, str]] = {}
    for line in Path(args.tasks_jsonl).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        t = json.loads(line)
        tasks[t["id"]] = {"site": t["web_name"], "question": t["ques"]}

    sp = load_probe(sp_dir)
    pw = load_probe(pw_dir)

    # ── Cross-tab ─────────────────────────────────────────────────────
    cross: Counter[tuple[str, str]] = Counter()
    site_table: dict[str, Counter[str]] = defaultdict(Counter)
    for tid, meta in tasks.items():
        sp_v = sp.get(tid, {}).get("score", {}).get("verdict", "MISSING")
        pw_v = pw.get(tid, {}).get("score", {}).get("verdict", "MISSING")
        cross[(sp_v, pw_v)] += 1
        site_table[meta["site"]][f"SP={sp_v}|PW={pw_v}"] += 1

    # ── Per-task rows ─────────────────────────────────────────────────
    rows: list[dict[str, Any]] = []
    for tid in sorted(tasks):
        meta = tasks[tid]
        sp_d, pw_d = sp.get(tid, {}), pw.get(tid, {})
        sp_s, pw_s = sp_d.get("score", {}), pw_d.get("score", {})
        sp_dims, pw_dims = sp_d.get("dims"), pw_d.get("dims")
        sp_ts, pw_ts = sp_d.get("tstats", {}), pw_d.get("tstats", {})
        sp_final, pw_final = sp_s.get("agent_final_text", "") or "", pw_s.get("agent_final_text", "") or ""
        sp_judge = sp_s.get("judge_reasoning", "") or ""
        pw_judge = pw_s.get("judge_reasoning", "") or ""

        sp_top_err = ",".join(f"{c}:{n}" for c, n in (sp_ts.get("error_codes") or Counter()).most_common(3))
        pw_top_err = ",".join(f"{c}:{n}" for c, n in (pw_ts.get("error_codes") or Counter()).most_common(3))

        rows.append({
            "task_id": tid,
            "site": meta["site"],
            "SP_v": sp_s.get("verdict", "MISSING"),
            "PW_v": pw_s.get("verdict", "MISSING"),
            "SP_turns": sp_s.get("turns", ""),
            "PW_turns": pw_s.get("turns", ""),
            "SP_wall_s": (sp_s.get("wall_ms", 0) or 0) // 1000,
            "PW_wall_s": (pw_s.get("wall_ms", 0) or 0) // 1000,
            "SP_tools": sp_ts.get("tool_calls", ""),
            "PW_tools": pw_ts.get("tool_calls", ""),
            "SP_errs": sp_top_err,
            "PW_errs": pw_top_err,
            "SP_shot_dims": f"{sp_dims[0]}x{sp_dims[1]}" if sp_dims else "",
            "PW_shot_dims": f"{pw_dims[0]}x{pw_dims[1]}" if pw_dims else "",
            "SP_shot_h": sp_dims[1] if sp_dims else 0,
            "PW_shot_h": pw_dims[1] if pw_dims else 0,
            "ans_overlap": f"{answer_overlap(sp_final, pw_final):.2f}",
            "SP_judge_tags": ",".join(classify_judge(sp_judge)) or "-",
            "PW_judge_tags": ",".join(classify_judge(pw_judge)) or "-",
            "SP_final_head": (sp_final.replace("\n", " ")[:140]),
            "PW_final_head": (pw_final.replace("\n", " ")[:140]),
            "SP_judge_head": (sp_judge.replace("\n", " ")[:200]),
        })

    # ── Print summary ─────────────────────────────────────────────────
    print(f"# Probe comparison — SP={sp_dir.name} vs PW={pw_dir.name}\n")
    print(f"Tasks: {len(tasks)} (SP scored: {len(sp)}, PW scored: {len(pw)})\n")

    print("## Verdict cross-tab (SP × PW)\n")
    sp_verdicts = sorted({v for v, _ in cross})
    pw_verdicts = sorted({v for _, v in cross})
    header = ["SP \\ PW"] + pw_verdicts
    print("| " + " | ".join(header) + " |")
    print("|" + "|".join(["---"] * len(header)) + "|")
    for spv in sp_verdicts:
        row = [spv] + [str(cross.get((spv, pwv), 0)) for pwv in pw_verdicts]
        print("| " + " | ".join(row) + " |")
    print()

    print("## Per-site (SP × PW) verdicts\n")
    for site in sorted(site_table):
        ctr = site_table[site]
        sp_s = sum(n for k, n in ctr.items() if k.startswith("SP=SUCCESS"))
        pw_s = sum(n for k, n in ctr.items() if "PW=SUCCESS" in k)
        total = sum(ctr.values())
        print(f"- **{site}** (n={total}): SP_success={sp_s} PW_success={pw_s}")
        for k, n in sorted(ctr.items(), key=lambda kv: -kv[1]):
            print(f"    {k}: {n}")
    print()

    # ── Diagnostic slices ─────────────────────────────────────────────
    pw_won_sp_lost = [r for r in rows if r["PW_v"] == "SUCCESS" and r["SP_v"] != "SUCCESS"]
    sp_won_pw_lost = [r for r in rows if r["SP_v"] == "SUCCESS" and r["PW_v"] != "SUCCESS"]
    both_failed = [r for r in rows if r["SP_v"] != "SUCCESS" and r["PW_v"] != "SUCCESS"]
    both_won = [r for r in rows if r["SP_v"] == "SUCCESS" and r["PW_v"] == "SUCCESS"]

    print(f"## Slices\n")
    print(f"- PW won, SP lost: **{len(pw_won_sp_lost)}** ← the addressable gap")
    print(f"- SP won, PW lost: {len(sp_won_pw_lost)}")
    print(f"- Both won: {len(both_won)}")
    print(f"- Both failed: {len(both_failed)}\n")

    # ── Failure-mode tally on SP=lost cases ───────────────────────────
    print("## SP-lost-while-PW-won — failure-mode tally (from judge_reasoning + answer overlap + shot dims)\n")

    tag_counts: Counter[str] = Counter()
    shot_h_lt_pw: list[str] = []  # SP screenshot shorter than PW's
    high_overlap_but_failure: list[str] = []  # SP answer ≈ PW answer but SP FAILURE
    sp_no_shot: list[str] = []
    sp_daemon_timeout: list[str] = []
    sp_no_safari_mcp: list[str] = []

    for r in pw_won_sp_lost:
        for tag in (r["SP_judge_tags"] or "").split(","):
            if tag and tag != "-":
                tag_counts[tag] += 1
        if r["SP_shot_h"] and r["PW_shot_h"] and r["SP_shot_h"] < r["PW_shot_h"] * 0.6:
            shot_h_lt_pw.append(f'{r["task_id"]} (SP={r["SP_shot_dims"]} vs PW={r["PW_shot_dims"]})')
        if float(r["ans_overlap"]) >= 0.40 and r["SP_v"] == "FAILURE":
            high_overlap_but_failure.append(f'{r["task_id"]} (overlap={r["ans_overlap"]})')
        if not r["SP_shot_dims"]:
            sp_no_shot.append(r["task_id"])
        if "DAEMON_TIMEOUT" in (r["SP_errs"] or ""):
            sp_daemon_timeout.append(r["task_id"])
        # Detect "safari MCP not loaded" via final text head heuristic
        if "tools are not" in (r["SP_final_head"] or "").lower() and "safari" in (r["SP_final_head"] or "").lower():
            sp_no_safari_mcp.append(r["task_id"])

    print("### Judge-reasoning tags (counts across SP-lost)\n")
    for tag, n in tag_counts.most_common():
        print(f"- {tag}: {n}")
    print()

    print(f"### Screenshot truncation (SP height < 60% PW height): {len(shot_h_lt_pw)} tasks\n")
    for x in shot_h_lt_pw[:25]:
        print(f"- {x}")
    print()

    print(f"### Answer-correct-but-judge-failed (SP & PW answers ≥40% word overlap AND SP=FAILURE): {len(high_overlap_but_failure)} tasks\n")
    for x in high_overlap_but_failure[:25]:
        print(f"- {x}")
    print()

    print(f"### SP screenshot missing entirely: {len(sp_no_shot)} tasks: {', '.join(sp_no_shot[:20])}\n")
    print(f"### SP had DAEMON_TIMEOUT errors: {len(sp_daemon_timeout)} tasks: {', '.join(sp_daemon_timeout[:20])}\n")
    print(f"### SP final-text said 'safari tools not available': {len(sp_no_safari_mcp)} tasks: {', '.join(sp_no_safari_mcp[:20])}\n")

    # ── PW failure-modes for completeness ─────────────────────────────
    pw_failed = [r for r in rows if r["PW_v"] not in ("SUCCESS", "MISSING")]
    pw_tags: Counter[str] = Counter()
    for r in pw_failed:
        for tag in (r["PW_judge_tags"] or "").split(","):
            if tag and tag != "-":
                pw_tags[tag] += 1
    print(f"\n## PW failure-mode tags ({len(pw_failed)} non-success tasks)\n")
    for t, n in pw_tags.most_common():
        print(f"- {t}: {n}")

    # ── CSV ───────────────────────────────────────────────────────────
    if args.csv:
        with open(args.csv, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nCSV written: {args.csv}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
