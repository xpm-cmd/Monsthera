#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-4123}"
DOLT_HOST="${MONSTHERA_DOLT_HOST:-127.0.0.1}"
DOLT_PORT="${MONSTHERA_DOLT_PORT:-3306}"
DOLT_DB="${MONSTHERA_DOLT_DATABASE:-monsthera}"
WORK_DIR="$ROOT_DIR/knowledge/work-articles"
KNOWLEDGE_DIR="$ROOT_DIR/knowledge/notes"

count_markdown_files() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo 0
    return
  fi
  find "$dir" -type f -name '*.md' | wc -l | tr -d ' '
}

echo "==> Ensuring local Dolt is available"
if [[ ! -x "$ROOT_DIR/.monsthera/bin/dolt" ]]; then
  pnpm dolt:install
fi

echo "==> Starting Dolt daemon"
pnpm dolt:start:daemon

work_count="$(count_markdown_files "$WORK_DIR")"
knowledge_count="$(count_markdown_files "$KNOWLEDGE_DIR")"

if [[ "$work_count" == "0" && "$knowledge_count" == "0" ]]; then
  echo "==> No Markdown corpus found. Starting with empty knowledge base."
  echo "    To import from v2: pnpm exec tsx src/bin.ts migrate --mode execute --scope all --source .monsthera/monsthera.db"
fi

echo "==> Reindexing search"
MONSTHERA_DOLT_ENABLED=true \
MONSTHERA_DOLT_HOST="$DOLT_HOST" \
MONSTHERA_DOLT_PORT="$DOLT_PORT" \
MONSTHERA_DOLT_DATABASE="$DOLT_DB" \
pnpm exec tsx src/bin.ts reindex

echo "==> Launching dashboard on http://localhost:$PORT"
exec env \
  MONSTHERA_DOLT_ENABLED=true \
  MONSTHERA_DOLT_HOST="$DOLT_HOST" \
  MONSTHERA_DOLT_PORT="$DOLT_PORT" \
  MONSTHERA_DOLT_DATABASE="$DOLT_DB" \
  pnpm exec tsx src/bin.ts dashboard --port "$PORT"
