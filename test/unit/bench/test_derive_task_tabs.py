# test/unit/bench/test_derive_task_tabs.py
#
# Fix D — bench cleanup race RCA finding. `run-one-task.sh` cleanup currently
# closes any Safari tab whose URL is NOT in the per-task pre-snapshot. At
# bench concurrency=4 that is racy:
#
#   T=0: Task A snapshots [user_tab_1, user_tab_2]
#   T=1: Task B snapshots [user_tab_1, user_tab_2]  (A hasn't opened anything yet)
#   T=2: A's agent opens new_tab_A
#   T=3: B's agent opens new_tab_B
#   T=300: A finishes. Cleanup looks at every window, sees
#          [user_tab_1, user_tab_2, new_tab_A, new_tab_B], closes anything
#          NOT in Snapshot_A → CLOSES both new_tab_A AND new_tab_B.
#
# The 2026-05-18 batch probe (bench-runs/v0136-probes/RCA-batch-regression.md
# §9 Q-a) recorded 41 confirmed "tab confirmed open then later TAB_NOT_FOUND"
# events across 21 distinct tasks — direct evidence of this race.
#
# Fix D: derive each task's own opened-tabs list from its `<task>.stream.jsonl`
# (the safari_new_tab + safari_navigate response payloads carry the actual
# tab URLs). Cleanup closes ONLY those URLs, leaving sibling-task tabs alone.
#
# `bench/webvoyager/derive-task-tabs.py` is the testable unit. It reads a
# stream.jsonl path on argv[1] and writes a newline-separated URL list to
# stdout. Tests use the Chicago-school style — real file I/O, real subprocess
# invocation; no mocks.

from __future__ import annotations
import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DERIVE = REPO / "bench/webvoyager/derive-task-tabs.py"


def _write_stream(tmp_path: Path, events: list[dict]) -> Path:
    """Build a minimal stream.jsonl mimicking Claude's stream-json output.
    Each event is wrapped in the {"type":"assistant","message":{...}}
    or {"type":"user","message":{...}} envelope the runner emits.
    """
    out = tmp_path / "fake.stream.jsonl"
    lines: list[str] = []
    for ev in events:
        lines.append(json.dumps(ev))
    out.write_text("\n".join(lines) + "\n")
    return out


def _derive(stream_path: Path) -> list[str]:
    proc = subprocess.run(
        ["python3", str(DERIVE), str(stream_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def test_extracts_url_from_safari_new_tab_tool_result(tmp_path: Path) -> None:
    # The canonical happy-path event sequence: assistant calls safari_new_tab,
    # then a tool_result block delivers the JSON payload carrying tabUrl.
    stream = _write_stream(tmp_path, [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "t1", "name": "mcp__safari__safari_new_tab",
                     "input": {"url": "https://www.allrecipes.com/"}}
                ]
            }
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "is_error": False,
                     "content": [{"type": "text", "text": '{"tabUrl":"https://www.allrecipes.com/","windowId":3655,"tabIndex":3,"__engine":"applescript"}'}]}
                ]
            }
        },
    ])

    urls = _derive(stream)

    assert "https://www.allrecipes.com/" in urls


def test_extracts_url_from_safari_navigate_tool_result(tmp_path: Path) -> None:
    # safari_navigate response carries `url` (the final URL after navigation,
    # accounting for redirects). Cleanup must close the resulting tab too.
    stream = _write_stream(tmp_path, [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "t2", "name": "mcp__safari__safari_navigate",
                     "input": {"url": "https://www.allrecipes.com/recipe/12345/",
                               "tabUrl": "https://www.allrecipes.com/"}}
                ]
            }
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "t2", "is_error": False,
                     "content": [{"type": "text", "text": '{"url":"https://www.allrecipes.com/recipe/12345/","title":"Lasagna"}'}]}
                ]
            }
        },
    ])

    urls = _derive(stream)

    assert "https://www.allrecipes.com/recipe/12345/" in urls


