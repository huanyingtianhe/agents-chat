#!/usr/bin/env node

import path from 'node:path';

import { releaseOperationLease } from './lib/runtime-safety.mjs';

function requiredArgument(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`--${name} is required`);
  }
  return value;
}

try {
  const projectRoot = path.resolve(
    requiredArgument(process.argv.slice(2), 'project-root'),
  );
  const operationId = requiredArgument(
    process.argv.slice(2),
    'operation-id',
  );
  releaseOperationLease(projectRoot, operationId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: 'release',
    operationId,
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    failure: {
      code: error?.failure?.code ?? 'UNEXPECTED_ERROR',
      stage: 'lease-release',
      serviceState: 'unchanged',
      dataState: 'unchanged',
      backupBatch: null,
      details: { reason: error?.message ?? String(error) },
    },
  })}\n`);
  process.exitCode = 1;
}
