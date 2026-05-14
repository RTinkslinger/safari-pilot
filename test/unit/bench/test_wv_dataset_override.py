# test/unit/bench/test_wv_dataset_override.py
#
# Regression coverage for the run-one-task.sh / run-bench.sh wiring bug:
# run-one-task.sh hard-coded the original WebVoyager dataset path, so
# `run-bench.sh --patched` cherry-picked task IDs from patched-2026.jsonl
# but children re-resolved them against the unpatched original. The
# patches (date substitutions, removals) never reached the agent.
#
# These tests assert the behavioral contract:
#   1. run-one-task.sh, when WV_DRY_RUN=1, emits a structured
#      `WV_DRY_RUN_RESOLVED url=<URL> ques=<QUES>` line on stdout after
#      resolving fields, then exits 0 BEFORE invoking claude.
#   2. run-one-task.sh reads task fields from $WV_DATASET when set,
#      falling back to the default original dataset otherwise.
#   3. run-bench.sh --patched, with NO parent WV_DATASET override,
#      causes children to resolve `ques` from patched-2026.jsonl —
#      proving the wrapper actually propagates its DATASET selection.
#
# Test 3 is the decisive test for the shipped bug: it does NOT pre-set
# WV_DATASET in the parent env, so a no-op wrapper that ignores --patched
# entirely would fail it.

import json
import os
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
RUN_ONE = REPO / "bench/webvoyager/run-one-task.sh"
RUN_BENCH = REPO / "bench/webvoyager/run-bench.sh"
PATCHED_DS = REPO / "bench/webvoyager/patched-2026.jsonl"
ORIGINAL_DS = REPO / "bench/webvoyager/data/data/WebVoyager_data.jsonl"
PATCHES_JSON = REPO / "bench/webvoyager/patches.json"

DRY_RUN_PREFIX = "WV_DRY_RUN_RESOLVED"


def _write_mock_dataset(tmp: Path, task_id: str, url: str, ques: str) -> Path:
    ds = tmp / "mock.jsonl"
    ds.write_text(
        json.dumps({"id": task_id, "web_name": "test", "web": url, "ques": ques}) + "\n"
    )
    return ds


def _parse_marker(line: str) -> dict:
    """Parse a single WV_DRY_RUN_RESOLVED line.

    Format: 'WV_DRY_RUN_RESOLVED id=<TASK_ID> url=<URL> ques=<QUES>'

    Returns dict with keys 'id', 'url', 'ques'. Raises AssertionError if malformed."""
    assert line.startswith(DRY_RUN_PREFIX), f"not a dry-run marker: {line!r}"
    payload = line[len(DRY_RUN_PREFIX):].strip()
    assert payload.startswith("id="), (
        f"malformed dry-run marker (expected 'id=' first): {line!r}"
    )
    try:
        id_part, rest = payload.split(" url=", 1)
        url_part, ques_part = rest.split(" ques=", 1)
    except ValueError as e:
        raise AssertionError(f"malformed dry-run marker: {line!r}") from e
    return {
        "id": id_part[len("id="):],
        "url": url_part,
        "ques": ques_part,
    }


def _extract_resolved(combined: str) -> dict:
    """Parse the first WV_DRY_RUN_RESOLVED line from script output."""
    for line in combined.splitlines():
        if line.startswith(DRY_RUN_PREFIX):
            return _parse_marker(line)
    raise AssertionError(
        f"no '{DRY_RUN_PREFIX}' line found in script output:\n{combined[-2000:]}"
    )


