#!/usr/bin/env bash
# Playwright-MCP variant of run-one-task.sh — drives a `claude -p` agent
# against the same probe-tasks.jsonl using ONLY Playwright MCP. Used for
# the SOTA-baseline comparison: same prompt shape (tool-neutral), same
# judge, same score.json schema → numbers comparable to Safari Pilot's
# probe output.
#
# Usage: bash run-one-task-playwright.sh <task-id> [output-dir]
# Env:
#   WV_OUT_DIR    — override default output dir (default: /tmp/wv-pw-runs)
#   WV_VARIANT    — variant tag stamped into score.json (default: playwright-mcp)
#   WV_DATASET    — task dataset (default: bench/webvoyager/data/data/WebVoyager_data.jsonl)
#   WV_AUTH       — "max" or "apikey"; default apikey (uses --bare)
#   MAX_WALL_MS   — advisory budget (default 1200000)
#   MAX_TURNS     — advisory turn cap (default 25)
set -euo pipefail

TASK_ID="${1:?usage: $0 <task-id> [output-dir]}"
OUT_DIR="${2:-${WV_OUT_DIR:-/tmp/wv-pw-runs}}"
VARIANT_TAG="${WV_VARIANT:-playwright-mcp}"
RUN_SEQ="${WV_RUN_SEQ:-1}"
mkdir -p "$OUT_DIR"

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
DATASET="${WV_DATASET:-$REPO_ROOT/bench/webvoyager/data/data/WebVoyager_data.jsonl}"
[ -f "$DATASET" ] || { echo "dataset not found: $DATASET" >&2; exit 2; }

SAFE_ID="${TASK_ID//[^A-Za-z0-9_-]/_}"
# Screenshots go under /tmp/wv-PW-* to disambiguate from Safari Pilot's /tmp/wv-AGENT-*.
SCREENSHOT="/tmp/wv-PW-${SAFE_ID}-r${RUN_SEQ}.png"
SCORE_FILE="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.score.json"
TRANSCRIPT="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.transcript.txt"
STREAM_JSONL="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.stream.jsonl"
PRETTY_LOG="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.pretty.log"
MCP_CONFIG="$OUT_DIR/.mcp-playwright.json"

rm -f "$SCREENSHOT" 2>/dev/null || true

# Extract task fields from $DATASET.
URL=$(python3 - "$DATASET" "$TASK_ID" <<'PYEOF'
import json,sys
ds,tid=sys.argv[1],sys.argv[2]
for l in open(ds):
    try: t=json.loads(l)
    except: continue
    if t.get('id')==tid:
        print(t['web']); break
PYEOF
)
QUES=$(python3 - "$DATASET" "$TASK_ID" <<'PYEOF'
import json,sys
ds,tid=sys.argv[1],sys.argv[2]
for l in open(ds):
    try: t=json.loads(l)
    except: continue
    if t.get('id')==tid:
        print(t['ques']); break
PYEOF
)

if [ -z "$URL" ] || [ -z "$QUES" ]; then
  echo "ERROR: task $TASK_ID not found in dataset" >&2
  exit 1
fi

# Write a Playwright-only MCP config alongside the run output. Isolated per
# probe directory so concurrent runs of different baselines don't collide.
cat > "$MCP_CONFIG" <<EOF
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
EOF

# Bare-prompt mode (WV_BARE_PROMPT=1) uses the symmetric 3-line scaffold so
# PW and SP are compared on identical prompting. Default keeps the heavier
# prompt-template-playwright.md for backward compatibility.
TEMPLATE_NAME="prompt-template-playwright.md"
if [ "${WV_BARE_PROMPT:-0}" = "1" ]; then
  TEMPLATE_NAME="prompt-template-bare.md"
fi
PROMPT_FILE=$(mktemp /tmp/wv-pw-prompt.XXXXXX)
PROMPT_TEMPLATE=$(cat "$REPO_ROOT/bench/webvoyager/$TEMPLATE_NAME")
PROMPT="${PROMPT_TEMPLATE//\{url\}/$URL}"
PROMPT="${PROMPT//\{question\}/$QUES}"
PROMPT="${PROMPT//\{screenshot\}/$SCREENSHOT}"
printf '%s' "$PROMPT" > "$PROMPT_FILE"

if [ "${WV_DRY_RUN:-0}" = "1" ]; then
  echo "WV_DRY_RUN_RESOLVED id=$TASK_ID url=$URL ques=$QUES"
  rm -f "$PROMPT_FILE"
  exit 0
fi

# Symmetric window-leak detection — PW should always show delta=0.
SAFARI_WIN_PRE=$(osascript -e 'tell application "Safari" to count of windows' 2>/dev/null || echo 0)

START_TS=$(date +%s)
echo "════════════════════════════════════════════════"
echo " WV-PLAYWRIGHT inline · $TASK_ID"
echo " URL:  $URL"
echo " QUES: $QUES"
echo " launched: $(date '+%H:%M:%S')"
echo " stream: $STREAM_JSONL"
echo " pretty: $PRETTY_LOG"
echo "════════════════════════════════════════════════"

cd "$REPO_ROOT"

