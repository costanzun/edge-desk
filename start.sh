#!/usr/bin/env bash
# Edge Desk: one command to run the whole app locally (paper trading only).
#   ./start.sh            recorder (if not running) + API :8104 + UI :3104 (dev mode)
#   ./start.sh --prod     build the UI and serve it with `next start`
#   ./start.sh --demo     no recorder; the desk runs on the seeded synthetic market
#   ./start.sh --check    only verify prerequisites and exit
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_PORT="${API_PORT:-8104}"
WEB_PORT="${WEB_PORT:-3104}"
MODE="dev"; SOURCE="${EDGE_SOURCE:-live}"
for arg in "$@"; do
  case "$arg" in
    --prod) MODE="prod" ;;
    --demo) SOURCE="synthetic" ;;
    --check) MODE="check" ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
  esac
done

say()  { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;35m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v uv   >/dev/null || die "uv not found. Install: https://docs.astral.sh/uv/"
command -v pnpm >/dev/null || die "pnpm not found. Install: npm i -g pnpm"
command -v node >/dev/null || die "node not found (Node 20+ required)"
for p in "$API_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port $p is already in use. Stop that process or set API_PORT/WEB_PORT."
  fi
done
[ "$MODE" = "check" ] && { say "Prerequisites OK."; exit 0; }

say "Syncing backend (uv)…"
(cd "$ROOT/backend" && uv sync --quiet)
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  say "Installing frontend deps (pnpm)…"
  (cd "$ROOT/frontend" && pnpm install --frozen-lockfile --silent)
fi

if [ "$SOURCE" = "live" ]; then
  "$ROOT/scripts/recorder.sh" start   # public market data only; keeps running after Ctrl-C
else
  say "Demo mode: synthetic market (no network access needed)"
fi

PIDS=()
cleanup() { say "Stopping UI and API (the recorder keeps running: scripts/recorder.sh stop)…"
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

say "Starting API on http://127.0.0.1:$API_PORT (source: $SOURCE)"
(cd "$ROOT/backend" && EDGE_SOURCE="$SOURCE" exec uv run uvicorn edgedesk.api.main:app --host 127.0.0.1 --port "$API_PORT") &
PIDS+=($!)

export NEXT_PUBLIC_API_URL="http://localhost:$API_PORT"
if [ "$MODE" = "prod" ]; then
  say "Building UI…"; (cd "$ROOT/frontend" && pnpm build)
  (cd "$ROOT/frontend" && exec pnpm exec next start -p "$WEB_PORT") &
else
  (cd "$ROOT/frontend" && exec pnpm exec next dev -p "$WEB_PORT") &
fi
PIDS+=($!)

for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
printf '\n  \033[1mEdge Desk\033[0m → http://localhost:%s   (API docs: http://127.0.0.1:%s/docs)\n  Paper trading only. Ctrl-C stops UI and API.\n\n' "$WEB_PORT" "$API_PORT"
wait