def test_collects_both_new_tab_and_navigate_urls(tmp_path: Path) -> None:
    # A real task opens with new_tab then navigates. Cleanup needs ALL of
    # those URLs because the agent's tab passes through each one.
    stream = _write_stream(tmp_path, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__safari__safari_new_tab",
             "input": {"url": "https://www.coursera.org/"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "is_error": False,
             "content": [{"type": "text", "text": '{"tabUrl":"https://www.coursera.org/","windowId":1,"tabIndex":1}'}]}
        ]}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t2", "name": "mcp__safari__safari_navigate",
             "input": {"url": "https://www.coursera.org/search", "tabUrl": "https://www.coursera.org/"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t2", "is_error": False,
             "content": [{"type": "text", "text": '{"url":"https://www.coursera.org/search"}'}]}
        ]}},
    ])

    urls = _derive(stream)

    assert "https://www.coursera.org/" in urls
    assert "https://www.coursera.org/search" in urls


def test_ignores_failed_safari_new_tab_results(tmp_path: Path) -> None:
    # When safari_new_tab errored (AppleScript no-window, etc.) NO tab was
    # actually created — cleanup must NOT add the requested URL. This is
    # critical: pre-Fix-B the agent retried safari_new_tab 5–6 times against
    # 0-window Safari; each errored. If derive-task-tabs naively pulled the
    # `input.url` field, it would emit URLs for tabs that were never opened.
    stream = _write_stream(tmp_path, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__safari__safari_new_tab",
             "input": {"url": "https://www.example.com/"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "is_error": True,
             "content": [{"type": "text", "text": '{"error":"Can\'t get window 1. Invalid index. (-1719)"}'}]}
        ]}},
    ])

    urls = _derive(stream)

    assert urls == []


def test_ignores_failed_safari_navigate_results(tmp_path: Path) -> None:
    # Error-parity with test_ignores_failed_safari_new_tab_results. A failed
    # safari_navigate (404, DNS, AppleScript "Can't set window id ...")
    # means the tab DID NOT actually arrive at the requested URL. Including
    # it in the cleanup set would cause us to close a tab at a URL that
    # was never opened — or worse, close a coincident user tab at that
    # URL. Failed navigates must be skipped, just like failed new_tabs.
    stream = _write_stream(tmp_path, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__safari__safari_navigate",
             "input": {"url": "https://example.com/missing", "tabUrl": "x"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "is_error": True,
             "content": [{"type": "text", "text": '{"error":"Can\'t set window id 3655 to \\"https://example.com/missing\\" (-10006)"}'}]}
        ]}},
    ])

    urls = _derive(stream)

    assert urls == []


def test_returns_empty_list_for_empty_stream(tmp_path: Path) -> None:
    # Degenerate case: the agent never called any safari_* tool. Cleanup
    # has nothing to close.
    stream = _write_stream(tmp_path, [])

    urls = _derive(stream)

    assert urls == []


def test_does_not_include_urls_from_other_tools(tmp_path: Path) -> None:
    # Defense-in-depth — Bash/WebFetch/etc. tool_use blocks must NOT
    # contribute URLs to the cleanup set, even when their input/result
    # contains URL-shaped strings. Only safari_new_tab and safari_navigate
    # tool_use events with successful tool_result envelopes count.
    stream = _write_stream(tmp_path, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "b1", "name": "Bash",
             "input": {"command": "curl https://www.example.com/"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "b1", "is_error": False,
             "content": [{"type": "text", "text": '{"output":"<html>... https://www.example.com/x ...</html>"}'}]}
        ]}},
    ])

    urls = _derive(stream)

    assert urls == []


def test_deduplicates_repeated_urls(tmp_path: Path) -> None:
    # Agent may retry safari_navigate to the same URL across recovery
    # attempts. Output is a unique set — duplicates don't change cleanup
    # behaviour but they bloat the cleanup AppleScript.
    stream = _write_stream(tmp_path, [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "mcp__safari__safari_navigate",
             "input": {"url": "https://www.espn.com/", "tabUrl": "x"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "is_error": False,
             "content": [{"type": "text", "text": '{"url":"https://www.espn.com/"}'}]}
        ]}},
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t2", "name": "mcp__safari__safari_navigate",
             "input": {"url": "https://www.espn.com/", "tabUrl": "x"}}
        ]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t2", "is_error": False,
             "content": [{"type": "text", "text": '{"url":"https://www.espn.com/"}'}]}
        ]}},
    ])

    urls = _derive(stream)

    assert urls.count("https://www.espn.com/") == 1