def test_run_one_task_dry_run_emits_structured_resolved_marker_from_wv_dataset():
    """run-one-task.sh, when WV_DRY_RUN=1 and WV_DATASET is set to a mock
    dataset, must emit a structured `WV_DRY_RUN_RESOLVED url=... ques=...`
    marker on stdout containing the URL and QUES from the mock dataset
    (NOT from the default original dataset), then exit 0 before invoking
    claude."""
    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        # Use a task ID guaranteed absent from the original dataset so we
        # know any successful resolution had to come from WV_DATASET.
        # The original dataset's IDs follow the pattern `<site>--<N>`; our
        # synthetic SPTEST--1 cannot collide.
        marker_ques = "SP_TEST_MARKER_QUES wv-dataset-override-2026"
        marker_url = "https://example.invalid/sp-test-marker-url"
        mock_ds = _write_mock_dataset(tmp, "SPTEST--1", marker_url, marker_ques)

        # Sanity: SPTEST--1 truly absent from the canonical original dataset.
        with open(ORIGINAL_DS) as f:
            for line in f:
                if line.strip() and json.loads(line).get("id") == "SPTEST--1":
                    raise AssertionError(
                        "SPTEST--1 collides with a real WebVoyager task — pick a different test ID"
                    )

        env = {
            **os.environ,
            "WV_DATASET": str(mock_ds),
            "WV_DRY_RUN": "1",
            "WV_OUT_DIR": str(tmp),
        }
        r = subprocess.run(
            ["bash", str(RUN_ONE), "SPTEST--1"],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        combined = r.stdout + r.stderr
        assert r.returncode == 0, (
            f"run-one-task.sh exited {r.returncode} (expected 0 for dry-run):\n{combined}"
        )

        resolved = _extract_resolved(combined)
        assert resolved["url"] == marker_url, (
            f"resolved URL mismatch — wanted {marker_url!r}, got {resolved['url']!r}.\n"
            f"This means run-one-task.sh did not read from WV_DATASET."
        )
        assert resolved["ques"] == marker_ques, (
            f"resolved QUES mismatch — wanted {marker_ques!r}, got {resolved['ques']!r}.\n"
            f"This means run-one-task.sh did not read from WV_DATASET."
        )


def test_run_one_task_falls_back_to_default_dataset_when_wv_dataset_unset():
    """When WV_DATASET is NOT set, run-one-task.sh must still resolve
    fields from the default original dataset (backwards compatible).

    We use a known real task ID to verify."""
    # Pick the first task from the original dataset as our reference.
    with open(ORIGINAL_DS) as f:
        first_task = json.loads(next(line for line in f if line.strip()))
    real_id = first_task["id"]
    expected_ques = first_task["ques"]
    expected_url = first_task["web"]

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        env = {**os.environ, "WV_DRY_RUN": "1", "WV_OUT_DIR": str(tmp)}
        # Explicitly UNSET WV_DATASET if present in parent env.
        env.pop("WV_DATASET", None)
        r = subprocess.run(
            ["bash", str(RUN_ONE), real_id],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        combined = r.stdout + r.stderr
        assert r.returncode == 0, (
            f"run-one-task.sh exited {r.returncode} for {real_id}:\n{combined}"
        )
        resolved = _extract_resolved(combined)
        assert resolved["url"] == expected_url
        assert resolved["ques"] == expected_ques


def test_run_bench_patched_mode_propagates_patched_ques_without_parent_override():
    """Decisive test for the shipped bug. With NO parent WV_DATASET
    override, run-bench.sh --patched must cause children to resolve `ques`
    from patched-2026.jsonl. A no-op wrapper that ignores --patched would
    fail this test.

    Strategy: find the first task in patched-2026.jsonl whose ques actually
    differs from the original, compute its 1-based position, run the
    wrapper with --limit (position) so the iteration reaches it. Capture
    all child dry-run output and assert the patched ques appears AND the
    original ques does NOT."""
    assert PATCHED_DS.exists(), (
        f"missing {PATCHED_DS}; run `python3 bench/webvoyager/apply-patches.py` first"
    )

    # Build map of (ques, web) per task ID for the original dataset.
    original_by_id = {}
    with open(ORIGINAL_DS) as f:
        for line in f:
            if line.strip():
                t = json.loads(line)
                original_by_id[t["id"]] = {"ques": t["ques"], "web": t["web"]}

    # Walk patched-2026.jsonl in order, find first task with changed ques.
    diff_id = None
    diff_position = None
    patched_ques_value = None
    original_ques_value = None
    diff_url = None
    with open(PATCHED_DS) as f:
        for idx, line in enumerate(f, start=1):
            if not line.strip():
                continue
            t = json.loads(line)
            tid, ques = t["id"], t["ques"]
            orig = original_by_id.get(tid)
            if orig is not None and orig["ques"] != ques:
                diff_id = tid
                diff_position = idx
                patched_ques_value = ques
                original_ques_value = orig["ques"]
                diff_url = orig["web"]
                break

    assert diff_id is not None, (
        "patches.json appears to be empty (no substitutions). "
        "Test cannot verify patched-vs-original distinction. "
        "Add at least one substitute entry to patches.json."
    )

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp = Path(tmp_str)
        env = {**os.environ, "WV_DRY_RUN": "1"}
        # CRITICAL: do NOT pre-set WV_DATASET. The wrapper must select
        # patched-2026.jsonl on its own from the --patched flag and
        # propagate it to children.
        env.pop("WV_DATASET", None)

        r = subprocess.run(
            [
                "bash", str(RUN_BENCH),
                "--patched",
                "--limit", str(diff_position),
                "--out-dir", str(tmp),
                "--concurrency", "4",
            ],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        combined = r.stdout + r.stderr
        assert r.returncode == 0, (
            f"run-bench.sh --patched exited {r.returncode}:\n{combined[-3000:]}"
        )

        # Collect ALL resolved markers from the iteration.
        resolved_lines = [
            line for line in combined.splitlines() if line.startswith(DRY_RUN_PREFIX)
        ]
        assert len(resolved_lines) >= diff_position, (
            f"expected at least {diff_position} dry-run markers (one per task), "
            f"got {len(resolved_lines)}:\n{combined[-2000:]}"
        )

        # Find the marker whose task ID matches diff_id and verify ques is PATCHED.
        # ID-keying is unambiguous (a single bench task per ID); using URL fails
        # because many tasks share the same site root URL.
        diff_marker = None
        for line in resolved_lines:
            parsed = _parse_marker(line)
            if parsed["id"] == diff_id:
                diff_marker = parsed
                break

        assert diff_marker is not None, (
            f"No dry-run marker found for task ID {diff_id!r}.\n"
            f"Tail of dry-run markers ({len(resolved_lines)} total):\n"
            + "\n".join(resolved_lines[-5:])
        )
        assert diff_marker["ques"] == patched_ques_value, (
            f"--patched did NOT propagate patched ques for {diff_id}.\n"
            f"Expected (patched): {patched_ques_value[:200]!r}\n"
            f"Got (from child dry-run): {diff_marker['ques'][:200]!r}"
        )
        # And explicitly: the child did not see the ORIGINAL ques for this task.
        assert diff_marker["ques"] != original_ques_value, (
            f"--patched leaked the ORIGINAL ques into the child for {diff_id}.\n"
            f"Original ques: {original_ques_value[:200]!r}"
        )
