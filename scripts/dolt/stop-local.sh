#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_FILE="$ROOT_DIR/.monsthera/run/dolt.pid"
METADATA_FILE="$ROOT_DIR/.monsthera/run/dolt.json"

PID=""
SOURCE=""
EXPECTED=""

if [[ -f "$METADATA_FILE" ]]; then
  PID="$(node -e "try{const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if (Number.isInteger(x.pid)) console.log(x.pid)}catch{}" "$METADATA_FILE")"
  EXPECTED="$(node -e "try{const fs=require('fs');const x=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); if (Array.isArray(x.command) && x.command[0]) console.log(require('path').basename(x.command[0]))}catch{}" "$METADATA_FILE")"
  SOURCE="$METADATA_FILE"
elif [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  SOURCE="$PID_FILE"
else
  echo "No Dolt pid file found at $METADATA_FILE or $PID_FILE"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  if [[ -n "$EXPECTED" ]]; then
    COMMAND="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    if [[ "$COMMAND" != *"$EXPECTED"* ]]; then
      echo "Refusing to stop pid $PID: command does not match metadata from $SOURCE" >&2
      exit 1
    fi
  elif [[ "$SOURCE" == "$PID_FILE" ]]; then
    COMMAND="$(ps -p "$PID" -o command= 2>/dev/null || true)"
    if [[ "$COMMAND" != *"dolt"* || "$COMMAND" != *"sql-server"* ]]; then
      echo "Refusing to stop legacy pid $PID: command does not look like Dolt sql-server" >&2
      exit 1
    fi
    echo "Stopping legacy Dolt pid file after command validation"
  fi
  kill "$PID"
  echo "Stopped Dolt sql-server (pid $PID)"
else
  echo "Stale Dolt pid file found for pid $PID"
fi

rm -f "$PID_FILE" "$METADATA_FILE"
