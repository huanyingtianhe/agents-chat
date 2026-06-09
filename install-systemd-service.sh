#!/usr/bin/env bash
# Install Agents-Chat as a systemd service on Ubuntu/Debian.
#
# Usage:
#   sudo ./install-systemd-service.sh                       # install + enable + start
#   sudo SERVICE_USER=myuser ./install-systemd-service.sh   # override the run-as user
#
# Idempotent: re-running rewrites the unit and runs `systemctl daemon-reload`.
#
# After install:
#   sudo systemctl status  agents-chat
#   sudo systemctl restart agents-chat
#   sudo journalctl -u agents-chat -f
#
# To uninstall:
#   sudo systemctl disable --now agents-chat
#   sudo rm /etc/systemd/system/agents-chat.service
#   sudo systemctl daemon-reload

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR"
UNIT_TEMPLATE="$PROJECT_DIR/agents-chat.service"
UNIT_DEST="/etc/systemd/system/agents-chat.service"
SERVICE_NAME="agents-chat"

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root (use sudo)." >&2
  exit 1
fi

# Resolve the user/group the service should run as. Prefer SERVICE_USER env var,
# then SUDO_USER (the human who invoked sudo), else fall back to root.
SERVICE_USER="${SERVICE_USER:-${SUDO_USER:-root}}"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

if [[ ! -f "$UNIT_TEMPLATE" ]]; then
  echo "Unit template not found: $UNIT_TEMPLATE" >&2
  exit 1
fi
if [[ ! -x "$PROJECT_DIR/start.sh" ]]; then
  echo "Making start.sh executable..."
  chmod +x "$PROJECT_DIR/start.sh"
fi

echo "Installing $SERVICE_NAME.service"
echo "  Project dir : $PROJECT_DIR"
echo "  Run as user : $SERVICE_USER ($SERVICE_GROUP)"

# Render the template into /etc/systemd/system
sed \
  -e "s|__USER__|$SERVICE_USER|g" \
  -e "s|__GROUP__|$SERVICE_GROUP|g" \
  -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  "$UNIT_TEMPLATE" > "$UNIT_DEST"

chmod 644 "$UNIT_DEST"

# Ensure the run-as user owns the project dir's logs/ and .next/ folders
mkdir -p "$PROJECT_DIR/logs" "$PROJECT_DIR/.next" "$PROJECT_DIR/.data"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PROJECT_DIR/logs" "$PROJECT_DIR/.next" "$PROJECT_DIR/.data"

# Build once at install time so the first systemd start doesn't have to.
echo "Building (this may take a minute)..."
sudo -u "$SERVICE_USER" -H bash -c "cd '$PROJECT_DIR' && npm run build"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2
systemctl --no-pager status "$SERVICE_NAME" || true

cat <<EOF

Installed. Useful commands:
  sudo systemctl status  $SERVICE_NAME
  sudo systemctl restart $SERVICE_NAME
  sudo systemctl stop    $SERVICE_NAME
  sudo journalctl -u $SERVICE_NAME -f
EOF
