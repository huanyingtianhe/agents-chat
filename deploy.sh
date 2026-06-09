#!/usr/bin/env bash
# One-shot updater for Agents-Chat on Linux (systemd).
#
# Usage:
#   sudo ./deploy.sh                      # git pull + npm ci + build + restart
#   sudo ./deploy.sh --skip-git-pull      # don't pull (e.g. you already pulled)
#   sudo ./deploy.sh --skip-install       # skip npm ci (no new deps)
#   sudo ./deploy.sh --wait 180           # wait up to N seconds for /api/auth/providers (default 120, 0 = no wait)
#
# Requires the service to be installed first via install-systemd-service.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVICE_NAME="agents-chat"
SKIP_GIT_PULL=0
SKIP_INSTALL=0
WAIT_SECONDS=120

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-git-pull) SKIP_GIT_PULL=1; shift ;;
    --skip-install)  SKIP_INSTALL=1;  shift ;;
    --wait)          WAIT_SECONDS="$2"; shift 2 ;;
    -h|--help)       sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root (use sudo) so systemctl can manage the $SERVICE_NAME service." >&2
  exit 1
fi

if ! systemctl list-unit-files "${SERVICE_NAME}.service" --no-legend | grep -q .; then
  echo "Service '${SERVICE_NAME}' not installed. Run: sudo ./install-systemd-service.sh" >&2
  exit 1
fi

# Discover the user the service runs as so git/npm aren't done as root.
SERVICE_USER="$(systemctl show -p User --value "$SERVICE_NAME")"
if [[ -z "$SERVICE_USER" || "$SERVICE_USER" == "root" ]]; then
  SERVICE_USER="${SUDO_USER:-root}"
fi

step() { echo -e "\033[36m[$(date '+%Y-%m-%d %H:%M:%S')] $*\033[0m"; }

run_as_service_user() {
  if [[ "$SERVICE_USER" == "root" ]]; then
    bash -c "cd '$SCRIPT_DIR' && $*"
  else
    sudo -u "$SERVICE_USER" -H bash -c "cd '$SCRIPT_DIR' && $*"
  fi
}

if [[ "$SKIP_GIT_PULL" -eq 0 ]]; then
  step "git pull"
  run_as_service_user "git pull --ff-only"
else
  step "Skipping git pull"
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  step "npm ci"
  run_as_service_user "npm ci --no-audit --no-fund"
else
  step "Skipping npm install"
fi

step "npm run build"
run_as_service_user "npm run build"

step "systemctl restart $SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

if [[ "$WAIT_SECONDS" -gt 0 ]]; then
  PORT="$(systemctl show -p Environment --value "$SERVICE_NAME" | tr ' ' '\n' | grep '^PORT=' | tail -n1 | cut -d= -f2)"
  PORT="${PORT:-3010}"
  HEALTH_URL="http://localhost:${PORT}/api/auth/providers"
  step "Waiting up to ${WAIT_SECONDS}s for $HEALTH_URL"
  DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
  while [[ $(date +%s) -lt $DEADLINE ]]; do
    if curl -sf -o /dev/null --max-time 3 "$HEALTH_URL"; then
      step "Service is responding."
      systemctl --no-pager status "$SERVICE_NAME" | head -n 5 || true
      exit 0
    fi
    sleep 2
  done
  echo "Service did not respond within ${WAIT_SECONDS}s. Recent logs:" >&2
  journalctl -u "$SERVICE_NAME" -n 40 --no-pager >&2 || true
  exit 1
fi

systemctl --no-pager status "$SERVICE_NAME" | head -n 5 || true
