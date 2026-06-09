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

# ── Locate Node.js / npm ──────────────────────────────────────────────────────
# When running via sudo, user-local version managers (nvm, fnm, volta) aren't
# in root's PATH. We probe common install locations before giving up.
_try_add_node_path() {
  local dir="$1"
  if [[ -d "$dir" && -x "$dir/node" && -x "$dir/npm" ]]; then
    export PATH="$dir:$PATH"
    return 0
  fi
  return 1
}

if ! command -v npm >/dev/null 2>&1; then
  _home="${SUDO_USER:+/home/$SUDO_USER}"
  [[ -z "$_home" ]] && _home="$HOME"
  found=0

  # 1) nvm — pick the highest installed version
  _nvm_dir="$_home/.nvm/versions/node"
  if [[ -d "$_nvm_dir" ]]; then
    _latest=$(ls -v "$_nvm_dir" 2>/dev/null | tail -n1)
    [[ -n "$_latest" ]] && _try_add_node_path "$_nvm_dir/$_latest/bin" && found=1
  fi

  # 2) fnm
  if (( !found )); then
    _fnm_dir="$_home/.local/share/fnm/node-versions"
    if [[ -d "$_fnm_dir" ]]; then
      _latest=$(ls -v "$_fnm_dir" 2>/dev/null | tail -n1)
      [[ -n "$_latest" ]] && _try_add_node_path "$_fnm_dir/$_latest/installation/bin" && found=1
    fi
  fi

  # 3) volta
  if (( !found )); then
    _volta_bin="$_home/.volta/bin"
    _try_add_node_path "$_volta_bin" && found=1
  fi

  # 4) Common system-wide locations
  if (( !found )); then
    for _dir in /usr/local/bin /usr/bin /snap/node/current/bin; do
      _try_add_node_path "$_dir" && { found=1; break; }
    done
  fi

  command -v npm >/dev/null 2>&1 || {
    echo "ERROR: npm not found." >&2
    echo "" >&2
    echo "Searched: nvm, fnm, volta, /usr/local/bin, /usr/bin, /snap/node/" >&2
    echo "" >&2
    echo "Install Node.js via one of:" >&2
    echo "  • nvm:    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash" >&2
    echo "  • fnm:    curl -fsSL https://fnm.vercel.app/install | bash" >&2
    echo "  • volta:  curl https://get.volta.sh | bash" >&2
    echo "  • system: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs" >&2
    exit 1
  }
fi
unset _try_add_node_path _home _nvm_dir _fnm_dir _volta_bin _latest _dir found

user="$(id -un)"
group="$(id -gn)"
npm_bin="$(command -v npm)"
node_bin_dir="$(dirname "$(command -v node)")"

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
  -e "s|__NODE_BIN_DIR__|$node_bin_dir|g" \
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