set +e
CLAUDE_BARE_FLAG=""
if [ "${WV_AUTH:-apikey}" = "max" ]; then
  unset ANTHROPIC_API_KEY
else
  CLAUDE_BARE_FLAG="--bare"
fi
export MAX_TURNS="${MAX_TURNS:-25}"
export MAX_WALL_MS="${MAX_WALL_MS:-1200000}"

claude $CLAUDE_BARE_FLAG --dangerously-skip-permissions --mcp-config "$MCP_CONFIG" \
    -p "$(cat "$PROMPT_FILE")" --verbose --output-format stream-json \
    < /dev/null 2>&1 \
    | tee "$STREAM_JSONL" \
    | python3 "$REPO_ROOT/bench/webvoyager/stream-pretty.py" 2>&1 \
    | tee "$PRETTY_LOG"
EXIT=$?
set -e

rm -f "$PROMPT_FILE"

END_TS=$(date +%s)
WALL_MS=$(( (END_TS - START_TS) * 1000 ))

sleep 1
SAFARI_WIN_POST=$(osascript -e 'tell application "Safari" to count of windows' 2>/dev/null || echo 0)
WIN_DELTA=$(( SAFARI_WIN_POST - SAFARI_WIN_PRE ))

# Build score.json + transcript using the same Python block run-one-task.sh uses.
# Shape MUST match so judge-probe.ts (and any future analysis) treats it identically.
python3 - "$STREAM_JSONL" "$SCORE_FILE" "$TRANSCRIPT" "$TASK_ID" "$WALL_MS" "$EXIT" "$SCREENSHOT" "$VARIANT_TAG" "$RUN_SEQ" "$SAFARI_WIN_PRE" "$SAFARI_WIN_POST" "$WIN_DELTA" <<'PYEOF'
import json, os, sys
stream, score_path, trans_path, tid, wall, exit_code, shot, variant, run_seq, win_pre, win_post, win_delta = sys.argv[1:13]
final = ''
turns = 0
cost = 0.0
duration = 0
for line in open(stream):
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except: continue
    if d.get('type')=='result' and d.get('subtype')=='success':
        final = d.get('result','') or final
        turns = d.get('num_turns', turns) or turns
        cost  = d.get('total_cost_usd', cost) or cost
        duration = d.get('duration_ms', duration) or duration
    elif d.get('type')=='assistant':
        msg = d.get('message') or {}
        for block in (msg.get('content') or []):
            if isinstance(block, dict) and block.get('type')=='text':
                txt = block.get('text','') or ''
                if 'FINAL_ANSWER:' in txt or 'ABSTAIN:' in txt:
                    final = txt

# Verdict heuristic: SUCCESS pending judge if screenshot exists + final answer text.
# ABSTAIN if the agent self-reported. UNKNOWN if no screenshot.
win_delta_i = int(win_delta)
window_leaked = win_delta_i != 0
verdict = 'PENDING_JUDGE'
reason = ''
if 'ABSTAIN' in (final or '').upper():
    verdict = 'UNKNOWN'
    reason = 'agent self-abstained'
elif not os.path.exists(shot):
    verdict = 'UNKNOWN'
    reason = 'screenshot capture failed'
elif window_leaked and os.environ.get('WV_SKIP_WINDOW_LEAK', '0') != '1':
    verdict = 'UNKNOWN'
    reason = f'safari window leak: pre={win_pre} post={win_post} delta={win_delta_i}'

score = {
    'task_id': tid, 'variant': variant, 'verdict': verdict,
    'judge_reasoning': reason, 'agent_final_text': final,
    'run_seq': int(run_seq), 'wall_ms': int(wall),
    'agent_duration_ms': int(duration), 'turns': int(turns),
    'cost_usd': float(cost),
    'screenshot_path': shot if os.path.exists(shot) else None,
    'exit_code': int(exit_code),
    'safari_window_count_pre': int(win_pre),
    'safari_window_count_post': int(win_post),
    'safari_window_delta': win_delta_i,
    'window_leaked': window_leaked,
}
with open(score_path, 'w') as f:
    json.dump(score, f, indent=2)

# Transcript: every assistant.text block + every tool_use/tool_result.
with open(stream) as f, open(trans_path, 'w') as o:
    for line in f:
        try: d=json.loads(line)
        except: continue
        if d.get('type') in ('assistant','user'):
            msg = d.get('message') or {}
            for block in (msg.get('content') or []):
                t = block.get('type') if isinstance(block, dict) else None
                if t == 'text':
                    o.write(f"[{d['type']}.text]\n{block.get('text','')}\n\n")
                elif t == 'tool_use':
                    o.write(f"[tool_use {block.get('name','')}] {json.dumps(block.get('input',{}))}\n")
                elif t == 'tool_result':
                    content = block.get('content','')
                    if isinstance(content, list):
                        for b in content:
                            if isinstance(b, dict) and b.get('type')=='text':
                                o.write(f"[tool_result] {b.get('text','')[:500]}\n")
                    else:
                        o.write(f"[tool_result] {str(content)[:500]}\n")
PYEOF

echo "════════════════════════════════════════════════"
echo " DONE · wall=${WALL_MS}ms exit=$EXIT"
echo " score: $SCORE_FILE"
echo "════════════════════════════════════════════════"
