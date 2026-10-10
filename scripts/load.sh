#!/usr/bin/env bash
# Sobe a API com banco temporário, roda o k6 em Docker e confere as invariantes no banco.
set -euo pipefail

PORT="${PORT:-3106}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
DB_PATH="$TMP_DIR/load.sqlite"
export NODE_OPTIONS='--disable-warning=ExperimentalWarning'

cd "$ROOT"
PORT="$PORT" DB_PATH="$DB_PATH" npx tsx src/index.ts > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  curl -fs "http://localhost:$PORT/health" > /dev/null && break
  sleep 0.2
done
curl -fs "http://localhost:$PORT/health" > /dev/null || { echo "API não subiu"; cat "$TMP_DIR/server.log"; exit 1; }

docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e BASE_URL="http://host.docker.internal:$PORT" \
  grafana/k6:0.54.0 run - < load/review.js

npx tsx scripts/verify-load.ts "$DB_PATH"
