#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
cd "$project_dir"

service=agents-chat
manager="${1:-}"
deploy=0
pull=1
install_dependencies=1
wait_secs=120
operation_id=
backup_batch=
data_state=unchanged
restart_began=0
unit_src="$script_dir/agents-chat.service"
unit_dest="${AGENTS_CHAT_UNIT_DEST:-/etc/systemd/system/agents-chat.service}"

usage() {
  cat <<'EOF'
Usage:
  sudo ./scripts/safe-restart.sh systemd [--wait SECONDS]
  ./scripts/safe-restart.sh pm2 [--wait SECONDS]

Internal deployment options:
  --deploy       Pull/install before backup and build
  --no-pull      Skip git pull during deployment
  --no-install   Skip npm ci during deployment
EOF
}

[[ "$manager" =~ ^(systemd|pm2)$ ]] || {
  usage >&2
  exit 2
}
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy) deploy=1; shift ;;
    --no-pull) pull=0; shift ;;
    --no-install) install_dependencies=0; shift ;;
    --wait)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || {
        echo "--wait requires a positive integer" >&2
        exit 2
      }
      wait_secs="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$manager" == systemd && "${AGENTS_CHAT_SKIP_ROOT_CHECK:-0}" != 1 ]]; then
  (( EUID == 0 )) || {
    echo "Run the systemd flow with sudo." >&2
    exit 1
  }
fi

