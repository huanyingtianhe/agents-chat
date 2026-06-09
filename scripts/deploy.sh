#!/usr/bin/env bash
# One-shot updater for the agents-chat systemd service.
#
# Usage:
#   sudo ./scripts/deploy.sh                 # pull + install + build + restart
#   sudo ./scripts/deploy.sh --no-pull       # skip git pull
#   sudo ./scripts/deploy.sh --no-install    # skip npm ci
#   sudo ./scripts/deploy.sh --wait 0        # don't wait for health check (default 120s)
#
# Requires install-systemd-service.sh to have been run once.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
project_dir="$PWD"
service=agents-chat

pull=1
install=1
wait_secs=120
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-pull)    pull=0;       shift ;;
    --no-install) install=0;    shift ;;
    --wait)       wait_secs=$2; shift 2 ;;
    -h|--help)    grep -E '^# ' "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

(( EUID == 0 )) || { echo "Run with sudo (need systemctl access)." >&2; exit 1; }

systemctl list-unit-files "${service}.service" --no-legend | grep -q . || {
  echo "Service '$service' not installed. Run: sudo ./scripts/install-systemd-service.sh" >&2
  exit 1
}

# Run npm/git as the service user so file ownership stays consistent.
user=$(systemctl show -p User --value "$service")
[[ -z "$user" ]] && user="${SUDO_USER:-root}"

as_user() {
  if [[ "$user" == "root" ]]; then
    bash -c "$*"
  else
    sudo -u "$user" -H bash -c "$*"
  fi
}

(( pull ))    && { echo "→ git pull";       as_user "git pull --ff-only"; }
(( install )) && { echo "→ npm ci";         as_user "npm ci --no-audit --no-fund"; }
                  echo "→ npm run build";   as_user "npm run build"

echo "→ systemctl restart $service"
systemctl restart "$service"

if (( wait_secs > 0 )); then
  # Pull PORT from .env.local if present, else fall back to start.sh's default.
  port=3010
  if [[ -f .env.local ]]; then
    v=$(awk -F= '/^[[:space:]]*PORT[[:space:]]*=/ {gsub(/[ \t"'\'']/, "", $2); print $2}' .env.local | tail -n1)
    [[ -n "$v" ]] && port="$v"
  fi
  url="http://localhost:${port}/api/auth/providers"

  echo "→ waiting up to ${wait_secs}s for $url"
  deadline=$(( $(date +%s) + wait_secs ))
  while (( $(date +%s) < deadline )); do
    if curl -sf -o /dev/null --max-time 3 "$url"; then
      echo "✓ service healthy"
      exit 0
    fi
    sleep 2
  done
  echo "✗ service did not respond in ${wait_secs}s. Recent logs:" >&2
  journalctl -u "$service" -n 40 --no-pager >&2 || true
  exit 1
fi

systemctl --no-pager status "$service" | head -n 5
