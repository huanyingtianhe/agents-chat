#!/usr/bin/env bash
# Install Agents-Chat as a systemd service.
#
# Usage:
#   sudo ./scripts/install-systemd-service.sh
#   sudo SERVICE_USER=myuser ./scripts/install-systemd-service.sh
#
# Idempotent: re-running rewrites the unit file and reloads systemd.
#
# Uninstall:
#   sudo systemctl disable --now agents-chat
#   sudo rm /etc/systemd/system/agents-chat.service
#   sudo systemctl daemon-reload

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
unit_src="$script_dir/agents-chat.service"
unit_dest="/etc/systemd/system/agents-chat.service"
service=agents-chat

(( EUID == 0 )) || { echo "Run with sudo." >&2; exit 1; }
[[ -f "$unit_src" ]] || { echo "Missing unit template: $unit_src" >&2; exit 1; }

user="${SERVICE_USER:-${SUDO_USER:-root}}"
group="$(id -gn "$user")"

echo "Installing $service.service"
echo "  project : $project_dir"
echo "  user    : $user ($group)"

# Render template
sed \
  -e "s|__USER__|$user|g" \
  -e "s|__GROUP__|$group|g" \
  -e "s|__PROJECT_DIR__|$project_dir|g" \
  -e "s|__SCRIPT_DIR__|$script_dir|g" \
  "$unit_src" > "$unit_dest"
chmod 644 "$unit_dest"

# Ensure writable dirs are owned by the service user
mkdir -p "$project_dir/logs" "$project_dir/.next" "$project_dir/.data"
chown -R "$user:$group" "$project_dir/logs" "$project_dir/.next" "$project_dir/.data"

# Build once so the first start doesn't have to.
echo "→ npm run build"
sudo -u "$user" -H bash -c "cd '$project_dir' && npm run build"

systemctl daemon-reload
systemctl enable --now "$service"
sleep 2
systemctl --no-pager status "$service" | head -n 8 || true

cat <<EOF

Installed. Useful commands:
  sudo systemctl status  $service
  sudo systemctl restart $service
  sudo journalctl -u $service -f
  sudo ./scripts/deploy.sh        # pull + rebuild + restart
EOF
