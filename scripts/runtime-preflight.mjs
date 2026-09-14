#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import {
  createVerifiedBackup,
  inspectProtectedDatabases,
} from './lib/database-backup.mjs';
import { renderFailure, safetyError, SafetyError } from './lib/safety-errors.mjs';
import {
  acquireOperationLease,
  assertNode24,
  assertOperationLease,
  releaseOperationLease,
  validateProjectRoot,
} from './lib/runtime-safety.mjs';

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new TypeError(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`--${name} is required`);
  }
  return value;
}

function assertNativeAddon() {
  let database;
  try {
    database = new Database(':memory:');
    database.prepare('SELECT 1').get();
  } catch (error) {
    throw safetyError('NATIVE_ADDON_INCOMPATIBLE', {
      stage: 'native-addon',
      serviceState: 'unchanged',
      dataState: 'unchanged',
      details: {
        node: process.versions.node,
        modules: process.versions.modules,
        osCode: error?.code,
      },
    });
  } finally {
    database?.close();
  }
}

function validation(projectRoot) {
  const runtime = assertNode24();
  const root = validateProjectRoot(projectRoot, { release: true });
  assertNativeAddon();
  const storage = inspectProtectedDatabases({ projectRoot: root.projectRoot });
  return {
    runtime,
    root,
    storage: {
      dataPath: storage.dataPath,
      fresh: storage.fresh,
      stateExists: storage.stateExists,
      expectedDatabases: storage.expectedDatabases,
      databases: storage.databases,
    },
  };
}

export function checkRuntimeAndStorage({
  mode,
  projectRoot = process.cwd(),
} = {}) {
  if (mode !== 'check-only') {
    throw new TypeError('mode must be check-only');
  }
  return validation(path.resolve(projectRoot));
}

function ownerPid(options) {
  if (options['owner-pid'] === undefined) {
    return process.ppid;
  }
  const parsed = Number(options['owner-pid']);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError('--owner-pid must be a positive integer');
  }
  return parsed;
}

function output(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function managerName(value) {
  const manager = value ?? 'generic';
  if (!['generic', 'systemd', 'pm2', 'windows'].includes(manager)) {
    throw new TypeError('--manager must be systemd, pm2, or windows');
  }
  return manager;
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const projectRoot = path.resolve(options['project-root'] ?? process.cwd());

  switch (command) {
    case 'acquire':
    case 'acquire-lease': {
      assertNode24();
      const lease = acquireOperationLease(
        projectRoot,
        required(options, 'owner'),
        ownerPid(options),
      );
      output({ ok: true, command: 'acquire', lease });
      return;
    }
    case 'prepare': {
      const operationId = required(options, 'operation-id');
      assertOperationLease(projectRoot, operationId);
      const checked = validation(projectRoot);
      const backup = await createVerifiedBackup({
        projectRoot,
        operationId,
        retain: 10,
      });
      output({ ok: true, command, checked, backup });
      return;
    }
    case 'check-only': {
      output({
        ok: true,
        command,
        checked: checkRuntimeAndStorage({ mode: 'check-only', projectRoot }),
      });
      return;
    }
    case 'diagnose': {
      const manager = managerName(options.manager);
      const checked = validation(projectRoot);
      output({
        ok: true,
        command,
        manager,
        checked,
      });
      return;
    }
    case 'release':
    case 'release-lease': {
      const operationId = required(options, 'operation-id');
      releaseOperationLease(projectRoot, operationId);
      output({ ok: true, command: 'release', operationId });
      return;
    }
    default:
      throw new TypeError(
        'Usage: runtime-preflight.mjs <acquire|prepare|check-only|diagnose|release> '
        + '[--project-root <path>] [--owner <name>] [--owner-pid <pid>] '
        + '[--operation-id <id>] [--manager <systemd|pm2|windows>]',
      );
  }
}

function handleMainError(error) {
  const managerIndex = process.argv.indexOf('--manager');
  const manager = managerIndex >= 0
    ? process.argv[managerIndex + 1]
    : 'generic';
  if (error instanceof SafetyError) {
    process.stderr.write(`${JSON.stringify({ ok: false, failure: error.failure })}\n`);
    process.stderr.write(`${renderFailure(error.failure, manager)}\n`);
    process.exitCode = 1;
    return;
  }

  const failure = safetyError('UNEXPECTED_ERROR', {
    stage: 'preflight-cli',
    serviceState: 'unchanged',
    dataState: 'unchanged',
    details: { reason: error?.message },
  });
  process.stderr.write(`${JSON.stringify({ ok: false, failure: failure.failure })}\n`);
  process.stderr.write(`${renderFailure(failure.failure, manager)}\n`);
  process.exitCode = 1;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch(handleMainError);
}
