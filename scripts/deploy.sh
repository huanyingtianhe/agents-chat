#!/usr/bin/env bash
# Install / update the agents-chat systemd service.
#
# First run on a machine:
#   sudo ./scripts/deploy.sh                       # installs the unit, builds, starts
#   sudo SERVICE_USER=myuser ./scripts/deploy.sh   # override the run-as user
#
# Subsequent runs (idempotent):
#   sudo ./scripts/deploy.sh                       # pull + npm ci + build + restart
#   sudo ./scripts/deploy.sh --no-pull             # skip git pull
#   sudo ./scripts/deploy.sh --no-install          # skip npm ci
#   sudo ./scripts/deploy.sh --wait 0              # don't wait for health check (default 120s)

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

# ── Resolve the user the service should run as ────────────────────────────────
# Prefer the user already baked into the installed unit (so deploys don't
# silently switch ownership). Fall back to $SERVICE_USER, then $SUDO_USER.
if [[ -f "$unit_dest" ]]; then
  user=$(systemctl show -p User --value "$service" 2>/dev/null || true)
fi
user="${user:-${SERVICE_USER:-${SUDO_USER:-root}}}"
group="$(id -gn "$user")"

as_user() {
  if [[ "$user" == "root" ]]; then
    bash -c "$*"
  else
    sudo -u "$user" -H bash -c "$*"
  fi
}

# ── First-time install (renders the unit + chowns writable dirs) ──────────────
first_install=0
if [[ ! -f "$unit_dest" ]]; then
  first_install=1
  echo "→ installing $service.service (user=$user)"

  sed \
    -e "s|__USER__|$user|g" \
    -e "s|__GROUP__|$group|g" \
    -e "s|__PROJECT_DIR__|$project_dir|g" \
    -e "s|__SCRIPT_DIR__|$script_dir|g" \
    "$unit_src" > "$unit_dest"
  chmod 644 "$unit_dest"

  mkdir -p "$project_dir/logs" "$project_dir/.next" "$project_dir/.data"
  chown -R "$user:$group" "$project_dir/logs" "$project_dir/.next" "$project_dir/.data"

  systemctl daemon-reload
  systemctl enable "$service"
fi

# ── Update steps ──────────────────────────────────────────────────────────────
# On first install, skip git pull (you presumably just cloned) but always
# install + build so the service has something to run.
(( !first_install && pull )) && { echo "→ git pull"; as_user "git pull --ff-only"; }
(( install )) && { echo "→ npm ci";       as_user "npm ci --no-audit --no-fund"; }
                  echo "→ npm run build"; as_user "npm run build"

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
