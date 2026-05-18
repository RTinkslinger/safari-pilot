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

# Derive REPO_ROOT from this script's own location so the bench picks up
# whichever working copy (main vs worktree) it's launched from. Pre-v0.1.36
# this was hardcoded to the main checkout — every probe launched from a
# worktree silently fell back to main's stale dist/, which masked Track A
# Fix 2 (the Math.max-floor removal in src/engines/extension.ts) for every
# bench run between 2026-05-15 and 2026-05-17. Caller can still pin
# REPO_ROOT explicitly via env var for tests or special-case routing.
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# Dataset source: honor $WV_DATASET if set (used by run-bench.sh --patched/--comparable
# to point children at patched-2026.jsonl / comparable-original.jsonl). Falls back to
# the canonical original WebVoyager dataset when unset.
DATASET="${WV_DATASET:-$REPO_ROOT/bench/webvoyager/data/data/WebVoyager_data.jsonl}"

SAFE_ID="${TASK_ID//[^A-Za-z0-9_-]/_}"
SCREENSHOT="/tmp/wv-AGENT-${SAFE_ID}-r${RUN_SEQ}.png"
SCORE_FILE="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.score.json"
TRANSCRIPT="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.transcript.txt"
STREAM_JSONL="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.stream.jsonl"
PRETTY_LOG="$OUT_DIR/${TASK_ID}-r${RUN_SEQ}.pretty.log"

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

# Build prompt by interpolating the template at bench/webvoyager/prompt-template.md
PROMPT_FILE=$(mktemp /tmp/wv-prompt.XXXXXX)
PROMPT_TEMPLATE=$(cat "$REPO_ROOT/bench/webvoyager/prompt-template.md")
PROMPT="${PROMPT_TEMPLATE//\{url\}/$URL}"
PROMPT="${PROMPT//\{question\}/$QUES}"
PROMPT="${PROMPT//\{screenshot\}/$SCREENSHOT}"
printf '%s' "$PROMPT" > "$PROMPT_FILE"

# Dry-run hook for harness tests: emit a structured marker with the resolved
# URL and QUES then exit 0 — does NOT invoke claude. Contract is exercised by
# test/unit/bench/test_wv_dataset_override.py.
if [ "${WV_DRY_RUN:-0}" = "1" ]; then
  echo "WV_DRY_RUN_RESOLVED id=$TASK_ID url=$URL ques=$QUES"
  rm -f "$PROMPT_FILE"
  exit 0
fi

START_TS=$(date +%s)
echo "════════════════════════════════════════════════"
echo " WV inline · $TASK_ID"
echo " URL:  $URL"
echo " QUES: $QUES"
echo " launched: $(date '+%H:%M:%S')"
echo " stream: $STREAM_JSONL"
echo " pretty: $PRETTY_LOG"
echo "════════════════════════════════════════════════"

# Fix C (2026-05-18) — Safari prewarm. The 2026-05-18 batch probe RCA
# §4 Factor 1 measured 73 "no front window" AppleScript errors at task
# start vs 5 in the matched envelope-only probe. The cleanup race
# (Fix D, below) was the primary cause; this prewarm is the
# belt-and-suspenders. `activate` is idempotent — if Safari already has
# a window, nothing happens; otherwise it brings up the start page so
# the agent's first `safari_new_tab` doesn't trip on -1719.
osascript -e 'tell application "Safari" to activate' 2>/dev/null || true

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
# Auth path selection.
#   WV_AUTH=max     -> Max subscription (cost_usd reported is theoretical;
#                      Max users pay flat-rate). No --bare so claude reads
#                      OAuth credentials from disk. ANTHROPIC_API_KEY is
#                      also unset for defense-in-depth.
#   WV_AUTH=apikey  -> API-key billed (legacy / emergency comparability
#                      with pre-v0.1.36 baselines). --bare forces the
#                      API-only code path; ANTHROPIC_API_KEY must be set
#                      in env.
# Default is apikey for backward compatibility, but every v0.1.36+ probe
# and the full 641-task re-baseline should run with WV_AUTH=max.
CLAUDE_BARE_FLAG=""
if [ "${WV_AUTH:-apikey}" = "max" ]; then
  unset ANTHROPIC_API_KEY
else
  CLAUDE_BARE_FLAG="--bare"
fi
# v0.1.36 — MAX_TURNS / MAX_WALL_MS are surfaced both as ENV vars for the
# in-process WallCapEnforcer (src/security/wall-cap.ts) AND copied into
# the agent's prompt template as advisory limits the agent should
# self-enforce. Pre-v0.1.36 the comment claimed LoopDetector enforced
# these — it never did; the variables were dead.
export MAX_TURNS="${MAX_TURNS:-25}"
export MAX_WALL_MS="${MAX_WALL_MS:-1200000}"
# Unquoted $CLAUDE_BARE_FLAG is intentional: empty -> no arg, "--bare" ->
# one arg. Neither value contains whitespace, so word-splitting is safe
# here and survives `set -u` (vs. `"${arr[@]}"` on an empty array, which
# trips it).
SAFARI_PILOT_NO_SESSION_WINDOW=1 \
  claude $CLAUDE_BARE_FLAG --dangerously-skip-permissions --mcp-config .mcp.json \
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

# Fix D (2026-05-18) — per-task cleanup, derived from THIS task's
# stream.jsonl. The previous "close anything not in pre-snapshot" approach
# was racy at concurrency=4: Task A's pre-snapshot didn't include
# concurrent Task B's mid-execution tabs, so A's cleanup would close B's
# tabs. The 2026-05-18 batch probe RCA Q-a documented 41 confirmed
# "confirmed-then-TAB_NOT_FOUND" events across 21 distinct tasks caused
# by this race.
#
# New cleanup: derive-task-tabs.py parses stream.jsonl for successful
# safari_new_tab + safari_navigate response payloads → emits the set of
# URLs THIS agent actually opened/visited. Cleanup closes any tab whose
# CURRENT URL is in that set AND is NOT in the pre-snapshot (so sibling
# tasks' tabs and user tabs are untouched).
TASK_URLS_FILE=$(mktemp /tmp/wv-task-urls.XXXXXX)
python3 "$REPO_ROOT/bench/webvoyager/derive-task-tabs.py" "$STREAM_JSONL" \
  > "$TASK_URLS_FILE" 2>/dev/null || true

CLEANUP_SCRIPT=$(mktemp /tmp/wv-cleanup.XXXXXX)
{
  echo 'tell application "Safari"'
  echo '  set snapshotUrls to {}'
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    safe=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g')
    echo "  set end of snapshotUrls to \"$safe\""
  done < "$SNAPSHOT_FILE"
  echo '  set taskUrls to {}'
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    safe=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g')
    echo "  set end of taskUrls to \"$safe\""
  done < "$TASK_URLS_FILE"
  echo '  repeat with w in (every window)'
  echo '    set tCount to count of tabs of w'
  echo '    repeat with i from tCount to 1 by -1'
  echo '      try'
  echo '        set t to tab i of w'
  echo '        set tUrl to URL of t'
  echo '        if (taskUrls contains tUrl) and (snapshotUrls does not contain tUrl) then close t'
  echo '      end try'
  echo '    end repeat'
  echo '  end repeat'
  echo 'end tell'
} > "$CLEANUP_SCRIPT"
CLEANED=$(perl -e 'alarm 8; exec @ARGV' osascript "$CLEANUP_SCRIPT" 2>&1; echo $?)
rm -f "$CLEANUP_SCRIPT" "$SNAPSHOT_FILE" "$TASK_URLS_FILE"

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