node_command="$(command -v node || true)"
[[ -n "$node_command" ]] || {
  echo "Node.js was not found in PATH. Activate Node.js 24 and retry." >&2
  exit 1
}
node_bin="$("$node_command" -p 'process.execPath')"
[[ "$node_bin" == /* && -x "$node_bin" ]] || {
  echo "Node.js did not report a usable absolute executable path." >&2
  exit 1
}
preflight="$script_dir/runtime-preflight.mjs"

service_state() {
  if [[ "$manager" == systemd ]]; then
    if command -v systemctl >/dev/null 2>&1 \
      && systemctl is-active --quiet "$service" >/dev/null 2>&1; then
      printf 'running'
    else
      printf 'stopped'
    fi
    return
  fi

  local snapshot
  snapshot="$(pm2_snapshot 2>/dev/null || true)"
  if [[ -n "$snapshot" ]] && grep -q $'\tonline\t' <<<"$snapshot"; then
    printf 'running'
  else
    printf 'stopped'
  fi
}

render_failure() {
  local code="$1"
  local stage="$2"
  local summary="$3"
  local current_service_state="${4:-$(service_state)}"
  local state_message
  local backup_message

  if [[ "$current_service_state" == running && "$restart_began" == 0 ]]; then
    state_message="The existing $service service is still running. No restart was attempted."
  elif [[ "$current_service_state" == running ]]; then
    state_message="The service restarted and is running, but the operation did not pass every verification."
  else
    state_message="The service is stopped or inactive. Inspect the manager logs before changing live data."
  fi

  if [[ -n "$backup_batch" ]]; then
    backup_message="A verified backup is available at: $backup_batch"
  else
    backup_message="No verified backup was created for this operation."
  fi

  {
    echo "SAFE RESTART FAILED [$code]"
    echo
    echo "What failed:"
    echo "  $summary (stage: $stage)"
    echo
    echo "Service state:"
    echo "  $state_message"
    echo
    echo "Data state:"
    if [[ "$data_state" == validated ]]; then
      echo "  The live databases passed validation and were not modified."
    else
      echo "  The live databases were not modified."
    fi
    echo
    echo "Backup state:"
    echo "  $backup_message"
    echo
    echo "Next actions:"
    if [[ "$code" == MANAGER_CONFLICT ]]; then
      echo "  1. Inspect both managers and identify the unintended owner."
      echo "  2. Stop only the unintended manager; this script did not stop it."
    elif [[ "$code" == DEPENDENCY_INSTALL_FAILED ]]; then
      echo "  1. Complete npm ci successfully before attempting any restart."
      echo "  2. Retry: sudo ./scripts/deploy.sh"
    elif [[ "$code" == STORAGE_HEALTH_FAILED ]]; then
      echo "  1. Inspect manager logs and the verified backup above."
      echo "  2. Stop the service safely if storage errors continue; never restore automatically."
    else
      echo "  1. Correct the reported failure without modifying the live databases."
      echo "  2. Retry: $([[ "$manager" == systemd ]] && echo sudo || true) ./scripts/safe-restart.sh $manager"
    fi
    echo
    echo "Diagnostics:"
    echo "  node --version"
    echo "  node -p \"process.execPath + ' ABI=' + process.versions.modules\""
    if [[ "$manager" == systemd ]]; then
      echo "  sudo systemctl status $service --no-pager"
      echo "  sudo journalctl -u $service -n 100 --no-pager"
    else
      echo "  pm2 status"
      echo "  pm2 logs $service --lines 100"
    fi
  } >&2
}

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$operation_id" ]]; then
    if ! "$node_bin" "$preflight" release-lease \
      --project-root "$project_dir" \
      --operation-id "$operation_id" >/dev/null; then
      if (( status == 0 )); then
        render_failure UNEXPECTED_ERROR lease-release \
          "The operation completed, but its owned lease could not be released."
        status=1
      else
        echo "Additionally, operation lease $operation_id could not be released." >&2
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

json_field() {
  local expression="$1"
  "$node_bin" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const value = Function("value", `"use strict"; return (${process.argv[1]})`)(
        JSON.parse(input),
      );
      if (value !== null && value !== undefined) process.stdout.write(String(value));
    });
  ' "$expression"
}

pm2_snapshot() {
  pm2 jlist | "$node_bin" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const root = process.argv[1];
      for (const app of JSON.parse(input)) {
        const env = app.pm2_env || {};
        if (app.name !== "agents-chat" || env.pm_cwd !== root) continue;
        console.log([
          app.pid || 0,
          env.status || "",
          env.exec_mode || "",
          env.instances ?? "",
          env.exec_interpreter || "",
          env.node_version || "",
        ].join("\t"));
      }
    });
  ' "$project_dir"
}

pm2_topology_valid() {
  local snapshot="$1"
  [[ -z "$snapshot" ]] && return 0
  [[ "$(wc -l <<<"$snapshot" | tr -d ' ')" == 1 ]] || return 1
  local pid status exec_mode instances interpreter node_version
  IFS=$'\t' read -r pid status exec_mode instances interpreter node_version <<<"$snapshot"
  [[ "$exec_mode" == fork_mode || "$exec_mode" == fork ]] || return 1
  [[ "$instances" == 1 ]] || return 1
}

detect_manager_conflict() {
  if [[ "$manager" == systemd ]]; then
    command -v pm2 >/dev/null 2>&1 || return 0
    local snapshot
    if ! snapshot="$(pm2_snapshot 2>/dev/null)"; then
      render_failure UNEXPECTED_ERROR manager-check \
        "PM2 is installed, but its process list could not be inspected."
      return 1
    fi
    if [[ -n "$snapshot" ]] && grep -q $'\tonline\t' <<<"$snapshot"; then
      render_failure \
        MANAGER_CONFLICT manager-conflict \
        "PM2 is already running $service from this checkout." \
        "$(service_state)"
      return 1
    fi
  elif command -v systemctl >/dev/null 2>&1 \
    && systemctl is-active --quiet "$service" >/dev/null 2>&1; then
    render_failure \
      MANAGER_CONFLICT manager-conflict \
      "systemd is already running $service; PM2 was not changed." \
      "$(service_state)"
    return 1
  fi
}

render_systemd_unit() {
  [[ -f "$unit_src" ]] || {
    render_failure UNEXPECTED_ERROR unit-render "Missing unit template: $unit_src"
    return 1
  }

  local user group rendered
  user="$(id -un)"
  group="$(id -gn)"
  rendered="$(sed \
    -e "s|__USER__|$user|g" \
    -e "s|__GROUP__|$group|g" \
    -e "s|__PROJECT_DIR__|$project_dir|g" \
    -e "s|__NODE__|$node_bin|g" \
    -e "s|__NODE_BIN_DIR__|$(dirname "$node_bin")|g" \
    "$unit_src")"

  if ! printf '%s\n' "$rendered" | install -m 0644 /dev/stdin "$unit_dest"; then
    render_failure UNEXPECTED_ERROR unit-render "The systemd unit could not be installed."
    return 1
  fi
  if ! systemctl daemon-reload || ! systemctl enable "$service"; then
    render_failure SERVICE_START_FAILED unit-reload "systemd could not load or enable the unit."
    return 1
  fi
}

health_check() {
  (( wait_secs > 0 )) || return 0
  local port="${PORT:-3010}"
  if [[ -z "${PORT:-}" && -f .env.local ]]; then
    local configured_port
    configured_port="$(awk -F= '/^[[:space:]]*PORT[[:space:]]*=/ {
      gsub(/[ \t"'"'"']/, "", $2); print $2
    }' .env.local | tail -n1)"
    [[ -z "$configured_port" ]] || port="$configured_port"
  fi

  local url="http://localhost:${port}/api/health/storage"
  local deadline=$(( $(date +%s) + wait_secs ))
  echo "→ waiting up to ${wait_secs}s for $url"
  while (( $(date +%s) <= deadline )); do
    if curl -fsS -o /dev/null --max-time 3 "$url"; then
      echo "✓ storage health passed on :$port"
      return 0
    fi
    sleep "${AGENTS_CHAT_HEALTH_INTERVAL:-2}"
  done
  return 1
}

if ! acquire_output="$("$node_bin" "$preflight" acquire-lease \
  --project-root "$project_dir" \
  --owner "$manager-safe-restart" \
  --owner-pid "$$" \
  --manager "$manager" 2>&1)"; then
  code="$(printf '%s' "$acquire_output" \
    | sed -n 's/.*"code":"\([^"]*\)".*/\1/p' \
    | head -n1)"
  [[ -n "$code" ]] || code=UNEXPECTED_ERROR
  render_failure "$code" operation-lease \
    "Runtime validation or operation lease acquisition failed."
  exit 1
fi
operation_id="$(printf '%s' "$acquire_output" | json_field 'value.lease.operationId')"
[[ -n "$operation_id" ]] || {
  echo "Preflight acquired no usable operation ID." >&2
  exit 1
}

detect_manager_conflict

if [[ "$manager" == pm2 ]]; then
  command -v pm2 >/dev/null 2>&1 || {
    render_failure SERVICE_START_FAILED manager-check "PM2 is not installed or not in PATH."
    exit 1
  }
  if ! current_pm2="$(pm2_snapshot 2>/dev/null)"; then
    render_failure SERVICE_START_FAILED manager-check \
      "PM2's process list could not be inspected."
    exit 1
  fi
  if ! pm2_topology_valid "$current_pm2"; then
    render_failure \
      MANAGER_CONFLICT manager-topology \
      "PM2 must manage exactly one fork-mode $service instance for this checkout."
    exit 1
  fi
fi

if (( deploy )); then
  if (( pull )); then
    echo "→ git pull"
    if ! git pull --ff-only; then
      render_failure UNEXPECTED_ERROR source-update "git pull --ff-only failed."
      exit 1
    fi
  fi
  if (( install_dependencies )); then
    echo "→ npm ci"
    if ! npm ci --no-audit --no-fund; then
      render_failure \
        DEPENDENCY_INSTALL_FAILED dependency-install \
        "npm ci failed; on-disk dependencies may be incomplete."
      exit 1
    fi
  fi
fi

echo "→ validating storage and creating a verified backup"
if ! prepare_output="$("$node_bin" "$preflight" prepare \
  --project-root "$project_dir" \
  --operation-id "$operation_id" \
  --manager "$manager" 2>&1)"; then
  code="$(printf '%s' "$prepare_output" \
    | sed -n 's/.*"code":"\([^"]*\)".*/\1/p' \
    | head -n1)"
  [[ -n "$code" ]] || code=UNEXPECTED_ERROR
  failure_json="$(printf '%s\n' "$prepare_output" | head -n1)"
  if [[ "$failure_json" == \{* ]]; then
    reported_data_state="$(printf '%s' "$failure_json" \
      | json_field 'value.failure && value.failure.dataState' 2>/dev/null || true)"
    reported_backup="$(printf '%s' "$failure_json" \
      | json_field 'value.failure && value.failure.backupBatch' 2>/dev/null || true)"
    [[ -z "$reported_data_state" ]] || data_state="$reported_data_state"
    [[ -z "$reported_backup" ]] || backup_batch="$reported_backup"
  fi
  render_failure "$code" preflight "Runtime, database validation, or verified backup failed."
  exit 1
fi
backup_batch="$(printf '%s' "$prepare_output" | json_field 'value.backup.path')"
data_state=validated

echo "→ npm run build"
if ! npm run build; then
  render_failure BUILD_FAILED build "The production build failed."
  exit 1
fi

if [[ "$manager" == systemd ]]; then
  render_systemd_unit
  restart_began=1
  echo "→ systemctl restart $service"
  if ! systemctl restart "$service"; then
    render_failure SERVICE_START_FAILED service-restart "systemd could not restart $service."
    exit 1
  fi
else
  restart_began=1
  echo "→ pm2 startOrReload ecosystem.config.js --only agents-chat --update-env"
  if ! pm2 startOrReload ecosystem.config.js --only agents-chat --update-env; then
    render_failure SERVICE_START_FAILED service-restart "PM2 could not start or reload $service."
    exit 1
  fi

  if ! pm2 describe "$service" >/dev/null; then
    render_failure SERVICE_START_FAILED runtime-verification \
      "PM2 could not describe the restarted $service process."
    exit 1
  fi
  if ! current_pm2="$(pm2_snapshot 2>/dev/null)"; then
    render_failure SERVICE_START_FAILED runtime-verification \
      "PM2's restarted process metadata could not be inspected."
    exit 1
  fi
  if ! pm2_topology_valid "$current_pm2"; then
    render_failure SERVICE_START_FAILED runtime-verification \
      "PM2 did not leave exactly one fork-mode $service process."
    exit 1
  fi
  IFS=$'\t' read -r pm2_pid pm2_status pm2_mode pm2_instances \
    pm2_interpreter pm2_node_version <<<"$current_pm2"
  if [[ "$pm2_status" != online \
    || "$pm2_interpreter" != "$node_bin" \
    || "$pm2_node_version" != 24.* ]]; then
    render_failure SERVICE_START_FAILED runtime-verification \
      "PM2 runtime metadata does not match the validated Node.js 24 executable."
    exit 1
  fi
fi

if ! health_check; then
  render_failure STORAGE_HEALTH_FAILED storage-health \
    "The service did not pass /api/health/storage within ${wait_secs}s."
  exit 1
fi

if [[ "$manager" == pm2 ]]; then
  echo "→ pm2 save"
  if ! pm2 save; then
    render_failure SERVICE_START_FAILED manager-persist \
      "PM2 could not persist the verified process list."
    exit 1
  fi
fi

echo "✓ $service $manager restart completed safely"
