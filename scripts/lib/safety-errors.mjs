export const SAFETY_CODES = Object.freeze({
  NODE_VERSION_MISMATCH: 'NODE_VERSION_MISMATCH',
  NATIVE_ADDON_INCOMPATIBLE: 'NATIVE_ADDON_INCOMPATIBLE',
  INVALID_PROJECT_ROOT: 'INVALID_PROJECT_ROOT',
  OPERATION_IN_PROGRESS: 'OPERATION_IN_PROGRESS',
  DATABASE_MISSING: 'DATABASE_MISSING',
  DATABASE_INTEGRITY_FAILED: 'DATABASE_INTEGRITY_FAILED',
  DATABASE_BUSY: 'DATABASE_BUSY',
  BACKUP_NO_SPACE: 'BACKUP_NO_SPACE',
  BACKUP_PERMISSION_DENIED: 'BACKUP_PERMISSION_DENIED',
  BACKUP_VALIDATION_FAILED: 'BACKUP_VALIDATION_FAILED',
  DEPENDENCY_INSTALL_FAILED: 'DEPENDENCY_INSTALL_FAILED',
  BUILD_FAILED: 'BUILD_FAILED',
  MANAGER_CONFLICT: 'MANAGER_CONFLICT',
  PORT_IN_USE: 'PORT_IN_USE',
  SERVICE_START_FAILED: 'SERVICE_START_FAILED',
  STORAGE_HEALTH_FAILED: 'STORAGE_HEALTH_FAILED',
  RESTORE_PRECONDITION_FAILED: 'RESTORE_PRECONDITION_FAILED',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
});

const FAILURE_SUMMARIES = Object.freeze({
  NODE_VERSION_MISMATCH: 'This command is not running with the supported Node.js 24 runtime.',
  NATIVE_ADDON_INCOMPATIBLE: 'better-sqlite3 cannot load with the active Node.js runtime.',
  INVALID_PROJECT_ROOT: 'The command is not running from a valid agents-chat project root.',
  OPERATION_IN_PROGRESS: 'Another guarded operation currently owns this project.',
  DATABASE_MISSING: 'An expected application database is missing.',
  DATABASE_INTEGRITY_FAILED: 'SQLite integrity validation failed.',
  DATABASE_BUSY: 'The database remained busy beyond the safe retry period.',
  BACKUP_NO_SPACE: 'There is not enough free space to create a verified backup.',
  BACKUP_PERMISSION_DENIED: 'The backup directory cannot be written securely.',
  BACKUP_VALIDATION_FAILED: 'The candidate backup did not pass validation.',
  DEPENDENCY_INSTALL_FAILED: 'The locked dependency installation failed.',
  BUILD_FAILED: 'The production build failed.',
  MANAGER_CONFLICT: 'More than one service manager appears to control this checkout.',
  PORT_IN_USE: 'The application port is already owned by another process.',
  SERVICE_START_FAILED: 'The service manager could not start the guarded application.',
  STORAGE_HEALTH_FAILED: 'The application started, but database-backed health checks failed.',
  RESTORE_PRECONDITION_FAILED: 'The database restore safety requirements were not met.',
  UNEXPECTED_ERROR: 'An unexpected safety operation failure occurred.',
});

const DEFAULT_ACTION_IDS = Object.freeze({
  NODE_VERSION_MISMATCH: ['activate-node-24', 'install-dependencies', 'retry-safe-command'],
  NATIVE_ADDON_INCOMPATIBLE: ['activate-node-24', 'install-dependencies', 'retry-safe-command'],
  INVALID_PROJECT_ROOT: ['change-project-root', 'retry-safe-command'],
  OPERATION_IN_PROGRESS: ['wait-for-operation', 'inspect-owner-process'],
  DATABASE_MISSING: ['verify-data-path', 'list-backups', 'review-restore'],
  DATABASE_INTEGRITY_FAILED: ['preserve-databases', 'list-backups', 'review-restore'],
  DATABASE_BUSY: ['wait-for-database', 'inspect-manager-logs', 'retry-safe-command'],
  BACKUP_NO_SPACE: ['free-backup-space', 'retry-safe-command'],
  BACKUP_PERMISSION_DENIED: ['inspect-backup-permissions', 'retry-safe-command'],
  BACKUP_VALIDATION_FAILED: ['preserve-databases', 'inspect-manager-logs', 'retry-safe-command'],
  DEPENDENCY_INSTALL_FAILED: ['install-dependencies', 'retry-safe-command'],
  BUILD_FAILED: ['inspect-build-output', 'retry-safe-command'],
  MANAGER_CONFLICT: ['inspect-managers', 'stop-unintended-manager'],
  PORT_IN_USE: ['inspect-port-owner', 'resolve-port-conflict'],
  SERVICE_START_FAILED: ['inspect-manager-status', 'inspect-manager-logs', 'retry-safe-command'],
  STORAGE_HEALTH_FAILED: ['inspect-manager-logs', 'stop-service-safely', 'review-restore'],
  RESTORE_PRECONDITION_FAILED: ['stop-service-safely', 'verify-service-stopped', 'retry-restore'],
  UNEXPECTED_ERROR: ['inspect-manager-logs', 'run-diagnostics'],
});

