const assert = require('node:assert/strict');
const {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const workRoot = path.join(projectRoot, 'tests', '.safe-restart-work');

function assertBefore(source, first, second) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing ${first}`);
  assert.notEqual(secondIndex, -1, `missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must precede ${second}`);
}

function executable(file, body) {
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o755);
}

function createHarness(name, env = {}) {
  const root = path.join(workRoot, name);
  const scripts = path.join(root, 'scripts');
  const bin = path.join(root, 'mock-bin');
  mkdirSync(path.join(root, 'app'), { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"agents-chat","private":true}\n');
  cpSync(path.join(projectRoot, 'scripts', 'safe-restart.sh'), path.join(scripts, 'safe-restart.sh'));
  cpSync(path.join(projectRoot, 'scripts', 'deploy.sh'), path.join(scripts, 'deploy.sh'));
  cpSync(path.join(projectRoot, 'scripts', 'agents-chat.service'), path.join(scripts, 'agents-chat.service'));
  cpSync(
    path.join(projectRoot, 'scripts', 'release-operation-lease.mjs'),
    path.join(scripts, 'release-operation-lease.mjs'),
  );
  mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  cpSync(
    path.join(projectRoot, 'scripts', 'lib', 'runtime-safety.mjs'),
    path.join(scripts, 'lib', 'runtime-safety.mjs'),
  );
  cpSync(
    path.join(projectRoot, 'scripts', 'lib', 'safety-errors.mjs'),
    path.join(scripts, 'lib', 'safety-errors.mjs'),
  );
  cpSync(path.join(projectRoot, 'ecosystem.config.js'), path.join(root, 'ecosystem.config.js'));
  chmodSync(path.join(scripts, 'safe-restart.sh'), 0o755);
  chmodSync(path.join(scripts, 'deploy.sh'), 0o755);

  const log = path.join(root, 'commands.log');
  const common = 'printf \'%s\\n\' "$0 $*" >> "$MOCK_LOG"';
  executable(path.join(bin, 'node'), `${common}
if [[ "\${1:-}" == "-e" ]]; then
  exec "$REAL_NODE" "$@"
fi
if [[ "\${1:-}" == "-p" ]]; then
  printf '%s\\n' "$MOCK_NODE"
  exit 0
fi
case "$*" in
  *"runtime-preflight.mjs acquire-lease"*)
    printf '{"operationId":"operation-test","pid":%s,"owner":"mock","startedAt":"2026-01-01T00:00:00.000Z"}\n' "$PPID" > "$PROJECT_ROOT/.agents-chat-operation.json"
    printf '{"ok":true,"lease":{"operationId":"operation-test"}}\\n'
    ;;
  *"runtime-preflight.mjs prepare"*)
    if [[ "\${MOCK_PREPARE_FAIL:-0}" == 1 ]]; then
      printf '{"ok":false,"failure":{"code":"DATABASE_BUSY"}}\\n' >&2
      exit 1
    fi
    printf '{"ok":true,"backup":{"path":"%s/.data/backups/verified"}}\\n' "$PROJECT_ROOT"
    ;;
  *"release-operation-lease.mjs"*)
    if [[ "\${MOCK_REAL_RELEASE:-0}" == 1 ]]; then
      exec "$REAL_NODE" "$@"
    fi
    rm -f "$PROJECT_ROOT/.agents-chat-operation.json"
    printf '{"ok":true}\\n'
    ;;
  *"runtime-preflight.mjs check-only"*)
    printf '{"ok":true}\\n'
    ;;
  *)
    printf 'v24.20.0\\n'
    ;;
esac`);
  executable(path.join(bin, 'npm'), `${common}
[[ "\${MOCK_NPM_FAIL:-0}" != 1 ]]`);
  executable(path.join(bin, 'git'), `${common}`);
  executable(path.join(bin, 'curl'), `${common}
[[ "\${MOCK_HEALTH_FAIL:-0}" != 1 ]]`);
  executable(path.join(bin, 'journalctl'), `${common}`);
  executable(path.join(bin, 'install'), `${common}
destination="\${!#}"
cat > "$destination"`);
  executable(path.join(bin, 'sudo'), `${common}
