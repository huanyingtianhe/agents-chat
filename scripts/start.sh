#!/usr/bin/env bash
# Linux launcher for Agents-Chat. Designed to run under systemd or directly.
#
# Usage:
#   ./start.sh                    # public mode: build + run on $PORT (default 3010)
#   ./start.sh --cloudflare       # also start a Cloudflare quick tunnel
#   ./start.sh --no-build         # skip the build step (faster restarts)
#   PORT=3010 ./start.sh          # override port
#
# Env vars consumed (all optional, override via systemd EnvironmentFile or shell):
#   LOG_LEVEL  LOG_DIR  LOG_FILE  LOG_ROTATE_FREQUENCY  LOG_ROTATE_SIZE  LOG_RETENTION
#   PORT
#
# Notes:
#   - Streams Next.js stdout/stderr to "$LOG_DIR/server.log" and "$LOG_DIR/server-error.log".
#   - Structured app logs (pino + pino-roll) go to "$LOG_DIR/app.<date>.<n>.log" automatically.
#   - --cloudflare requires the `cloudflared` binary on PATH. Tunnel logs go to
#     "$LOG_DIR/cloudflared.log". The tunnel is killed automatically when the
#     server process exits.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

NO_BUILD=0
USE_CLOUDFLARE=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --cloudflare) USE_CLOUDFLARE=1 ;;
    -h|--help)
      sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── Logging defaults (matching start.ps1) ──────────────────────────────────────
: "${LOG_LEVEL:=info}"
: "${LOG_DIR:=$PROJECT_DIR/logs}"
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
  echo "[$PROJECT_DIR] Cleaning .next cache..."
  rm -rf .next
  echo "[$PROJECT_DIR] Building..."
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

# ── Optional Cloudflare quick tunnel ───────────────────────────────────────────
CLOUDFLARED_PID=""
cleanup() {
  if [[ -n "$CLOUDFLARED_PID" ]] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    echo "Stopping cloudflared (PID $CLOUDFLARED_PID)..."
    kill -TERM "$CLOUDFLARED_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [[ "$USE_CLOUDFLARE" -eq 1 ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared not found on PATH. Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
    exit 1
  fi
  TUNNEL_LOG="$LOG_DIR/cloudflared.log"
  : > "$TUNNEL_LOG"
  echo "Starting Cloudflare tunnel -> http://localhost:$PORT (log: $TUNNEL_LOG)"
  cloudflared tunnel --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
  CLOUDFLARED_PID=$!

  TUNNEL_URL=""
  for _ in $(seq 1 30); do
    sleep 1
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -n1 || true)"
    if [[ -n "$TUNNEL_URL" ]]; then break; fi
  done
  if [[ -z "$TUNNEL_URL" ]]; then
    echo "Failed to get Cloudflare tunnel URL (see $TUNNEL_LOG)" >&2
    exit 1
  fi
  echo "Tunnel: $TUNNEL_URL"
fi

# ── Launch Next.js. Stdout/stderr mirrored to server.log/server-error.log via
#    tee so we keep a file copy regardless of journald. We can't `exec` because
#    the cleanup trap needs to fire after npm exits (to stop cloudflared).
SERVER_OUT="$LOG_DIR/server.log"
SERVER_ERR="$LOG_DIR/server-error.log"
echo "Starting Next.js server on :$PORT"
npm start -- --port "$PORT" \
  > >(tee -a "$SERVER_OUT") \
  2> >(tee -a "$SERVER_ERR" >&2)
