#!/usr/bin/env bash
# Manual launcher for Agents-Chat. Useful for dev / ad-hoc public demos.
# Under systemd, the unit invokes `npm start` directly; this script is not in
# the hot path there.
#
# Usage:
#   ./scripts/start.sh                  # build (if needed) + npm start
#   ./scripts/start.sh --no-build       # skip the build step
#   ./scripts/start.sh --cloudflare     # also start a Cloudflare quick tunnel
#   PORT=8080 ./scripts/start.sh        # override port (default 3010)
#
# Env vars (PORT, LOG_*, NEXTAUTH_*) are picked up from .env.local by Next.js
# itself — this script does not export defaults for them.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

build=1
cloudflare=0
for arg in "$@"; do
  case "$arg" in
    --no-build)   build=0 ;;
    --cloudflare) cloudflare=1 ;;
    -h|--help)
      grep -E '^# ' "$0" | sed -E 's/^# ?//'
      exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

port="${PORT:-3010}"

if (( build )); then
  echo "→ npm run build"
  npm run build
fi

if (( cloudflare )); then
  command -v cloudflared >/dev/null || {
    echo "cloudflared not on PATH. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
    exit 1
  }
  tunnel_log="$(mktemp)"
  cloudflared tunnel --url "http://localhost:$port" >"$tunnel_log" 2>&1 &
  tunnel_pid=$!
  trap 'kill -TERM "$tunnel_pid" 2>/dev/null || true; rm -f "$tunnel_log"' EXIT INT TERM

  echo "→ waiting for Cloudflare tunnel URL…"
  for _ in $(seq 1 30); do
    sleep 1
    url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" | head -n1 || true)
    [[ -n "$url" ]] && { echo "→ tunnel: $url"; break; }
  done
  [[ -z "${url:-}" ]] && { echo "Failed to detect tunnel URL. Log:"; cat "$tunnel_log"; exit 1; }
fi

echo "→ npm start (port $port)"
exec npm start -- --port "$port"
