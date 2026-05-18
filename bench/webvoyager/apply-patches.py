#!/usr/bin/env python3
"""Apply WebVoyager patches.json to a tasks.jsonl, emitting two output files.

patched-2026:    tasks with `substitute` actions applied; tasks with `remove` action dropped.
comparable-original: tasks NOT mentioned in patches (the unpatched, still-valid subset).
"""
import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dataset', required=True, type=Path)
    ap.add_argument('--patches', required=True, type=Path)
    ap.add_argument('--out-patched', required=True, type=Path)
    ap.add_argument('--out-comparable', required=True, type=Path)
    args = ap.parse_args()

    with args.patches.open() as f:
        patches_doc = json.load(f)
    patches = patches_doc.get('patches', {})

    patched_lines: list[str] = []
    comparable_lines: list[str] = []

    with args.dataset.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            task = json.loads(line)
            tid = task.get('id')
            patch = patches.get(tid)
            if patch is None:
                # Not in patches: both sets get the unmodified task
                patched_lines.append(json.dumps(task))
                comparable_lines.append(json.dumps(task))
                continue
            action = patch.get('action')
            if action == 'remove':
                # Dropped from both sets
                continue
            if action == 'substitute':
                field = patch['field']
                find = patch['find']
                replace = patch['replace']
                value = task.get(field, '')
                if find not in value:
                    print(f"ERROR: task {tid} field={field}: 'find' string not present: {find!r}", file=sys.stderr)
                    return 2
                task[field] = value.replace(find, replace, 1)
                patched_lines.append(json.dumps(task))
                # NOT added to comparable (it's a patched task)
                continue
            print(f"ERROR: task {tid}: unknown action {action!r}", file=sys.stderr)
            return 2

    args.out_patched.write_text('\n'.join(patched_lines) + ('\n' if patched_lines else ''))
    args.out_comparable.write_text('\n'.join(comparable_lines) + ('\n' if comparable_lines else ''))
    print(f"Wrote {len(patched_lines)} patched-2026 tasks, {len(comparable_lines)} comparable-original tasks")
    return 0


if __name__ == '__main__':
    sys.exit(main())