[[ "\${MOCK_SUDO_FAIL:-0}" != 1 ]] || exit 1
shift 2
exec "$@"`);
  executable(path.join(bin, 'systemctl'), `${common}
if [[ "$*" == *"is-active"*"agents-chat"* ]]; then
  [[ "\${MOCK_SYSTEMD_ACTIVE:-0}" == 1 ]]
elif [[ "$*" == *"show"*"agents-chat"* ]]; then
  printf 'MainPID=2468\\nExecMainStartTimestamp=mock-start\\n'
fi`);
  executable(path.join(bin, 'pm2'), `${common}
printf 'PM2_ENV PORT=%s PM2_HOME=%s\\n' "\${PORT:-}" "\${PM2_HOME:-}" >> "$MOCK_LOG"
if [[ "$1" == "jlist" ]]; then
  [[ "\${MOCK_PM2_FAIL:-0}" != 1 ]] || exit 1
  count_file="$PROJECT_ROOT/.pm2-jlist-count"
  count=0
  [[ ! -f "$count_file" ]] || count="$(cat "$count_file")"
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if (( count > 1 )) && [[ -n "\${MOCK_PM2_JLIST_AFTER:-}" ]]; then
    printf '%s\\n' "$MOCK_PM2_JLIST_AFTER"
  else
    printf '%s\\n' "\${MOCK_PM2_JLIST:-[]}"
  fi
elif [[ "$1" == "pid" ]]; then
  printf '%s\\n' "\${MOCK_PM2_PID:-1357}"
elif [[ "$1" == "describe" ]]; then
  printf 'interpreter: %s\\nnode.js version: 24.20.0\\nexec mode: fork_mode\\ninstances: 1\\n' "$MOCK_NODE"
