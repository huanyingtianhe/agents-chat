import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { safetyError } from './safety-errors.mjs';

export const OPERATION_LEASE_FILENAME = '.agents-chat-operation.json';
export const OPERATION_LEASE_STALE_MS = 30 * 60 * 1000;
const OPERATION_LEASE_RECLAIM_FILENAME = `${OPERATION_LEASE_FILENAME}.reclaim`;

function invalidProjectRoot(projectRoot) {
  return safetyError('INVALID_PROJECT_ROOT', {
    stage: 'project-root',
    serviceState: 'unchanged',
    dataState: 'unchanged',
    details: { projectRoot },
  });
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(directoryPath) {
  try {
    return statSync(directoryPath).isDirectory();
  } catch {
    return false;
  }
}

function isRepositoryRoot(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!isFile(packagePath) || !isDirectory(path.join(projectRoot, 'app'))) {
    return false;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    return packageJson.name === 'agents-chat';
  } catch {
    return false;
  }
}

function isReleaseRoot(projectRoot) {
  return (
    isFile(path.join(projectRoot, 'RELEASE.txt'))
    && isFile(path.join(projectRoot, 'server.js'))
  );
}

export function validateProjectRoot(projectRoot, { release = false } = {}) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw invalidProjectRoot(String(projectRoot ?? ''));
  }

  const resolvedRoot = path.resolve(projectRoot);
  if (!isDirectory(resolvedRoot)) {
    throw invalidProjectRoot(resolvedRoot);
  }

  if (isRepositoryRoot(resolvedRoot)) {
    return Object.freeze({ projectRoot: resolvedRoot, kind: 'repository' });
  }
  if (release && isReleaseRoot(resolvedRoot)) {
    return Object.freeze({ projectRoot: resolvedRoot, kind: 'release' });
  }

  throw invalidProjectRoot(resolvedRoot);
}

export function assertNode24(
  versions = process.versions,
  execPath = process.execPath,
) {
  const nodeVersion = versions?.node;
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (major !== 24) {
    throw safetyError('NODE_VERSION_MISMATCH', {
      stage: 'runtime',
      serviceState: 'unchanged',
      dataState: 'unchanged',
      details: {
        expected: 'Node.js 24.x',
        actual: nodeVersion ?? 'unknown',
        execPath,
      },
    });
  }

  return Object.freeze({
    node: nodeVersion,
    modules: versions.modules,
    execPath,
    platform: process.platform,
    arch: process.arch,
  });
}

function leasePath(projectRoot) {
  return path.join(projectRoot, OPERATION_LEASE_FILENAME);
}

function leaseReclaimPath(projectRoot) {
  return path.join(projectRoot, OPERATION_LEASE_RECLAIM_FILENAME);
}

function readLease(projectRoot) {
  const filePath = leasePath(projectRoot);
  let lease;
  try {
    lease = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }

  if (
    typeof lease?.operationId !== 'string'
    || !Number.isInteger(lease.pid)
    || lease.pid <= 0
    || typeof lease.owner !== 'string'
    || typeof lease.startedAt !== 'string'
  ) {
    return null;
  }
  return lease;
}

function operationInProgress(lease, reason) {
  return safetyError('OPERATION_IN_PROGRESS', {
    stage: 'operation-lease',
    serviceState: 'unchanged',
    dataState: 'unchanged',
    details: {
      pid: lease?.pid,
      owner: lease?.owner,
      startedAt: lease?.startedAt,
      reason,
    },
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') {
      return true;
    }
    if (error?.code === 'ESRCH' || error?.code === 'EINVAL') {
      return false;
    }
    return true;
  }
}

function isDeadAndStale(lease, now = Date.now()) {
  if (!lease) {
    return false;
  }

  const startedAt = Date.parse(lease.startedAt);
  if (!Number.isFinite(startedAt)) {
    return false;
  }

  return (
    now - startedAt > OPERATION_LEASE_STALE_MS
    && !isProcessAlive(lease.pid)
  );
}

function writeNewLease(filePath, lease, writeLeaseContents = writeFileSync) {
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    created = true;
    writeLeaseContents(descriptor, `${JSON.stringify(lease)}\n`, 'utf8');
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original creation or write error.
      }
      descriptor = undefined;
    }
    if (created) {
      try {
        unlinkSync(filePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') {
          throw unlinkError;
        }
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function withLeaseReclaimLock(projectRoot, callback) {
  const filePath = leaseReclaimPath(projectRoot);
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw operationInProgress(readLease(projectRoot), 'lease-reclaim-in-progress');
    }
    throw error;
  }

  try {
    return callback();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
}

export function acquireOperationLease(
  projectRoot,
  owner,
  ownerPid,
  { writeLeaseContents = writeFileSync } = {},
) {
  const validated = validateProjectRoot(projectRoot, { release: true });
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new TypeError('owner is required');
  }
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new TypeError('ownerPid must be a positive integer');
  }
  if (typeof writeLeaseContents !== 'function') {
    throw new TypeError('writeLeaseContents must be a function');
  }

  const filePath = leasePath(validated.projectRoot);
  const lease = Object.freeze({
    operationId: randomUUID(),
    pid: ownerPid,
    owner: owner.trim(),
    startedAt: new Date().toISOString(),
  });

  return withLeaseReclaimLock(validated.projectRoot, () => {
    try {
      writeNewLease(filePath, lease, writeLeaseContents);
      return lease;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const existingLease = readLease(validated.projectRoot);
      if (!isDeadAndStale(existingLease)) {
        throw operationInProgress(
          existingLease,
          existingLease ? 'lease-active' : 'lease-unreadable',
        );
      }

      const confirmedLease = readLease(validated.projectRoot);
      if (confirmedLease?.operationId !== existingLease.operationId) {
        throw operationInProgress(confirmedLease, 'lease-changed');
      }

      try {
        unlinkSync(filePath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') {
          throw operationInProgress(existingLease, 'stale-lease-remove-failed');
        }
      }

      try {
        writeNewLease(filePath, lease, writeLeaseContents);
        return lease;
      } catch (writeError) {
        if (writeError?.code === 'EEXIST') {
          throw operationInProgress(readLease(validated.projectRoot), 'lease-race');
        }
        throw writeError;
      }
    }
  });
}

export function assertOperationLease(projectRoot, operationId) {
  const validated = validateProjectRoot(projectRoot, { release: true });
  if (typeof operationId !== 'string' || operationId.trim() === '') {
    throw operationInProgress(readLease(validated.projectRoot), 'operation-id-required');
  }

  const lease = readLease(validated.projectRoot);
  if (!lease || lease.operationId !== operationId) {
    throw operationInProgress(lease, lease ? 'operation-id-mismatch' : 'lease-missing');
  }

  return Object.freeze({ ...lease });
}

export function releaseOperationLease(projectRoot, operationId) {
  const validated = validateProjectRoot(projectRoot, { release: true });
  const lease = assertOperationLease(validated.projectRoot, operationId);
  const filePath = leasePath(validated.projectRoot);

  const confirmedLease = readLease(validated.projectRoot);
  if (!confirmedLease || confirmedLease.operationId !== lease.operationId) {
    throw operationInProgress(confirmedLease, 'lease-changed');
  }

  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw operationInProgress(null, 'lease-missing');
    }
    throw error;
  }
}
