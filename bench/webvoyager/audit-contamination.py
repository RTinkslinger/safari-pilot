#!/usr/bin/env python3
"""Scan WebVoyager bench traces for benchmark-contamination signals."""
import argparse
import json
import re
import sys
from pathlib import Path

CONTAMINATION_PATTERNS = [
    r'WebVoyager',
    r'MinorJerry',
    r'WebVoyager_data\.jsonl',
    r'webvoyager.*answer',
    r'web.?voyager.*solution',
]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='in_dir', required=True, type=Path)
    args = ap.parse_args()
    hits: list[tuple[str, str, str]] = []  # (file, pattern, snippet)
    for path in sorted(args.in_dir.glob('*.stream.jsonl')):
        for ln, line in enumerate(path.open()):
            for pat in CONTAMINATION_PATTERNS:
                m = re.search(pat, line, re.IGNORECASE)
                if m:
                    hits.append((path.name, pat, line[:200].strip()))
    if hits:
        print(f"CONTAMINATION DETECTED — {len(hits)} hit(s):", file=sys.stderr)
        for f, p, s in hits[:20]:
            print(f"  {f}: pattern={p!r}: {s}", file=sys.stderr)
        return 2
    print("No contamination signals detected.")
    return 0

if __name__ == '__main__':
    sys.exit(main())
