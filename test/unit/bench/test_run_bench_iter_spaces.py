# test/unit/bench/test_run_bench_iter_spaces.py
#
# Regression coverage for the run-bench.sh iteration bug discovered when
# a v0.1.35 single-run patched bench silently skipped 257 tasks (40%) —
# every task whose ID contained a space (Wolfram Alpha, Google Flights,
# Google Search, Google Map, BBC News, Cambridge Dictionary).
#
# Root cause: `for tid in $TASK_IDS` word-splits on whitespace, so
# "Wolfram Alpha--45" was iterated as two separate tokens "Wolfram" and
# "Alpha--45", both raising "task not found in dataset" with no score.json.
#
# This test asserts the wrapper's iteration preserves the full task ID
# string when it contains spaces.

import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
RUN_BENCH = REPO / "bench/webvoyager/run-bench.sh"
DRY_RUN_PREFIX = "WV_DRY_RUN_RESOLVED"


def _parse_marker_ids(combined: str) -> list:
    """Return list of task IDs from WV_DRY_RUN_RESOLVED lines."""
    ids = []
    for line in combined.splitlines():
        if not line.startswith(DRY_RUN_PREFIX):
            continue
        payload = line[len(DRY_RUN_PREFIX):].strip()
        # Format: id=<TASK_ID> url=<URL> ques=<QUES>
        if not payload.startswith("id="):
            continue
        # task ID ends at " url=" (the URL field always starts the next key).
        id_part, _ = payload.split(" url=", 1)
        ids.append(id_part[len("id="):])
    return ids


def test_run_bench_iterates_task_ids_with_spaces_intact():
    """run-bench.sh must iterate task IDs without word-splitting.
    A three-task dataset (one normal ID + two with spaces) must produce
    exactly three dry-run markers whose IDs equal the dataset IDs verbatim
    — no fragmented tokens like 'Wolfram' / 'Alpha--45'."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        ds = tmp / "spaces.jsonl"
        # Two tasks: one normal ID, one with multiple spaces.
        ds.write_text(
            json.dumps({"id": "Normal--1", "web_name": "Normal",
                        "web": "https://example.test/normal",
                        "ques": "normal task ques"}) + "\n" +
            json.dumps({"id": "Wolfram Alpha--45", "web_name": "Wolfram Alpha",
                        "web": "https://example.test/wolfram",
                        "ques": "task on a multi-word site"}) + "\n" +
            json.dumps({"id": "BBC News--3", "web_name": "BBC News",
                        "web": "https://example.test/bbc",
                        "ques": "another multi-word site"}) + "\n"
        )

        env = {**os.environ, "WV_DRY_RUN": "1", "WV_DATASET": str(ds)}
        r = subprocess.run(
            ["bash", str(RUN_BENCH),
             "--patched",
             "--out-dir", str(tmp),
             "--concurrency", "1"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        combined = r.stdout + r.stderr
        assert r.returncode == 0, (
            f"run-bench.sh exited {r.returncode}:\n{combined[-2000:]}"
        )

        ids_seen = _parse_marker_ids(combined)
        # Decisive: the space-containing IDs must appear verbatim, not split.
        assert "Wolfram Alpha--45" in ids_seen, (
            f"Task ID 'Wolfram Alpha--45' was word-split or skipped. "
            f"IDs seen: {ids_seen!r}\n"
            f"Output tail:\n{combined[-2000:]}"
        )
        assert "BBC News--3" in ids_seen, (
            f"Task ID 'BBC News--3' was word-split or skipped. "
            f"IDs seen: {ids_seen!r}"
        )
        # And the normal ID should still work — no regression on single-word IDs.
        assert "Normal--1" in ids_seen, (
            f"Single-word task ID 'Normal--1' missing — possible regression. "
            f"IDs seen: {ids_seen!r}"
        )
        # Exactly the three tasks, nothing fragmented like 'Wolfram' or 'Alpha--45'.
        assert sorted(ids_seen) == sorted(["Normal--1", "Wolfram Alpha--45", "BBC News--3"]), (
            f"Unexpected iteration. Saw {ids_seen!r}; expected exactly the three "
            f"dataset IDs. Word-splitting on whitespace would produce extras like "
            f"'Wolfram', 'Alpha--45', 'BBC', 'News--3'."
        )

        # And no "task not found" errors in the output — the canonical symptom
        # of the original bug.
        assert "task not found in dataset" not in combined, (
            f"Saw 'task not found in dataset' error — IDs were word-split.\n"
            f"{combined[-2000:]}"
        )