fi`);

  return {
    root,
    log,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      MOCK_LOG: log,
      MOCK_NODE: path.join(bin, 'node'),
      REAL_NODE: process.execPath,
      PROJECT_ROOT: root,
      AGENTS_CHAT_UNIT_DEST: path.join(root, 'agents-chat.service.installed'),
      AGENTS_CHAT_SKIP_ROOT_CHECK: '1',
      AGENTS_CHAT_HEALTH_INTERVAL: '0',
      AGENTS_CHAT_SYSTEM_ENV_FILE: path.join(root, 'etc-agents-chat.env'),
      ...env,
    },
  };
}

function runHarness(harness, manager, ...args) {
  return spawnSync(
    path.join(harness.root, 'scripts', 'safe-restart.sh'),
    [manager, '--wait', '1', ...args],
    {
      cwd: harness.root,
      env: harness.env,
      encoding: 'utf8',
    },
  );
}

before(() => {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
});

after(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

test('declares the deployment ordering and manager contracts', () => {
  const deploy = readFileSync(path.join(projectRoot, 'scripts', 'deploy.sh'), 'utf8');
  const unit = readFileSync(path.join(projectRoot, 'scripts', 'agents-chat.service'), 'utf8');
  const safeRestart = readFileSync(path.join(projectRoot, 'scripts', 'safe-restart.sh'), 'utf8');
  const ecosystem = readFileSync(path.join(projectRoot, 'ecosystem.config.js'), 'utf8');

  assertBefore(deploy, 'runtime-preflight.mjs acquire-lease', 'npm ci');
  assertBefore(deploy, 'npm ci', 'runtime-preflight.mjs prepare');
  assertBefore(deploy, 'runtime-preflight.mjs prepare', 'npm run build');
  assertBefore(deploy, 'npm run build', 'systemctl restart');
  assert.match(unit, /ExecStartPre=.*__NODE__.*runtime-preflight\.mjs.*check-only/);
  assert.match(unit, /ExecStart=.*__NODE__.*scripts\/start-server\.mjs/);
  assert.match(safeRestart, /systemd\|pm2/);
  assert.match(safeRestart, /pm2_action=start/);
  assert.match(safeRestart, /pm2_action=reload/);
  assert.match(safeRestart, /pm2 save/);
  assert.match(unit, /start-server\.mjs" --port "__PORT__"/);
  assert.match(ecosystem, /interpreter:\s*process\.execPath/);
  assert.match(ecosystem, /exec_mode:\s*['"]fork['"]/);
  assert.match(ecosystem, /instances:\s*1/);
});

test('holds the lease with the wrapper PID and completes systemd in safe order', () => {
  const harness = createHarness('systemd-success');
  const result = runHarness(harness, 'systemd');
  assert.equal(result.status, 0, result.stderr);

  const log = readFileSync(harness.log, 'utf8');
  assert.match(log, new RegExp(`--owner-pid ${result.pid}`));
  assertBefore(log, 'acquire-lease', 'prepare');
  assertBefore(log, 'prepare', 'npm run build');
  assertBefore(log, 'npm run build', 'systemctl restart agents-chat');
  assertBefore(log, 'systemctl restart agents-chat', 'curl -fsS');
  assertBefore(log, 'curl -fsS', 'release-operation-lease.mjs');
  assert.match(log, /api\/health\/storage/);
  const installedUnit = readFileSync(
    harness.env.AGENTS_CHAT_UNIT_DEST,
    'utf8',
  );
  const escapedNode = harness.env.MOCK_NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(installedUnit, new RegExp(`ExecStartPre="${escapedNode}"`));
  assert.match(installedUnit, new RegExp(`ExecStart="${escapedNode}"`));
});

test('deploy acquires the lease before npm ci, backup, build, restart, and health', () => {
  const harness = createHarness('systemd-deploy');
  const result = spawnSync(
    path.join(harness.root, 'scripts', 'deploy.sh'),
    ['--no-pull', '--wait', '1'],
    {
      cwd: harness.root,
      env: harness.env,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);

  const log = readFileSync(harness.log, 'utf8');
  assertBefore(log, 'acquire-lease', 'npm ci');
  assertBefore(log, 'npm ci', 'prepare');
  assertBefore(log, 'prepare', 'npm run build');
  assertBefore(log, 'npm run build', 'systemctl restart agents-chat');
  assertBefore(log, 'systemctl restart agents-chat', 'api/health/storage');
  assertBefore(log, 'api/health/storage', 'release-operation-lease.mjs');
});

test('failed preflight does not mutate either service manager', () => {
  for (const manager of ['systemd', 'pm2']) {
    const harness = createHarness(`preflight-failure-${manager}`, {
      MOCK_PREPARE_FAIL: '1',
      MOCK_PM2_JLIST: manager === 'pm2'
        ? JSON.stringify([{
          name: 'agents-chat',
          pid: 1357,
          pm2_env: {
            status: 'online',
            pm_cwd: path.join(workRoot, `preflight-failure-${manager}`),
            exec_mode: 'fork_mode',
            instances: 1,
            exec_interpreter: path.join(workRoot, `preflight-failure-${manager}`, 'mock-bin', 'node'),
            node_version: '24.20.0',
          },
        }])
        : '[]',
    });
    const result = runHarness(harness, manager);
    assert.notEqual(result.status, 0);
    const log = readFileSync(harness.log, 'utf8');
    assert.doesNotMatch(log, /systemctl (start|restart|stop)|pm2 (startOrReload|restart|stop|delete|save)/);
    assert.match(result.stderr, /Service state:/);
    assert.match(result.stderr, /Data state:/);
    assert.match(result.stderr, /Backup state:/);
  }
});

test('detects manager conflicts without stopping either manager', () => {
  const pm2Conflict = createHarness('systemd-pm2-conflict', {
    MOCK_PM2_JLIST: JSON.stringify([{
      name: 'agents-chat',
      pid: 111,
      pm2_env: {
        status: 'online',
        pm_cwd: path.join(workRoot, 'systemd-pm2-conflict'),
      },
    }]),
  });
  const systemdResult = runHarness(pm2Conflict, 'systemd');
  assert.notEqual(systemdResult.status, 0);
  assert.match(systemdResult.stderr, /MANAGER_CONFLICT/);

  const systemdConflict = createHarness('pm2-systemd-conflict', {
    MOCK_SYSTEMD_ACTIVE: '1',
  });
  const pm2Result = runHarness(systemdConflict, 'pm2');
  assert.notEqual(pm2Result.status, 0);
  assert.match(pm2Result.stderr, /MANAGER_CONFLICT/);

  for (const harness of [pm2Conflict, systemdConflict]) {
    const log = readFileSync(harness.log, 'utf8');
    assert.doesNotMatch(log, /systemctl stop|pm2 (stop|delete)/);
  }
});

test('PM2 uses one fork, explicit Node, validates runtime and saves only after health', () => {
  const harness = createHarness('pm2-success');
  harness.env.MOCK_PM2_JLIST = JSON.stringify([{
    name: 'agents-chat',
    pid: 1357,
    pm2_env: {
      status: 'online',
      pm_cwd: harness.root,
      exec_mode: 'fork_mode',
      instances: 1,
      exec_interpreter: harness.env.MOCK_NODE,
      node_version: '24.20.0',
    },
  }]);
  const result = runHarness(harness, 'pm2');
  assert.equal(result.status, 0, result.stderr);

  const log = readFileSync(harness.log, 'utf8');
  assertBefore(log, 'prepare', 'pm2 reload agents-chat --update-env');
  assertBefore(log, 'pm2 reload', 'pm2 describe agents-chat');
  assertBefore(log, 'pm2 describe agents-chat', 'curl -fsS');
  assertBefore(log, 'curl -fsS', 'pm2 save');
  assertBefore(log, 'pm2 save', 'release-operation-lease.mjs');
});

test('rejects an invalid PM2 topology before reload', () => {
  const harness = createHarness('pm2-cluster');
  harness.env.MOCK_PM2_JLIST = JSON.stringify([{
    name: 'agents-chat',
    pid: 1357,
    pm2_env: {
      status: 'online',
      pm_cwd: harness.root,
      exec_mode: 'cluster_mode',
      instances: 2,
      exec_interpreter: harness.env.MOCK_NODE,
      node_version: '24.20.0',
    },
  }]);
  const result = runHarness(harness, 'pm2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one fork/i);
  assert.doesNotMatch(readFileSync(harness.log, 'utf8'), /pm2 (start|reload)/);
});

test('health failure reports the verified backup and does not save PM2 state', () => {
  const harness = createHarness('pm2-health-failure', {
    MOCK_HEALTH_FAIL: '1',
  });
  harness.env.MOCK_PM2_JLIST = JSON.stringify([{
    name: 'agents-chat',
    pid: 1357,
    pm2_env: {
      status: 'online',
      pm_cwd: harness.root,
      exec_mode: 'fork_mode',
      instances: 1,
      exec_interpreter: harness.env.MOCK_NODE,
      node_version: '24.20.0',
    },
  }]);
  const result = runHarness(harness, 'pm2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STORAGE_HEALTH_FAILED/);
  assert.match(result.stderr, /verified backup is available at: .*\/verified/);
  assert.match(result.stderr, /restart.*running/i);
  assert.doesNotMatch(readFileSync(harness.log, 'utf8'), /pm2 save/);
});

test('releases the lease after npm ci removes native dependencies and fails', () => {
  const harness = createHarness('dependency-failure-release', {
    MOCK_NPM_FAIL: '1',
    MOCK_REAL_RELEASE: '1',
  });
  const result = spawnSync(
    path.join(harness.root, 'scripts', 'deploy.sh'),
    ['--no-pull', '--wait', '0'],
    {
      cwd: harness.root,
      env: harness.env,
      encoding: 'utf8',
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DEPENDENCY_INSTALL_FAILED/);
  assert.equal(
    readFileSync(harness.log, 'utf8').includes('release-operation-lease.mjs'),
    true,
  );
  assert.equal(
    require('node:fs').existsSync(
      path.join(harness.root, '.agents-chat-operation.json'),
    ),
    false,
  );
});

test('systemd inspects the checkout owner PM2 daemon and fails if inspection is unreliable', () => {
  const harness = createHarness('systemd-owner-pm2', {
    MOCK_PM2_FAIL: '1',
  });
  const result = runHarness(harness, 'systemd');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Could not inspect PM2 as checkout owner/);
  const log = readFileSync(harness.log, 'utf8');
  assert.match(log, /sudo -u \S+ env HOME=.* PM2_HOME=.*\/pm2 jlist/);
  assert.doesNotMatch(log, /systemctl restart/);
});

test('PM2 rejects any same-name app from another checkout', () => {
  const harness = createHarness('pm2-other-checkout');
  harness.env.MOCK_PM2_JLIST = JSON.stringify([
    {
      name: 'agents-chat',
      pid: 1357,
      pm2_env: {
        status: 'online',
        pm_cwd: harness.root,
        exec_mode: 'fork_mode',
        instances: 1,
        exec_interpreter: harness.env.MOCK_NODE,
        node_version: '24.20.0',
      },
    },
    {
      name: 'agents-chat',
      pid: 2468,
      pm2_env: {
        status: 'stopped',
        pm_cwd: path.join(workRoot, 'other-checkout'),
        exec_mode: 'fork_mode',
        instances: 1,
      },
    },
  ]);
  const result = runHarness(harness, 'pm2');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different checkout/);
  assert.doesNotMatch(readFileSync(harness.log, 'utf8'), /pm2 (start|reload)/);
});

test('PM2 first install is explicit and leaves exactly one matching process', () => {
  const harness = createHarness('pm2-first-install');
  harness.env.MOCK_PM2_JLIST = '[]';
  harness.env.MOCK_PM2_JLIST_AFTER = JSON.stringify([{
    name: 'agents-chat',
    pid: 1357,
    pm2_env: {
      status: 'online',
      pm_cwd: harness.root,
      exec_mode: 'fork_mode',
      instances: 1,
      exec_interpreter: harness.env.MOCK_NODE,
      node_version: '24.20.0',
    },
  }]);
  const result = runHarness(harness, 'pm2');

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(harness.log, 'utf8'),
    /pm2 start ecosystem\.config\.js --only agents-chat --update-env/,
  );
});

test('passes one systemd effective port from machine env to service and health check', () => {
  const harness = createHarness('systemd-port');
  writeFileSync(path.join(harness.root, '.env.local'), 'PORT=4010\n');
  writeFileSync(harness.env.AGENTS_CHAT_SYSTEM_ENV_FILE, 'PORT="4020"\n');
  const result = runHarness(harness, 'systemd');

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    readFileSync(harness.env.AGENTS_CHAT_UNIT_DEST, 'utf8'),
    /start-server\.mjs" --port "4020"/,
  );
  assert.match(readFileSync(harness.log, 'utf8'), /localhost:4020\/api\/health\/storage/);
});

test('passes the selected PM2 port to PM2 and the health checker', () => {
  const harness = createHarness('pm2-port', { PORT: '4030' });
  harness.env.MOCK_PM2_JLIST = JSON.stringify([{
    name: 'agents-chat',
    pid: 1357,
    pm2_env: {
      status: 'online',
      pm_cwd: harness.root,
      exec_mode: 'fork_mode',
      instances: 1,
      exec_interpreter: harness.env.MOCK_NODE,
      node_version: '24.20.0',
    },
  }]);
  const result = runHarness(harness, 'pm2');

  assert.equal(result.status, 0, result.stderr);
  const log = readFileSync(harness.log, 'utf8');
  assert.match(log, /PM2_ENV PORT=4030 PM2_HOME=/);
  assert.match(log, /localhost:4030\/api\/health\/storage/);
});

test('accepts --wait 0 and skips health polling', () => {
  const harness = createHarness('zero-wait');
  const result = runHarness(harness, 'systemd', '--wait', '0');

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(harness.log, 'utf8'), /curl /);
});

test('declares the guarded Windows deployment and restart contracts', () => {
  const safeRestart = readFileSync(path.join(projectRoot, 'scripts', 'safe-restart.ps1'), 'utf8');
  const start = readFileSync(path.join(projectRoot, 'scripts', 'start.ps1'), 'utf8');
  const watchdog = readFileSync(path.join(projectRoot, 'scripts', 'service-watchdog.ps1'), 'utf8');
  const installer = readFileSync(path.join(projectRoot, 'scripts', 'install-scheduled-task.ps1'), 'utf8');

  assertBefore(safeRestart, 'acquire-lease', 'npm ci');
  assertBefore(safeRestart, 'npm ci', ' prepare ');
  assertBefore(safeRestart, ' prepare ', 'npm run build');
  assertBefore(safeRestart, 'npm run build', 'Stopping Scheduled Task');
  assert.match(safeRestart, /\[switch\]\$Deploy/);
  assert.match(safeRestart, /if \(\$Deploy\)[\s\S]*npm ci/);
  assert.match(safeRestart, /release-operation-lease\.mjs/);
  assert.match(safeRestart, /PORT_IN_USE/);
  assert.match(safeRestart, /Get-NetTCPConnection[\s\S]*Get-CimInstance Win32_Process/);
  assert.doesNotMatch(safeRestart, /Stop-Process\s+-Id\s+\$[A-Za-z]+\s+-Force[\s\S]{0,120}Get-NetTCPConnection/);
  assert.match(safeRestart, /Write-StopRequest[\s\S]*Generation[\s\S]*WatchdogPid/);
  assert.match(safeRestart, /Get-OwnedProcessSnapshots/);
  assert.match(safeRestart, /Test-ProcessSnapshot/);
  assert.match(safeRestart, /Wait-ForOwnedProcesses/);
  assert.match(safeRestart, /Clear-MatchingStopRequest/);
  assert.match(
    safeRestart,
    /Installing Scheduled Task[\s\S]*try \{[\s\S]*& \$Installer[\s\S]*catch \{[\s\S]*SERVICE_START_FAILED[\s\S]*task-install/,
  );
  assert.match(safeRestart, /finally \{[\s\S]*Clear-MatchingStopRequest/);
  assert.doesNotMatch(safeRestart, /Stop-ScheduledTask/);
  assert.doesNotMatch(safeRestart, /Stop-Process\s+-Id\s+\$watchdogPid(?![\s\S]{0,80}-Force)/i);

  assert.match(start, /\[string\]\$NodePath/);
  assert.match(start, /\[string\]\$Generation/);
  assert.match(start, /\[int\]\$WatchdogPid/);
  assert.match(start, /\[string\]\$StopRequestPath/);
  assert.match(start, /Test-StopRequested/);
  assert.match(start, /Generation[\s\S]*WatchdogPid/);
  assert.match(start, /\$exitCode = 0\s*try \{[\s\S]*\$server = Start-Process[\s\S]*finally \{/);
  assert.match(start, /runtime-preflight\.mjs[\s\S]*check-only/);
  assert.match(start, /start-server\.mjs/);
  assert.doesNotMatch(start, /npm\s+run\s+build/i);
  assert.doesNotMatch(start, /Get-NetTCPConnection/);

  assert.match(watchdog, /\[string\]\$NodePath/);
  assert.match(watchdog, /\[guid\]::NewGuid\(\)/i);
  assert.match(watchdog, /start\.ps1[\s\S]*-NodePath[\s\S]*-Generation[\s\S]*-WatchdogPid[\s\S]*-StopRequestPath/);
  assert.match(watchdog, /Test-StopRequested/);
  assert.match(watchdog, /Get-OwnedProcessSnapshots/);
  assert.match(watchdog, /Wait-ForOwnedProcesses/);
  assert.match(watchdog, /Clear-MatchingStopRequest/);
  assertBefore(watchdog, 'Remove-Item -LiteralPath $StopRequest', 'Write-JsonFile -Path $WatchdogStateFile');
  assert.match(watchdog, /finally \{[\s\S]*Clear-MatchingStopRequest/);
  assert.doesNotMatch(watchdog, /Stop-Process\s+-Id\s+\$RootPid\s+-ErrorAction/);
  assert.doesNotMatch(watchdog, /C:\\Program Files\\nodejs/);
  assert.doesNotMatch(watchdog, /Stop-Port3000Processes/);

  assert.match(installer, /\[string\]\$NodePath/);
  assert.match(installer, /service-watchdog\.ps1[\s\S]*-NodePath/);
  assert.match(installer, /process\.execPath/);
  assert.match(installer, /24/);
  assert.doesNotMatch(installer, /Remove-Item\s+\(Join-Path\s+\$ProjectDir\s+'\.service-stop'\)/);
});

test('README documents the complete safe restart and recovery runbook', () => {
  const readme = readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  const stableFailureCodes = [
    'NODE_VERSION_MISMATCH',
    'NATIVE_ADDON_INCOMPATIBLE',
    'INVALID_PROJECT_ROOT',
    'OPERATION_IN_PROGRESS',
    'DATABASE_MISSING',
    'DATABASE_INTEGRITY_FAILED',
    'DATABASE_BUSY',
    'BACKUP_NO_SPACE',
    'BACKUP_PERMISSION_DENIED',
    'BACKUP_VALIDATION_FAILED',
    'DEPENDENCY_INSTALL_FAILED',
    'BUILD_FAILED',
    'MANAGER_CONFLICT',
    'PORT_IN_USE',
    'SERVICE_START_FAILED',
    'STORAGE_HEALTH_FAILED',
    'RESTORE_PRECONDITION_FAILED',
    'UNEXPECTED_ERROR',
  ];

  assert.match(readme, /Node\.js 24/);
  assert.match(readme, /sudo \.\/scripts\/deploy\.sh/);
  assert.match(readme, /sudo \.\/scripts\/safe-restart\.sh systemd/);
  assert.match(readme, /\.\/scripts\/safe-restart\.sh pm2/);
  assert.match(readme, /\.\\scripts\\deploy\.ps1/);
  assert.match(readme, /\.\\scripts\\safe-restart\.ps1/);
  assert.match(readme, /direct manager commands/i);
  assert.match(readme, /without a guaranteed pre-stop backup/i);
  assert.match(readme, /default.*3010/is);
  assert.match(readme, /\.env\.local.*\/etc\/agents-chat\.env/is);
  assert.match(readme, /\.env\.local.*process environment/is);
  assert.match(readme, /\.env\.local.*3000/is);
  assert.match(readme, /\.data\/backups/);
  assert.match(readme, /latest 10 complete verified batches/i);
  assert.match(readme, /0700/);
  assert.match(readme, /0600/);
  assert.match(readme, /sensitive configuration/i);
  assert.match(readme, /off-host/i);
  assert.match(readme, /npm run diagnose -- --project-root "\$PWD" --manager systemd/);
  assert.match(readme, /Get-ChildItem \.\\\.data\\backups/);
  assert.match(readme, /runtime-preflight\.mjs acquire-lease/);
  assert.match(readme, /restore-databases\.mjs/);
  assert.match(readme, /--service-stopped/);
  assert.match(readme, /runtime-preflight\.mjs release-lease/);
  assert.match(readme, /systemctl stop agents-chat/);
  assert.match(readme, /systemctl start agents-chat/);
  assert.match(readme, /pm2 stop agents-chat/);
  assert.match(readme, /pm2 start agents-chat/);
  assert.match(readme, /\.\\scripts\\safe-restart\.ps1 -RemoveTask/);
  assert.match(readme, /\.\\scripts\\deploy\.ps1 -SkipGitPull/);
  assert.match(readme, /journalctl -u agents-chat/);
  assert.match(readme, /pm2 logs agents-chat/);
  assert.match(readme, /service-watchdog\.log/);
  assert.match(readme, /start-service-child\.err\.log/);
  assert.match(readme, /storage_unavailable/);
  assert.match(readme, /do not delete or recreate `?\.data`?/i);
  assert.match(readme, /do not copy a live `?\.db`?/i);
  assert.match(readme, /do not restore.*until.*service.*stopped/is);
  for (const code of stableFailureCodes) {
    assert.match(readme, new RegExp(`\\| \`${code}\` \\|`), `missing ${code}`);
  }
});

