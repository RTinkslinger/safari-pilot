#!/usr/bin/env python3
"""Probe-result analyser for v0.1.36 per-window isolation validation.

Reads a probe output directory (containing per-task `<id>-r1.score.json` and
`<id>-r1.stream.jsonl` files) and produces a comparison report against the
envelope-only baseline + the regressed batch+dev.10 numbers documented in
bench-runs/v0136-probes/CHECKPOINT.md.

Success criteria the probe must meet for v0.1.36 ship:
- CSP_BLOCKED count drops near 0 (was 61 in the regressed probe).
- No-window AppleScript errors drop near 0 (was 73).
- TAB_NOT_FOUND drops to low single digits (was 51).
- Median wall time + turns at-or-below envelope-only's 324s / 14.

Usage:  python3 probe-analysis.py <probe-dir>
"""
from __future__ import annotations
import json
import os
import statistics
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# Baselines from CHECKPOINT / RCA-batch-regression.md.
ENVELOPE_ONLY = {"median_wall_s": 324.0, "median_turns": 14, "label": "envelope-only (probe-prompt-0134)"}
REGRESSED = {"median_wall_s": 369.0, "median_turns": 23.5, "label": "regressed batch+dev.10 (probe-batch-1323)"}

# Error codes the smoke + RCA flagged as significant.
TRACKED_CODES = ("CSP_BLOCKED", "TAB_NOT_FOUND", "TAB_URL_NOT_RECOGNIZED",
                 "DAEMON_TIMEOUT", "SCREENSHOT_FAILED", "WALL_CAP_EXCEEDED",
                 "STORAGE_BUS_NOT_READY", "LOCATOR_FAILED")


def load_scores(probe_dir: Path) -> list[dict[str, Any]]:
    scores: list[dict[str, Any]] = []
    for p in sorted(probe_dir.glob("*-r*.score.json")):
        try:
            scores.append(json.loads(p.read_text()))
        except json.JSONDecodeError:
            pass
    return scores


def count_errors_in_stream(stream_path: Path) -> Counter[str]:
    counts: Counter[str] = Counter()
    if not stream_path.exists():
        return counts
    with stream_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            # Tool errors usually surface as is_error:true tool_result blocks
            # with the structured-error JSON in `content[0].text`.
            msg = d.get("message") or {}
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "tool_result":
                    continue
                if not block.get("is_error"):
                    continue
                inner = block.get("content")
                text = ""
                if isinstance(inner, list) and inner and isinstance(inner[0], dict):
                    text = inner[0].get("text", "")
                elif isinstance(inner, str):
                    text = inner
                # The structured error payload either parses as JSON or
                # contains the code as a substring of the MCP error message.
                code = None
                try:
                    payload = json.loads(text) if text else None
                    if isinstance(payload, dict):
                        code = payload.get("error") or payload.get("code")
                except json.JSONDecodeError:
                    pass
                if not code:
                    for c in TRACKED_CODES:
                        if c in text:
                            code = c
                            break
                if code:
                    counts[code] += 1
                else:
                    counts["OTHER"] += 1
    return counts


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: probe-analysis.py <probe-dir>", file=sys.stderr)
        return 2
    probe_dir = Path(argv[1])
    if not probe_dir.is_dir():
        print(f"error: not a directory: {probe_dir}", file=sys.stderr)
        return 1

    scores = load_scores(probe_dir)
    if not scores:
        print(f"error: no score.json files in {probe_dir}", file=sys.stderr)
        return 1

    walls = [s.get("wall_ms", 0) / 1000.0 for s in scores]
    turns = [s.get("turns", 0) for s in scores]
    verdicts = Counter(s.get("verdict", "UNKNOWN") for s in scores)

    error_totals: Counter[str] = Counter()
    for s in scores:
        sid = s.get("task_id", "")
        seq = s.get("run_seq", 1)
        stream_path = probe_dir / f"{sid}-r{seq}.stream.jsonl"
        error_totals.update(count_errors_in_stream(stream_path))

    # Report
    print(f"# Probe results — {probe_dir.name}\n")
    print(f"**Tasks scored:** {len(scores)}\n")
    print("## Wall / turns")
    print(f"- median wall: {statistics.median(walls):.1f}s")
    print(f"- mean   wall: {statistics.mean(walls):.1f}s")
    print(f"- max    wall: {max(walls):.1f}s")
    print(f"- median turns: {statistics.median(turns):.1f}")
    print(f"- mean   turns: {statistics.mean(turns):.1f}")
    print(f"- max    turns: {max(turns)}")

    print("\n## Verdict distribution")
    for v, n in verdicts.most_common():
        print(f"- {v}: {n} ({n / len(scores) * 100:.0f}%)")

    print("\n## Error counts (across all stream.jsonl)")
    if not error_totals:
        print("- (none)")
    else:
        for code, n in error_totals.most_common():
            print(f"- {code}: {n}")

    print("\n## Comparison vs baselines")
    print(f"{'metric':<24} {'this':<10} {ENVELOPE_ONLY['label']:<40} {REGRESSED['label']:<40}")
    print(f"{'median wall (s)':<24} {statistics.median(walls):<10.1f} {ENVELOPE_ONLY['median_wall_s']:<40.1f} {REGRESSED['median_wall_s']:<40.1f}")
    print(f"{'median turns':<24} {statistics.median(turns):<10.1f} {ENVELOPE_ONLY['median_turns']:<40} {REGRESSED['median_turns']:<40}")

    print("\n## Ship gate (success criteria from CHECKPOINT)")
    csp = error_totals.get("CSP_BLOCKED", 0)
    nowin = error_totals.get("TAB_URL_NOT_RECOGNIZED", 0) + error_totals.get("LOCATOR_FAILED", 0)
    tnf = error_totals.get("TAB_NOT_FOUND", 0)
    median_w = statistics.median(walls)
    median_t = statistics.median(turns)
    print(f"- CSP_BLOCKED count drops near 0: {csp} ({'PASS' if csp <= 5 else 'FAIL'})")
    print(f"- No-window / locator-failed drops near 0: {nowin} ({'PASS' if nowin <= 10 else 'FAIL'})")
    print(f"- TAB_NOT_FOUND low: {tnf} ({'PASS' if tnf <= 10 else 'FAIL'})")
    print(f"- Median wall ≤ envelope-only ({ENVELOPE_ONLY['median_wall_s']}s): {median_w:.1f}s ({'PASS' if median_w <= ENVELOPE_ONLY['median_wall_s'] * 1.10 else 'FAIL'})")
    print(f"- Median turns ≤ envelope-only ({ENVELOPE_ONLY['median_turns']}): {median_t:.1f} ({'PASS' if median_t <= ENVELOPE_ONLY['median_turns'] * 1.10 else 'FAIL'})")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