const MANAGER_COMMANDS = Object.freeze({
  systemd: {
    retry: 'sudo ./scripts/safe-restart.sh systemd',
    status: 'sudo systemctl status agents-chat --no-pager',
    logs: 'sudo journalctl -u agents-chat -n 100 --no-pager',
    stop: 'sudo systemctl stop agents-chat',
    verifyStopped: 'sudo systemctl is-active agents-chat',
    inspectProcess: (pid) => `ps -p ${pid ?? '<PID>'} -o pid,etime,command`,
    inspectPermissions: 'namei -l .data .data/backups',
    inspectManagers: 'systemctl status agents-chat --no-pager; pm2 status',
  },
  pm2: {
    retry: './scripts/safe-restart.sh pm2',
    status: 'pm2 status',
    logs: 'pm2 logs agents-chat --lines 100',
    stop: 'pm2 stop agents-chat',
    verifyStopped: 'pm2 describe agents-chat',
    inspectProcess: (pid) => `ps -p ${pid ?? '<PID>'} -o pid,etime,command`,
    inspectPermissions: 'namei -l .data .data/backups',
    inspectManagers: 'pm2 status; systemctl status agents-chat --no-pager',
  },
  windows: {
    retry: 'PowerShell -File .\\scripts\\safe-restart.ps1',
    status: 'Get-ScheduledTask -TaskName "AgentsChat" | Get-ScheduledTaskInfo',
    logs: 'Get-Content .\\logs\\server-error.log -Tail 100',
    stop: 'Stop-ScheduledTask -TaskName "AgentsChat"',
    verifyStopped: 'Get-ScheduledTask -TaskName "AgentsChat" | Get-ScheduledTaskInfo',
    inspectProcess: (pid) => `Get-Process -Id ${pid ?? '<PID>'}`,
    inspectPermissions: 'Get-Acl .data; Get-Acl .data\\backups',
    inspectManagers: 'Get-ScheduledTask -TaskName "AgentsChat" | Get-ScheduledTaskInfo',
  },
  generic: {
    retry: 'rerun the same guarded command',
    status: 'inspect the configured service manager status',
    logs: 'inspect the configured service manager logs',
    stop: 'stop the service with its configured manager',
    verifyStopped: 'verify the service process is stopped',
    inspectProcess: (pid) => `inspect process ${pid ?? '<PID>'}`,
    inspectPermissions: 'inspect permissions for .data and .data/backups',
    inspectManagers: 'inspect active service managers',
  },
});

const MANAGER_ALIASES = Object.freeze({
  'scheduled-task': 'windows',
  powershell: 'windows',
});

