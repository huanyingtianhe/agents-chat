#!/usr/bin/env bash
# Linux launcher for Agents-Chat. Designed to run under systemd or directly.
#
# Usage:
#   ./start.sh                    # build (if needed) + run
#   ./start.sh --no-build         # skip the build step (faster restarts)
#   PORT=3010 ./start.sh          # override port (default 3010)
#
# Env vars consumed (all optional, override via systemd EnvironmentFile or shell):
#   LOG_LEVEL  LOG_DIR  LOG_FILE  LOG_ROTATE_FREQUENCY  LOG_ROTATE_SIZE  LOG_RETENTION
#   PORT
#
# Notes:
#   - Streams Next.js stdout/stderr to "$LOG_DIR/server.log" and "$LOG_DIR/server-error.log".
#   - Structured app logs (pino + pino-roll) go to "$LOG_DIR/app.<date>.<n>.log" automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    -h|--help)
      sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── Logging defaults (matching start.ps1) ──────────────────────────────────────
: "${LOG_LEVEL:=info}"
: "${LOG_DIR:=$SCRIPT_DIR/logs}"
: "${LOG_FILE:=app.log}"
: "${LOG_ROTATE_FREQUENCY:=daily}"
: "${LOG_ROTATE_SIZE:=10m}"
: "${LOG_RETENTION:=7}"
: "${PORT:=3010}"
export LOG_LEVEL LOG_DIR LOG_FILE LOG_ROTATE_FREQUENCY LOG_ROTATE_SIZE LOG_RETENTION PORT

mkdir -p "$LOG_DIR"
echo "Logs -> $LOG_DIR/$LOG_FILE (level=$LOG_LEVEL, rotate=$LOG_ROTATE_FREQUENCY/$LOG_ROTATE_SIZE, keep=$LOG_RETENTION)"

# ── Build (skip with --no-build) ───────────────────────────────────────────────
if [[ "$NO_BUILD" -eq 0 ]]; then
  echo "[$SCRIPT_DIR] Cleaning .next cache..."
  rm -rf .next
  echo "[$SCRIPT_DIR] Building..."
  npm run build
fi

# ── Kill any stale server on $PORT (best effort) ───────────────────────────────
if command -v lsof >/dev/null 2>&1; then
  STALE_PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$STALE_PIDS" ]]; then
    echo "Killing old server on port $PORT: $STALE_PIDS"
    kill -TERM $STALE_PIDS 2>/dev/null || true
    sleep 1
    kill -KILL $STALE_PIDS 2>/dev/null || true
  fi
fi

# ── Launch Next.js. Under systemd, exec replaces the shell so signals propagate.
#    Stdout/stderr are mirrored to server.log/server-error.log via tee so we keep
#    a file copy regardless of journald.
SERVER_OUT="$LOG_DIR/server.log"
SERVER_ERR="$LOG_DIR/server-error.log"
echo "Starting Next.js server on :$PORT"
exec npm start -- --port "$PORT" \
  > >(tee -a "$SERVER_OUT") \
  2> >(tee -a "$SERVER_ERR" >&2)
