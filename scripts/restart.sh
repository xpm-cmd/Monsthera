#!/usr/bin/env bash
# Rebuild and restart agora serve (kills any running agora dashboard)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_PORT="${1:-3141}"

cd "$REPO_DIR"

# Kill any existing agora dashboard on the target port
PID=$(lsof -ti ":$DASHBOARD_PORT" 2>/dev/null || true)
if [ -n "$PID" ]; then
  echo "Killing existing process on port $DASHBOARD_PORT (PID: $PID)"
  kill "$PID" 2>/dev/null || true
  sleep 0.5
fi

# Rebuild
echo "Building..."
pnpm build --silent

echo "Restarted. Dashboard: http://localhost:$DASHBOARD_PORT"

# Pass remaining args to agora serve
shift 2>/dev/null || true
exec agora serve --dashboard-port "$DASHBOARD_PORT" "$@"
