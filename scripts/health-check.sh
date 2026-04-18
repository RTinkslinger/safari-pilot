#!/usr/bin/env bash
# scripts/health-check.sh — hourly health probe, run via LaunchAgent
set -eu

LOG="$HOME/.safari-pilot/health.log"
mkdir -p "$(dirname "$LOG")"

HEALTH_JSON=$(
  echo '{"id":"hc-1","method":"extension_health"}' | nc -w 3 localhost 19474 || echo '{"error":"daemon_unreachable"}'
)

# Probe HTTP:19475 (extension IPC server, Hummingbird).
# 204 = healthy (no pending commands), 200 = commands waiting, anything else = unhealthy.
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:19475/poll 2>/dev/null || echo "000")

ROUNDTRIP=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('roundtripCount1h',0))" 2>/dev/null || echo "0")
TIMEOUT=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('timeoutCount1h',0))" 2>/dev/null || echo "0")
UNCERTAIN=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('uncertainCount1h',0))" 2>/dev/null || echo "0")
FORCE_RELOAD=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('forceReloadCount24h',0))" 2>/dev/null || echo "0")

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rt=$ROUNDTRIP to=$TIMEOUT un=$UNCERTAIN fr=$FORCE_RELOAD http=$HTTP_STATUS" >> "$LOG"

BREACH=""
if [[ "$TIMEOUT" -gt 10 ]]; then BREACH="$BREACH high-timeouts"; fi
if [[ "$UNCERTAIN" -gt 3 ]]; then BREACH="$BREACH uncertain-results"; fi
if [[ "$FORCE_RELOAD" -gt 5 ]]; then BREACH="$BREACH repeated-force-reload"; fi
if [[ "$HTTP_STATUS" != "204" && "$HTTP_STATUS" != "200" ]]; then BREACH="$BREACH http-server-down($HTTP_STATUS)"; fi

if [[ -n "$BREACH" ]]; then
  osascript -e "display notification \"Degraded:$BREACH\" with title \"Safari Pilot\" sound name \"Tink\""
fi