test('pack.ps1 packages verified database snapshots and always releases its lease', () => {
  const pack = readFileSync(path.join(projectRoot, 'scripts', 'pack.ps1'), 'utf8');

  assertBefore(pack, 'acquire-lease', "'prepare'");
  assertBefore(pack, "'prepare'", 'Compress-Archive');
  assert.match(pack, /@\(['"]chats\.db['"], ['"]config\.db['"]\)/);
  assert.match(pack, /backup\.paths\.PSObject\.Properties\[\$database\]\.Value/);
  assert.match(pack, /Copy-Item[\s\S]*-LiteralPath \$snapshotPath/);
  assert.match(pack, /dataDestination = Join-Path \$StagingDir ['"]\.data['"]/);
  assert.match(pack, /finally\s*\{[\s\S]*release-operation-lease\.mjs/);
  assert.doesNotMatch(pack, /["']\.data[\\/]chats\.db["']/);
  assert.doesNotMatch(pack, /chats\.db-(?:wal|shm)/);
  assert.match(pack, /SetAccessRuleProtection|icacls/);
});

test('pack.ps1 cleans staging and fails without success output when lease release fails', () => {
  const pack = readFileSync(path.join(projectRoot, 'scripts', 'pack.ps1'), 'utf8');

  assert.match(pack, /\$PrimaryError = \$null/);
  assert.match(pack, /\$LeaseReleaseError = \$null/);
  assert.match(pack, /\$CleanupError = \$null/);
  assert.match(pack, /catch \{\s*\$PrimaryError = \$_\s*\}/);
  assert.match(
    pack,
    /if \(\$LASTEXITCODE -ne 0\) \{\s*throw "Failed to release packaging lease \$OperationId"/,
  );
  assert.match(pack, /catch \{\s*\$LeaseReleaseError = \$_\s*\}/);
  assert.match(
    pack,
    /finally \{[\s\S]*release-operation-lease\.mjs[\s\S]*Remove-Item -LiteralPath \$StagingDir -Recurse -Force/,
  );
  assertBefore(pack, 'if ($PrimaryError)', 'Write-Host "Created:');
  assertBefore(pack, 'if ($LeaseReleaseError)', 'Write-Host "Created:');
  assertBefore(pack, 'if ($CleanupError)', 'Write-Host "Created:');
  assert.match(
    pack,
    /if \(\$PrimaryError\) \{[\s\S]*Write-Warning[\s\S]*throw \$PrimaryError/,
  );
  assert.match(
    pack,
    /if \(\$LeaseReleaseError\) \{[\s\S]*?throw \$LeaseReleaseError\s*\}/,
  );
});

test('PowerShell scripts parse when PowerShell is available', (t) => {
  const shell = ['pwsh', 'powershell'].find((candidate) =>
    spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    }).status === 0);
  if (!shell) {
    t.skip('PowerShell is not installed on this host');
    return;
  }

  const scripts = [
    'safe-restart.ps1',
    'deploy.ps1',
    'start.ps1',
    'service-watchdog.ps1',
    'install-scheduled-task.ps1',
    'pack.ps1',
  ].map((name) => path.join(projectRoot, 'scripts', name));
  const command = [
    '$failed = $false',
    ...scripts.map((script) => [
      '$errors = $null',
      `[System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$null, [ref]$errors) | Out-Null`,
      'if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_) }; $failed = $true }',
    ].join('; ')),
    'if ($failed) { exit 1 }',
  ].join('; ');
  const result = spawnSync(shell, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('deploy.ps1 forwards deployment options to the safe restart wrapper', (t) => {
  const shell = ['pwsh', 'powershell'].find((candidate) =>
    spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
    }).status === 0);
  if (!shell) {
    t.skip('PowerShell is not installed on this host');
    return;
  }

  const root = path.join(workRoot, 'windows-deploy-wrapper');
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  cpSync(path.join(projectRoot, 'scripts', 'deploy.ps1'), path.join(scripts, 'deploy.ps1'));
  writeFileSync(path.join(scripts, 'safe-restart.ps1'), String.raw`
param(
  [switch]$Deploy,
  [switch]$SkipGitPull,
  [switch]$RemoveTask,
  [string]$TaskName,
  [string]$ProjectDir,
  [string]$TaskLogonType,
  [string]$TaskTriggerType,
  [switch]$NoWait,
  [int]$WaitSeconds
)
[pscustomobject]@{
  Deploy = [bool]$Deploy
  SkipGitPull = [bool]$SkipGitPull
  RemoveTask = [bool]$RemoveTask
  TaskName = $TaskName
  ProjectDir = $ProjectDir
  TaskLogonType = $TaskLogonType
  TaskTriggerType = $TaskTriggerType
  NoWait = [bool]$NoWait
  WaitSeconds = $WaitSeconds
} | ConvertTo-Json -Compress
`);
  const result = spawnSync(shell, [
    '-NoProfile',
    '-File',
    path.join(scripts, 'deploy.ps1'),
    '-ProjectDir', root,
    '-SkipGitPull',
    '-NoWait',
    '-WaitSeconds', '7',
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const forwarded = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(forwarded, {
    Deploy: true,
    SkipGitPull: true,
    RemoveTask: false,
    TaskName: 'Agents-Chat-Startup',
    ProjectDir: root,
    TaskLogonType: 'Interactive',
    TaskTriggerType: 'AtLogOn',
    NoWait: true,
    WaitSeconds: 7,
  });
});
