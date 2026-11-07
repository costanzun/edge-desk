#!/usr/bin/env bash
# Live market-data recorder: public endpoints only, no account, no keys.
#   scripts/recorder.sh start    run in the background under `caffeinate -i` (auto-restarts on crash)
#   scripts/recorder.sh stop
#   scripts/recorder.sh status
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"; mkdir -p "$LOGS"
SUP="$LOGS/recorder.supervisor.pid"

running() { [ -f "$SUP" ] && kill -0 "$(cat "$SUP")" 2>/dev/null; }

case "${1:-status}" in
  start)
    if running; then echo "recorder already running (supervisor pid $(cat "$SUP"))"; exit 0; fi
    nohup caffeinate -i bash -c "
      cd '$ROOT/backend'
      while true; do
        uv run python -m edgedesk.recorder >> '$LOGS/recorder.out' 2>&1 || true
        [ -f '$LOGS/recorder.stop' ] && break
        echo \"\$(date -u +%FT%TZ) recorder exited, restarting in 10s\" >> '$LOGS/recorder.out'
        sleep 10
      done" > /dev/null 2>&1 &
    echo $! > "$SUP"
    rm -f "$LOGS/recorder.stop"
    echo "recorder started (supervisor pid $!), logs in $LOGS/recorder.log"
    ;;
  stop)
    touch "$LOGS/recorder.stop"
    [ -f "$LOGS/recorder.pid" ] && kill "$(cat "$LOGS/recorder.pid")" 2>/dev/null || true
    sleep 2
    running && kill "$(cat "$SUP")" 2>/dev/null || true
    rm -f "$SUP"; echo "recorder stopped"
    ;;
  status)
    if running; then echo "running (supervisor $(cat "$SUP"), recorder $(cat "$LOGS/recorder.pid" 2>/dev/null))"; else echo "not running"; fi
    [ -f "$LOGS/recorder_status.json" ] && python3 -c "
import json,time;s=json.load(open('$LOGS/recorder_status.json'))
print(f\"last status {time.time()-s['t']:.0f}s ago, seq={s['seq']}, resolved={s['resolved']}, pending={s['pending']}\")
for k,v in s['health'].items(): print(f'  {k:11s} ok={v[\"ok\"]:<7} err={v[\"err\"]:<4} rtt={v.get(\"last_rtt_ms\")}ms')"
    ;;
esac
