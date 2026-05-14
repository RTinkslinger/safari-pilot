#!/usr/bin/env bash
# Inline single-task WebVoyager runner with --bare + verbose stream-json.
# Usage: bash bench/webvoyager/run-one-task.sh <task-id> [<output-dir>]
# Env:
#   WV_OUT_DIR    — override default output dir (default: /tmp/wv-inline-runs)
#   WV_VARIANT    — variant tag stamped into score.json (default: v0.1.33-inline-bare)
set -euo pipefail

TASK_ID="${1:?usage: $0 <task-id> [output-dir]}"
OUT_DIR="${2:-${WV_OUT_DIR:-/tmp/wv-inline-runs}}"
VARIANT_TAG="${WV_VARIANT:-v0.1.33-inline-bare}"
RUN_SEQ="${WV_RUN_SEQ:-1}"
mkdir -p "$OUT_DIR"

REPO_ROOT="/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
DATASET="$REPO_ROOT/bench/webvoyager/data/data/WebVoyager_data.jsonl"

SAFE_ID="${TASK_ID//[^A-Za-z0-9_-]/_}"
SCREENSHOT="/tmp/wv-AGENT-${SAFE_ID}-r${RUN_SEQ}.png"
SCORE_FILE="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.score.json"
TRANSCRIPT="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.transcript.txt"
STREAM_JSONL="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.stream.jsonl"
PRETTY_LOG="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.pretty.log"

rm -f "$SCREENSHOT" 2>/dev/null || true

# Extract task fields using a dedicated python helper
read -r URL QUES < <(python3 - "$DATASET" "$TASK_ID" <<'PYEOF'
import json, sys
ds, tid = sys.argv[1], sys.argv[2]
for line in open(ds):
    try: t = json.loads(line)
    except: continue
    if t.get('id') == tid:
        print(t['web'])
        print(t['ques'])
        break
PYEOF
)
# python emits two lines: URL on line 1, QUES on line 2 — split:
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

# Build prompt via printf
PROMPT_FILE=$(mktemp /tmp/wv-prompt.XXXXXX)
printf 'You are an autonomous browser agent driven by the safari-pilot MCP plugin.\n\nTask: %s\nStarting URL: %s\n\nSteps:\n1. Open a new tab to the starting URL using safari_new_tab. Remember the URL of the tab you opened (you'\''ll need it in step 5).\n2. Use safari_snapshot to orient on the page.\n3. Use safari_tool_search if you need a capability not in your default tool list.\n4. Solve the task. Use the simplest tool sequence that works.\n5. CRITICAL — REQUIRED EVIDENCE STEP. Before answering, call safari_take_screenshot with arguments:\n     { "tabUrl": "<the URL currently in your tab>", "path": "%s" }\n   The eval judge needs this screenshot to verify your answer. If you skip this step, the task will be marked UNKNOWN regardless of how good your textual answer is — wasting the entire run. Take the screenshot AFTER your final navigation and BEFORE giving the final answer.\n6. End your response with: "FINAL_ANSWER: <your concise answer>"\n\nDo not ask for clarification — make your best attempt and answer.\nDo not switch user-owned tabs. Operate only on tabs you opened.\nDo NOT call safari_close_tab or safari_close_window. Do NOT navigate away from your final answer page after taking the screenshot. The harness cleans up tabs.\n' \
  "$QUES" "$URL" "$SCREENSHOT" > "$PROMPT_FILE"

START_TS=$(date +%s)
echo "════════════════════════════════════════════════"
echo " WV inline · $TASK_ID"
echo " URL:  $URL"
echo " QUES: $QUES"
echo " launched: $(date '+%H:%M:%S')"
echo " stream: $STREAM_JSONL"
echo " pretty: $PRETTY_LOG"
echo "════════════════════════════════════════════════"

# Snapshot existing tab URLs BEFORE agent runs (so we know what NOT to close)
SNAPSHOT_FILE=$(mktemp /tmp/wv-snapshot.XXXXXX)
osascript -e 'tell application "Safari"
  set urls to ""
  repeat with w in (every window)
    repeat with t in (tabs of w)
      set urls to urls & (URL of t) & "
"
    end repeat
  end repeat
  return urls
end tell' 2>/dev/null > "$SNAPSHOT_FILE"

cd "$REPO_ROOT"

