#!/usr/bin/env python3
"""Derive the list of tab URLs a single bench task actually opened/visited.

Reads a Claude `--output-format stream-json` JSONL file (the per-task
`<task>.stream.jsonl` written by run-one-task.sh) and emits one URL per line
on stdout.

Fix D — replaces run-one-task.sh's racy "close anything not in pre-snapshot"
cleanup. At concurrency=4 the pre-snapshot approach mis-closes mid-execution
tabs belonging to concurrent sibling tasks (RCA Q-a: 41 documented
"confirmed-then-TAB_NOT_FOUND" events on 2026-05-18). With this script,
cleanup closes ONLY tabs the agent actually opened during THIS task.

Sources of truth:
- `safari_new_tab` SUCCESS responses (`is_error: false`) carry `tabUrl`.
- `safari_navigate` SUCCESS responses (`is_error: false`) carry `url`.
- Failed events are skipped — the agent never reached those URLs.
- Other tools (Bash, WebFetch) contribute NOTHING even if their text
  payloads happen to contain URL-shaped strings.
"""
from __future__ import annotations
import json
import sys
from typing import Iterable

SAFARI_NEW_TAB = "mcp__safari__safari_new_tab"
SAFARI_NAVIGATE = "mcp__safari__safari_navigate"


def _result_text(block: dict) -> str:
    """Extract the text payload from a tool_result content array. Returns
    '' when no text block is present (some result shapes omit it)."""
    content = block.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                return b.get("text", "")
    return ""


def derive_urls(stream_path: str) -> list[str]:
    use_by_id: dict[str, str] = {}  # tool_use_id -> tool name
    seen: list[str] = []
    seen_set: set[str] = set()

    with open(stream_path, "r", encoding="utf-8") as f:
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
                    name = block.get("name", "")
                    if name in (SAFARI_NEW_TAB, SAFARI_NAVIGATE):
                        use_by_id[block.get("id", "")] = name
                elif btype == "tool_result":
                    use_id = block.get("tool_use_id", "")
                    name = use_by_id.get(use_id)
                    if name is None:
                        continue
                    if block.get("is_error"):
                        # Failed tool — the tab was never actually opened
                        # or never landed at the target URL. Skip.
                        continue
                    text = _result_text(block)
                    if not text:
                        continue
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    url: str | None = None
                    if name == SAFARI_NEW_TAB:
                        url = payload.get("tabUrl") if isinstance(payload, dict) else None
                    elif name == SAFARI_NAVIGATE:
                        url = payload.get("url") if isinstance(payload, dict) else None
                    if isinstance(url, str) and url and url not in seen_set:
                        seen.append(url)
                        seen_set.add(url)
    return seen


def main(argv: Iterable[str]) -> int:
    args = list(argv)
    if len(args) < 2:
        print("usage: derive-task-tabs.py <stream.jsonl>", file=sys.stderr)
        return 2
    urls = derive_urls(args[1])
    for u in urls:
        print(u)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
