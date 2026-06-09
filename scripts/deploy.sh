#!/usr/bin/env bash
# Install / update the agents-chat systemd service.
#
# Whoever runs this script is the user the service runs as. With sudo,
# that means root — git pull, npm ci, npm run build, and the service
# itself all run as root.
#
# First run on a machine:
#   sudo ./scripts/deploy.sh                # installs the unit, builds, starts
#
# Subsequent runs (idempotent):
#   sudo ./scripts/deploy.sh                # pull + npm ci + build + restart
#   sudo ./scripts/deploy.sh --no-pull      # skip git pull
#   sudo ./scripts/deploy.sh --no-install   # skip npm ci
#   sudo ./scripts/deploy.sh --wait 0       # don't wait for health check (default 120s)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
cd "$project_dir"

service=agents-chat
unit_src="$script_dir/agents-chat.service"
unit_dest="/etc/systemd/system/agents-chat.service"

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
[[ -f "$unit_src" ]] || { echo "Missing unit template: $unit_src" >&2; exit 1; }

command -v npm >/dev/null 2>&1 || {
  echo "npm not found in root's PATH." >&2
  echo "If you installed Node via nvm, the service won't find it either." >&2
  echo "Install Node system-wide:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -" >&2
  echo "  sudo apt install -y nodejs" >&2
  exit 1
}

user="$(id -un)"
group="$(id -gn)"
npm_bin="$(command -v npm)"

# ── Render unit (always — picks up template changes on every deploy) ──────────
first_install=0
[[ -f "$unit_dest" ]] || first_install=1

if (( first_install )); then
  echo "→ installing $service.service (user=$user)"
else
  echo "→ refreshing $service.service"
fi

rendered=$(sed \
  -e "s|__USER__|$user|g" \
  -e "s|__GROUP__|$group|g" \
  -e "s|__PROJECT_DIR__|$project_dir|g" \
  -e "s|__SCRIPT_DIR__|$script_dir|g" \
  -e "s|__NPM__|$npm_bin|g" \
  "$unit_src")

if [[ ! -f "$unit_dest" ]] || ! diff -q <(echo "$rendered") "$unit_dest" >/dev/null 2>&1; then
  echo "$rendered" > "$unit_dest"
  chmod 644 "$unit_dest"
  systemctl daemon-reload
fi

if (( first_install )); then
  mkdir -p logs .next .data
  systemctl enable "$service"
fi

# ── Update steps ──────────────────────────────────────────────────────────────
# On first install, skip git pull (you presumably just cloned) but always
# install + build so the service has something to run.
(( !first_install && pull )) && { echo "→ git pull";   git pull --ff-only; }
(( install ))                && { echo "→ npm ci";     npm ci --no-audit --no-fund; }
                                 echo "→ npm run build"; npm run build

if (( first_install )); then
  echo "→ systemctl start $service"
  systemctl start "$service"
else
  echo "→ systemctl restart $service"
  systemctl restart "$service"
fi

# ── Health check ──────────────────────────────────────────────────────────────
if (( wait_secs > 0 )); then
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
      echo "✓ service healthy on :$port"
      (( first_install )) && cat <<EOF

Installed. Useful commands:
  sudo systemctl status  $service
  sudo systemctl restart $service
  sudo journalctl -u $service -f
  sudo ./scripts/deploy.sh        # pull + rebuild + restart
EOF
      exit 0
    fi
    sleep 2
  done
  echo "✗ service did not respond in ${wait_secs}s. Recent logs:" >&2
  journalctl -u "$service" -n 40 --no-pager >&2 || true
  exit 1
fi

systemctl --no-pager status "$service" | head -n 5
