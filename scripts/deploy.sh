#!/usr/bin/env bash
# Install or update the guarded agents-chat systemd service.
#
# The safe-restart wrapper performs this deployment sequence under one lease:
# runtime-preflight.mjs acquire-lease
# npm ci
# runtime-preflight.mjs prepare
# npm run build
# systemctl restart
#
# Usage:
#   sudo ./scripts/deploy.sh
#   sudo ./scripts/deploy.sh --no-pull
#   sudo ./scripts/deploy.sh --no-install
#   sudo ./scripts/deploy.sh --wait 180

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$script_dir/safe-restart.sh" systemd --deploy "$@"
