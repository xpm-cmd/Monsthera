#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="$ROOT_DIR/.monsthera/run/dolt.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No Dolt pid file found at $PID_FILE"
  exit 0
fi

PID="$(cat "$PID_FILE")"

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "Stopped Dolt sql-server (pid $PID)"
else
  echo "Stale Dolt pid file found for pid $PID"
fi

rm -f "$PID_FILE"
