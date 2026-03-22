#!/usr/bin/env bash
# Build and restart the local Monsthera HTTP server with PID/log management.
set -euo pipefail
set -m

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
RUN_DIR="$REPO_DIR/.monsthera/run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"

HTTP_PORT="${MONSTHERA_HTTP_PORT:-${AGORA_HTTP_PORT:-3015}}"
DASHBOARD_PORT="${MONSTHERA_DASHBOARD_PORT:-${AGORA_DASHBOARD_PORT:-3141}}"
TRANSPORT="${MONSTHERA_TRANSPORT:-${AGORA_TRANSPORT:-http}}"
FOREGROUND=1

usage() {
  cat <<EOF
Usage: scripts/restart.sh [options] [-- <extra monsthera serve args>]

Options:
  --http-port <port>        HTTP MCP port (default: ${HTTP_PORT})
  --dashboard-port <port>   Dashboard port (default: ${DASHBOARD_PORT})
  --transport <mode>        stdio | http (default: ${TRANSPORT})
  --foreground              Run attached in the current terminal (default)
  --daemonize               Start in the background and write PID/log files
  --help                    Show this help

Examples:
  pnpm run server:restart
  bash scripts/restart.sh --http-port 4015 --dashboard-port 4141
  bash scripts/restart.sh --foreground -- --no-semantic
  bash scripts/restart.sh --daemonize
EOF
}

EXTRA_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --http-port)
      HTTP_PORT="$2"
      shift 2
      ;;
    --dashboard-port)
      DASHBOARD_PORT="$2"
      shift 2
      ;;
    --transport)
      TRANSPORT="$2"
      shift 2
      ;;
    --foreground)
      FOREGROUND=1
      shift
      ;;
    --daemonize)
      FOREGROUND=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

mkdir -p "$RUN_DIR"
cd "$REPO_DIR"

kill_pid_if_running() {
  local pid="$1"
  if [ -z "$pid" ]; then
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping PID $pid"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ! kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
      sleep 0.2
    done
    echo "Force stopping PID $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
}

kill_port_if_listening() {
  local port="$1"
  local pids
  pids="$(lsof -ti ":$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    for pid in $pids; do
      kill_pid_if_running "$pid"
    done
  fi
}

wait_for_port() {
  local port="$1"
  for _ in $(seq 1 30); do
    if lsof -ti ":$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

if [ -f "$PID_FILE" ]; then
  kill_pid_if_running "$(cat "$PID_FILE")"
  rm -f "$PID_FILE"
fi

kill_port_if_listening "$HTTP_PORT"
if [ "$TRANSPORT" = "http" ]; then
  kill_port_if_listening "$DASHBOARD_PORT"
fi

echo "Building Monsthera..."
pnpm build >/dev/null

CMD=(node dist/index.js serve --repo-path "$REPO_DIR" --transport "$TRANSPORT")
if [ "$TRANSPORT" = "http" ]; then
  CMD+=(--http-port "$HTTP_PORT" --dashboard-port "$DASHBOARD_PORT")
fi
if [ "${#EXTRA_ARGS[@]}" -gt 0 ]; then
  CMD+=("${EXTRA_ARGS[@]}")
fi

echo "Starting: ${CMD[*]}"

if [ "$FOREGROUND" -eq 1 ]; then
  exec "${CMD[@]}"
fi

: > "$LOG_FILE"
nohup "${CMD[@]}" </dev/null >>"$LOG_FILE" 2>&1 &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "$SERVER_PID" > "$PID_FILE"

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "Server exited immediately. Check $LOG_FILE"
  exit 1
fi

if [ "$TRANSPORT" = "http" ]; then
  if ! wait_for_port "$HTTP_PORT"; then
    echo "HTTP port $HTTP_PORT did not come up. Check $LOG_FILE"
    exit 1
  fi
  if ! wait_for_port "$DASHBOARD_PORT"; then
    echo "Dashboard port $DASHBOARD_PORT did not come up. Check $LOG_FILE"
    exit 1
  fi
  echo "MCP: http://localhost:$HTTP_PORT/mcp"
  echo "Dashboard: http://localhost:$DASHBOARD_PORT"
else
  echo "Monsthera running in stdio mode (PID $SERVER_PID). Log: $LOG_FILE"
fi

echo "PID: $SERVER_PID"
echo "Log: $LOG_FILE"
