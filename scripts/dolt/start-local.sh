#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOCAL_DOLT_BIN="$ROOT_DIR/.monsthera/bin/dolt"
RUN_DIR="$ROOT_DIR/.monsthera/run"
DATA_DIR="${MONSTHERA_DOLT_DATA_DIR:-$ROOT_DIR/.monsthera/dolt}"
DB_NAME="${MONSTHERA_DOLT_DATABASE:-monsthera}"
DB_DIR="$DATA_DIR/$DB_NAME"
HOST="${MONSTHERA_DOLT_HOST:-127.0.0.1}"
PORT="${MONSTHERA_DOLT_PORT:-3306}"
LOG_LEVEL="${MONSTHERA_DOLT_LOG_LEVEL:-info}"
PID_FILE="$RUN_DIR/dolt.pid"
LOG_FILE="$RUN_DIR/dolt.log"

if [[ -x "${DOLT_BIN:-}" ]]; then
  DOLT_BIN="${DOLT_BIN}"
elif [[ -x "$LOCAL_DOLT_BIN" ]]; then
  DOLT_BIN="$LOCAL_DOLT_BIN"
elif command -v dolt >/dev/null 2>&1; then
  DOLT_BIN="$(command -v dolt)"
else
  echo "Dolt binary not found. Run 'pnpm dolt:install' first or set DOLT_BIN." >&2
  exit 1
fi

mkdir -p "$DB_DIR" "$RUN_DIR"

if [[ ! -d "$DB_DIR/.dolt" ]]; then
  echo "Initializing Dolt database at $DB_DIR"
  (
    cd "$DB_DIR"
    "$DOLT_BIN" init --name "Monsthera Local" --email "monsthera@local.test" >/dev/null
  )
fi

if [[ "${1:-}" == "--daemon" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    EXISTING_PID="$(cat "$PID_FILE")"
    if kill -0 "$EXISTING_PID" 2>/dev/null; then
      echo "Dolt sql-server is already running (pid $EXISTING_PID)"
      exit 0
    fi
    rm -f "$PID_FILE"
  fi

  echo "Starting Dolt sql-server in daemon mode on ${HOST}:${PORT}"
  nohup "$DOLT_BIN" sql-server --data-dir "$DATA_DIR" -H "$HOST" -P "$PORT" -l "$LOG_LEVEL" \
    >>"$LOG_FILE" 2>&1 </dev/null &
  PID="$!"
  echo "$PID" > "$PID_FILE"
  sleep 1

  if kill -0 "$PID" 2>/dev/null; then
    echo "Dolt sql-server started (pid $PID)"
    echo "Database: $DB_NAME"
    echo "Log: $LOG_FILE"
    exit 0
  fi

  echo "Dolt sql-server failed to start. Check $LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi

echo "Starting Dolt sql-server on ${HOST}:${PORT}"
echo "Database: $DB_NAME"
echo "Data dir: $DATA_DIR"
exec "$DOLT_BIN" sql-server --data-dir "$DATA_DIR" -H "$HOST" -P "$PORT" -l "$LOG_LEVEL"
