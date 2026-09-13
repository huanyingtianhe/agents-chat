import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { after, before, test } from 'node:test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  SAFETY_CODES,
  createSafetyFailure,
  renderFailure,
} from '../scripts/lib/safety-errors.mjs';
import {
  OPERATION_LEASE_FILENAME,
  acquireOperationLease,
  assertNode24,
  assertOperationLease,
  releaseOperationLease,
  validateProjectRoot,
} from '../scripts/lib/runtime-safety.mjs';

const workRoot = path.join(process.cwd(), 'tests', '.runtime-safety-work');

before(() => {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
});

after(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function createRoot(name = `project-${randomUUID()}`) {
  const projectRoot = path.join(workRoot, name);
  mkdirSync(path.join(projectRoot, 'app'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'agents-chat', private: true }),
  );
  return projectRoot;
}

function writeLease(projectRoot, lease) {
  writeFileSync(
    path.join(projectRoot, OPERATION_LEASE_FILENAME),
    `${JSON.stringify(lease)}\n`,
    { mode: 0o600 },
  );
}

test('creates a stable structured failure and requires safety state', () => {
  assert.equal(
    SAFETY_CODES.NODE_VERSION_MISMATCH,
    'NODE_VERSION_MISMATCH',
  );
  assert.throws(
    () => createSafetyFailure('NODE_VERSION_MISMATCH', {
      serviceState: 'running',
      dataState: 'unchanged',
    }),
    /stage is required/i,
  );
  assert.throws(
    () => createSafetyFailure('NOT_A_CODE', {
      stage: 'runtime',
      serviceState: 'running',
      dataState: 'unchanged',
    }),
    /unknown safety failure code/i,
  );

  const failure = createSafetyFailure('NODE_VERSION_MISMATCH', {
    stage: 'runtime',
    serviceState: 'running',
    dataState: 'unchanged',
    backupBatch: null,
    details: {
      expected: '24.x',
      actual: '22.0.0',
      execPath: '/opt/node 22/bin/node',
      token: 'secret-value',
    },
  });

  assert.deepEqual(
    {
      code: failure.code,
      stage: failure.stage,
      serviceState: failure.serviceState,
      dataState: failure.dataState,
      backupBatch: failure.backupBatch,
    },
    {
      code: 'NODE_VERSION_MISMATCH',
      stage: 'runtime',
      serviceState: 'running',
      dataState: 'unchanged',
      backupBatch: null,
    },
  );
  assert.ok(Object.isFrozen(failure));
});

test('renders safe, clear, systemd-specific recovery actions', () => {
  const failure = createSafetyFailure('NODE_VERSION_MISMATCH', {
    stage: 'runtime',
    serviceState: 'running',
    dataState: 'unchanged',
    details: {
      expected: '24.x',
      actual: '22.0.0',
      execPath: '/opt/node 22/bin/node',
      token: 'secret-value',
    },
  });

  const output = renderFailure(failure, 'systemd');

  assert.match(output, /What failed:/);
  assert.match(output, /Service state:/);
  assert.match(output, /old service is still running/i);
  assert.match(output, /Data state:/);
  assert.match(output, /live databases were not modified/i);
  assert.match(output, /Backup state:/);
  assert.match(output, /Next actions:\n\s+1\./);
  assert.match(output, /activate (?:or install )?Node\.js 24/i);
  assert.match(output, /sudo \.\/scripts\/safe-restart\.sh systemd/);
  assert.match(output, /journalctl -u agents-chat/);
  assert.doesNotMatch(output, /secret-value/);
  assert.doesNotMatch(output, /\btoken\b/i);
});

test('renders only manager-appropriate diagnostics', () => {
  const failure = createSafetyFailure('SERVICE_START_FAILED', {
    stage: 'service-start',
    serviceState: 'stopped',
    dataState: 'unchanged',
    backupBatch: '/srv/agents chat/.data/backups/safe-batch',
  });

  const pm2 = renderFailure(failure, 'pm2');
  assert.match(pm2, /pm2 status/);
  assert.match(pm2, /pm2 logs agents-chat/);
  assert.doesNotMatch(pm2, /journalctl|Get-ScheduledTask/i);

  const windows = renderFailure(failure, 'windows');
  assert.match(windows, /Get-ScheduledTask/i);
  assert.match(windows, /PowerShell/i);
  assert.doesNotMatch(windows, /journalctl|pm2 logs/i);
});

test('keeps operation and storage state files out of Git', () => {
  const gitignore = readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');

  assert.match(gitignore, /^\.agents-chat-operation\.json$/m);
  assert.match(gitignore, /^\.agents-chat-storage\.json$/m);
});

test('validates repository roots with spaces and Unicode', () => {
  const projectRoot = createRoot('agents chat – 安全');
  const result = validateProjectRoot(projectRoot);

  assert.equal(result.projectRoot, path.resolve(projectRoot));
  assert.equal(result.kind, 'repository');
});

