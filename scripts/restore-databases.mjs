#!/usr/bin/env node

import path from 'node:path';

import {
  restoreVerifiedBackup,
} from './lib/database-backup.mjs';
import { renderFailure, safetyError, SafetyError } from './lib/safety-errors.mjs';
import { assertNode24 } from './lib/runtime-safety.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new TypeError(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }
  return options;
}

function required(options, name) {
  if (typeof options[name] !== 'string' || options[name].trim() === '') {
    throw new TypeError(`--${name} is required`);
  }
  return options[name];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assertNode24();
  if (options['service-stopped'] !== true) {
    throw safetyError('RESTORE_PRECONDITION_FAILED', {
      stage: 'restore-cli',
      serviceState: 'unknown',
      dataState: 'unchanged',
      details: { reason: '--service-stopped confirmation is required' },
    });
  }

  const projectRoot = path.resolve(options['project-root'] ?? process.cwd());
  const result = await restoreVerifiedBackup({
    projectRoot,
    operationId: required(options, 'operation-id'),
    batchPath: path.resolve(required(options, 'from')),
    serviceStopped: true,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

main().catch((error) => {
  const managerIndex = process.argv.indexOf('--manager');
  const manager = managerIndex >= 0
    ? process.argv[managerIndex + 1]
    : 'generic';
  const safety = error instanceof SafetyError
    ? error
    : safetyError('UNEXPECTED_ERROR', {
      stage: 'restore-cli',
      serviceState: 'unknown',
      dataState: 'unchanged',
      details: { reason: error?.message },
    });
  process.stderr.write(`${JSON.stringify({ ok: false, failure: safety.failure })}\n`);
  process.stderr.write(`${renderFailure(safety.failure, manager)}\n`);
  process.exitCode = 1;
});