set +e
# Auth path selection. By default uses ANTHROPIC_API_KEY (pay-per-use). To use
# the Claude.ai Max subscription instead, the user must first run
# `claude /login` interactively to persist auth credentials accessible to
# subshell invocations. Set WV_AUTH=max to drop ANTHROPIC_API_KEY from the
# subshell so the persisted Max credentials are used. Default WV_AUTH=apikey
# preserves prior behavior.
if [ "${WV_AUTH:-apikey}" = "max" ]; then
  unset ANTHROPIC_API_KEY
fi
# v0.1.35 Task 5 — hard caps surfaced to the agent harness as env vars.
# Default: 25 turns, 20 min wall-clock. Overridable upstream by the bench
# wrapper. These are advisory env vars; the in-process LoopDetector +
# ThrashDetector in src/security/loop-detector.ts is the enforcement.
export MAX_TURNS="${MAX_TURNS:-25}"
export MAX_WALL_MS="${MAX_WALL_MS:-1200000}"
SAFARI_PILOT_NO_SESSION_WINDOW=1 \
  claude --bare --dangerously-skip-permissions --mcp-config .mcp.json \
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

# Cleanup: close any tab whose URL is NOT in the pre-snapshot.
# Mirrors bench/webvoyager/mcp-direct.ts cleanupNewTabs() pattern.
CLEANUP_SCRIPT=$(mktemp /tmp/wv-cleanup.XXXXXX)
{
  echo 'tell application "Safari"'
  echo '  set snapshotUrls to {}'
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    safe=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g')
    echo "  set end of snapshotUrls to \"$safe\""
  done < "$SNAPSHOT_FILE"
  echo '  repeat with w in (every window)'
  echo '    set tCount to count of tabs of w'
  echo '    repeat with i from tCount to 1 by -1'
  echo '      try'
  echo '        set t to tab i of w'
  echo '        set tUrl to URL of t'
  echo '        if snapshotUrls does not contain tUrl then close t'
  echo '      end try'
  echo '    end repeat'
  echo '  end repeat'
  echo 'end tell'
} > "$CLEANUP_SCRIPT"
CLEANED=$(perl -e 'alarm 8; exec @ARGV' osascript "$CLEANUP_SCRIPT" 2>&1; echo $?)
rm -f "$CLEANUP_SCRIPT" "$SNAPSHOT_FILE"

# Build score.json + transcript
python3 - "$STREAM_JSONL" "$SCORE_FILE" "$TRANSCRIPT" "$TASK_ID" "$WALL_MS" "$EXIT" "$SCREENSHOT" "$VARIANT_TAG" "$RUN_SEQ" <<'PYEOF'
import json, os, sys
stream, score_path, trans_path, tid, wall, exit_code, shot, variant, run_seq = sys.argv[1:10]
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
        txt = d.get('result','')
        idx = txt.rfind('FINAL_ANSWER:')
        final = txt[idx+len('FINAL_ANSWER:'):].strip() if idx>=0 else txt[-500:].strip()
        turns = d.get('num_turns',0)
        cost = d.get('total_cost_usd',0)
        duration = d.get('duration_ms',0)
shot_present = os.path.exists(shot)
verdict = 'PENDING_JUDGE' if shot_present and final else 'UNKNOWN'
d = {
  'task_id': tid,
  'variant': variant,
  'verdict': verdict,
  'judge_reasoning': '' if shot_present else 'screenshot capture failed',
  'agent_final_text': final,
  'run_seq': int(run_seq),
  'wall_ms': int(wall),
  'agent_duration_ms': duration,
  'turns': turns,
  'cost_usd': cost,
  'screenshot_path': shot if shot_present else None,
  'exit_code': int(exit_code),
}
with open(score_path,'w') as f: json.dump(d,f,indent=2)
with open(trans_path,'w') as f:
  f.write(f"EXIT={exit_code}\nWALL_MS={wall}\nDURATION_MS={duration}\nTURNS={turns}\nCOST_USD={cost}\nFINAL_ANSWER={final}\nSCREENSHOT={shot} (present={shot_present})\n")
print(f"verdict={verdict} turns={turns} cost=${cost:.4f}")
PYEOF

echo ""
echo "════════════════════════════════════════════════"
echo " DONE · $TASK_ID · wall=${WALL_MS}ms · exit=$EXIT"
echo " score: $SCORE_FILE"
echo "════════════════════════════════════════════════"