test('validates generated release roots only when release mode is enabled', () => {
  const projectRoot = path.join(workRoot, 'release root');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(path.join(projectRoot, 'RELEASE.txt'), 'agents-chat release\n');
  writeFileSync(path.join(projectRoot, 'server.js'), 'console.log("server");\n');

  assert.throws(
    () => validateProjectRoot(projectRoot),
    /INVALID_PROJECT_ROOT/,
  );
  assert.equal(
    validateProjectRoot(projectRoot, { release: true }).kind,
    'release',
  );

  const lease = acquireOperationLease(projectRoot, 'release-operation');
  assert.equal(
    assertOperationLease(projectRoot, lease.operationId).operationId,
    lease.operationId,
  );
  releaseOperationLease(projectRoot, lease.operationId);
});

test('rejects roots with missing or misleading markers', () => {
  const missingApp = path.join(workRoot, 'wrong-root');
  mkdirSync(missingApp, { recursive: true });
  writeFileSync(
    path.join(missingApp, 'package.json'),
    JSON.stringify({ name: 'agents-chat' }),
  );

  const wrongPackage = path.join(workRoot, 'other-project');
  mkdirSync(path.join(wrongPackage, 'app'), { recursive: true });
  writeFileSync(
    path.join(wrongPackage, 'package.json'),
    JSON.stringify({ name: 'other-project' }),
  );

  assert.throws(
    () => validateProjectRoot(missingApp),
    /INVALID_PROJECT_ROOT/,
  );
  assert.throws(
    () => validateProjectRoot(wrongPackage),
    /INVALID_PROJECT_ROOT/,
  );
});

test('accepts Node 24 runtime metadata and rejects other majors', () => {
  const runtime = assertNode24(
    { node: '24.8.0', modules: '137' },
    '/opt/node 24/bin/node',
  );
  assert.deepEqual(runtime, {
    node: '24.8.0',
    modules: '137',
    execPath: '/opt/node 24/bin/node',
    platform: process.platform,
    arch: process.arch,
  });

  assert.throws(
    () => assertNode24(
      { node: '22.18.0', modules: '127' },
      'C:\\Program Files\\nodejs\\node.exe',
    ),
    /NODE_VERSION_MISMATCH/,
  );
});

test('acquires, validates, and releases an owned operation lease', () => {
  const projectRoot = createRoot();
  const lease = acquireOperationLease(projectRoot, 'test-owner');

  assert.match(lease.operationId, /^[0-9a-f-]{36}$/i);
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.owner, 'test-owner');
  assert.equal(assertOperationLease(projectRoot, lease.operationId).owner, 'test-owner');
  assert.throws(
    () => acquireOperationLease(projectRoot, 'second-owner'),
    /OPERATION_IN_PROGRESS/,
  );

  releaseOperationLease(projectRoot, lease.operationId);
  assert.throws(
    () => assertOperationLease(projectRoot, lease.operationId),
    /OPERATION_IN_PROGRESS/,
  );
});

test('does not release or validate a lease for a mismatched operation ID', () => {
  const projectRoot = createRoot();
  const lease = acquireOperationLease(projectRoot, 'test-owner');

  assert.throws(
    () => assertOperationLease(projectRoot, randomUUID()),
    /OPERATION_IN_PROGRESS/,
  );
  assert.throws(
    () => releaseOperationLease(projectRoot, randomUUID()),
    /OPERATION_IN_PROGRESS/,
  );
  assert.equal(
    JSON.parse(
      readFileSync(path.join(projectRoot, OPERATION_LEASE_FILENAME), 'utf8'),
    ).operationId,
    lease.operationId,
  );

  releaseOperationLease(projectRoot, lease.operationId);
});

test('never reclaims a lease owned by a live PID even when it is old', () => {
  const projectRoot = createRoot();
  writeLease(projectRoot, {
    operationId: randomUUID(),
    pid: process.pid,
    owner: 'live-owner',
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });

  assert.throws(
    () => acquireOperationLease(projectRoot, 'new-owner'),
    /OPERATION_IN_PROGRESS/,
  );
});

test('does not reclaim a recent lease whose PID is absent', () => {
  const projectRoot = createRoot();
  writeLease(projectRoot, {
    operationId: randomUUID(),
    pid: 2_000_000_000,
    owner: 'recent-dead-owner',
    startedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  assert.throws(
    () => acquireOperationLease(projectRoot, 'new-owner'),
    /OPERATION_IN_PROGRESS/,
  );
});

test('reclaims a stale lease only when its PID is absent and it is older than the threshold', () => {
  const projectRoot = createRoot();
  const previousOperationId = randomUUID();
  writeLease(projectRoot, {
    operationId: previousOperationId,
    pid: 2_000_000_000,
    owner: 'stale-dead-owner',
    startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });

  const lease = acquireOperationLease(projectRoot, 'replacement-owner');

  assert.notEqual(lease.operationId, previousOperationId);
  assert.equal(lease.owner, 'replacement-owner');
  releaseOperationLease(projectRoot, lease.operationId);
});
