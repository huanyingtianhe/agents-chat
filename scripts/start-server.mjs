#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderFailure, SafetyError } from './lib/safety-errors.mjs';
import { checkRuntimeAndStorage } from './runtime-preflight.mjs';

const DEFAULT_PORT = 3010;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`Expected a valid TCP port, received: ${value}`);
  }
  return port;
}

export function resolveEffectivePort(argv = [], env = process.env) {
  let cliPort;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--port' || token === '-p') {
      if (index + 1 >= argv.length) {
        throw new TypeError(`${token} requires a value`);
      }
      cliPort = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--port=')) {
      cliPort = token.slice('--port='.length);
      continue;
    }
    throw new TypeError(`Unexpected argument: ${token}`);
  }
  return parsePort(cliPort ?? env.PORT ?? DEFAULT_PORT);
}

function defaultNextBin() {
  const require = createRequire(import.meta.url);
  return require.resolve('next/dist/bin/next');
}

export function startManagedServer({
  argv = process.argv.slice(2),
  projectRoot = process.cwd(),
  nextBin,
  processLike = process,
  checkRuntimeAndStorageImpl = checkRuntimeAndStorage,
  resolveNextBinImpl = defaultNextBin,
  spawnImpl = spawn,
} = {}) {
  const root = path.resolve(projectRoot);
  checkRuntimeAndStorageImpl({ mode: 'check-only', projectRoot: root });
  const port = resolveEffectivePort(argv, processLike.env);
  const resolvedNextBin = nextBin ?? resolveNextBinImpl();
  const env = { ...processLike.env, PORT: String(port) };
  const child = spawnImpl(
    processLike.execPath,
    [resolvedNextBin, 'start', '--port', String(port)],
    { cwd: root, env, stdio: 'inherit' },
  );

  let settled = false;
  const signalHandlers = new Map();
  const cleanup = () => {
    for (const [signal, handler] of signalHandlers) {
      processLike.removeListener(signal, handler);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!settled) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    processLike.on(signal, handler);
  }

  const completion = new Promise((resolve) => {
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      processLike.exitCode = 1;
      processLike.stderr?.write?.(`Failed to start Next.js: ${error.message}\n`);
      resolve({ code: 1, signal: null });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      processLike.exitCode = signal ? 1 : (code ?? 1);
      resolve({ code, signal });
    });
  });

  return { child, completion, port };
}

function handleMainError(error) {
  if (error instanceof SafetyError) {
    process.stderr.write(`${JSON.stringify({ ok: false, failure: error.failure })}\n`);
    process.stderr.write(`${renderFailure(error.failure, 'generic')}\n`);
  } else {
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
  process.exitCode = 1;
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    startManagedServer();
  } catch (error) {
    handleMainError(error);
  }
}