export class SafetyError extends Error {
  constructor(failure) {
    super(`[${failure.code}] ${FAILURE_SUMMARIES[failure.code]}`);
    this.name = 'SafetyError';
    this.code = failure.code;
    this.failure = failure;
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

export function createSafetyFailure(code, options = {}) {
  if (!Object.hasOwn(SAFETY_CODES, code)) {
    throw new TypeError(`Unknown safety failure code: ${code}`);
  }

  const failure = {
    code,
    stage: requireText(options.stage, 'stage'),
    serviceState: requireText(options.serviceState, 'serviceState'),
    dataState: requireText(options.dataState, 'dataState'),
    backupBatch: options.backupBatch ?? null,
    actionIds: Object.freeze([
      ...(options.actionIds ?? DEFAULT_ACTION_IDS[code]),
    ]),
    details: Object.freeze({ ...(options.details ?? {}) }),
  };

  return Object.freeze(failure);
}

export function safetyError(code, options) {
  return new SafetyError(createSafetyFailure(code, options));
}

function serviceStateMessage(serviceState) {
  switch (serviceState) {
    case 'running':
      return 'The old service is still running. No restart was attempted.';
    case 'stopped':
      return 'The service is stopped. Inspect the startup failure before changing live data.';
    case 'restarted':
      return 'The restart began; verify service health before declaring success.';
    default:
      return `Service status: ${serviceState}.`;
  }
}

function dataStateMessage(dataState) {
  switch (dataState) {
    case 'unchanged':
      return 'The live databases were not modified.';
    case 'validated':
      return 'The live databases passed validation and were not modified.';
    case 'restored':
      return 'The live databases were replaced by an explicitly selected verified backup.';
    default:
      return `Database status: ${dataState}.`;
  }
}

function detailMessage(failure) {
  const { details } = failure;
  const parts = [];

  if (details.expected && details.actual) {
    parts.push(
      `Expected ${safeDiagnosticValue(details.expected)}; actual ${safeDiagnosticValue(details.actual)}.`,
    );
  }
  if (details.execPath) {
    parts.push(`Node executable: ${safeDiagnosticValue(details.execPath)}.`);
  }
  if (details.projectRoot) {
    parts.push(`Resolved project root: ${safeDiagnosticValue(details.projectRoot)}.`);
  }
  if (Number.isInteger(details.pid)) {
    parts.push(`Owner PID: ${details.pid}.`);
  }
  if (details.owner) {
    parts.push(`Owner: ${safeDiagnosticValue(details.owner)}.`);
  }
  if (details.startedAt) {
    parts.push(`Started at: ${details.startedAt}.`);
  }
  if (details.requiredBytes != null && details.availableBytes != null) {
    parts.push(
      `Required bytes: ${details.requiredBytes}; available bytes: ${details.availableBytes}.`,
    );
  }

  return parts.join(' ');
}

function safeDiagnosticValue(value) {
  const text = String(value);
  if (/secret|password|token|api[_-]?key|credential/i.test(text)) {
    return '[redacted]';
  }
  return text.replace(/[\r\n]+/g, ' ');
}

function actionText(actionId, failure, commands) {
  const pid = failure.details.pid;
  const root = failure.details.expectedRoot ?? failure.details.projectRoot;
  const actions = {
    'activate-node-24': 'Activate Node.js 24 (install it first if needed), then verify with: node --version',
    'install-dependencies': 'Reinstall locked dependencies with Node.js 24: npm ci',
    'retry-safe-command': `Retry the guarded operation: ${commands.retry}`,
    'change-project-root': root
      ? `Change to the configured project root: cd "${root}"`
      : 'Change to the agents-chat project root before retrying.',
    'wait-for-operation': 'Wait for the active guarded operation to finish.',
    'inspect-owner-process': `Confirm the recorded owner still exists: ${commands.inspectProcess(pid)}`,
    'verify-data-path': 'Verify the configured project root and resolved .data path; do not create an empty replacement database.',
    'list-backups': 'List complete batches under .data/backups and select only a verified batch.',
    'review-restore': 'Use the documented explicit restore procedure only after validating the selected backup.',
    'preserve-databases': 'Preserve the live database files and do not run migrations or copy a live .db file manually.',
    'wait-for-database': 'Wait for active database work to finish before retrying.',
    'inspect-manager-logs': `Inspect service logs: ${commands.logs}`,
    'free-backup-space': 'Free sufficient space without deleting the live databases or unverified recovery files.',
    'inspect-backup-permissions': `Inspect data and backup permissions: ${commands.inspectPermissions}`,
    'inspect-build-output': 'Review the build output, correct the reported error, and rebuild before restarting.',
    'inspect-managers': `Inspect active managers: ${commands.inspectManagers}`,
    'stop-unintended-manager': 'Stop only the unintended manager after identifying it; do not stop processes automatically.',
    'inspect-port-owner': 'Identify the process that owns the configured port before taking action.',
    'resolve-port-conflict': 'Stop or reconfigure the identified process; do not kill an unknown process automatically.',
    'inspect-manager-status': `Inspect service status: ${commands.status}`,
    'stop-service-safely': `Stop the service with its manager: ${commands.stop}`,
    'verify-service-stopped': `Verify that the service is stopped: ${commands.verifyStopped}`,
    'retry-restore': 'Revalidate the selected backup, then retry the explicit restore command.',
    'run-diagnostics': 'Run the non-mutating runtime diagnostics command before retrying.',
  };

  return actions[actionId] ?? actionId;
}

export function renderFailure(failure, manager = 'generic') {
  if (!failure || !Object.hasOwn(SAFETY_CODES, failure.code)) {
    throw new TypeError('A valid safety failure is required');
  }

  const managerName = MANAGER_ALIASES[manager] ?? manager;
  const commands = MANAGER_COMMANDS[managerName] ?? MANAGER_COMMANDS.generic;
  const detail = detailMessage(failure);
  const actions = failure.actionIds.map(
    (actionId, index) => `  ${index + 1}. ${actionText(actionId, failure, commands)}`,
  );
  const backupState = failure.backupBatch
    ? `A verified backup is available at: ${safeDiagnosticValue(failure.backupBatch)}`
    : 'No verified backup was created for this operation.';

  return [
    `${failure.code}`,
    '',
    'What failed:',
    `  ${FAILURE_SUMMARIES[failure.code]}${detail ? ` ${detail}` : ''}`,
    '',
    'Service state:',
    `  ${serviceStateMessage(failure.serviceState)}`,
    '',
    'Data state:',
    `  ${dataStateMessage(failure.dataState)}`,
    '',
    'Backup state:',
    `  ${backupState}`,
    '',
    'Next actions:',
    ...actions,
    '',
    'Diagnostics:',
    '  node --version',
    '  node -p "process.execPath + \' ABI=\' + process.versions.modules"',
    `  ${commands.status}`,
    `  ${commands.logs}`,
  ].join('\n');
}
