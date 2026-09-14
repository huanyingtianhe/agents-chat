import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { after, before, test } from 'node:test';
import path from 'node:path';

import {
  resolveEffectivePort,
  startManagedServer,
} from '../scripts/start-server.mjs';
import { checkRuntimeAndStorage } from '../scripts/runtime-preflight.mjs';

const projectRoot = process.cwd();
const workRoot = path.join(projectRoot, 'tests', '.managed-start-work');

before(() => {
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
});

after(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function createProject(name) {
  const root = path.join(workRoot, name);
  mkdirSync(path.join(root, 'app'), { recursive: true });
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'agents-chat', private: true }),
  );
  return root;
}

function fakeProcess(overrides = {}) {
  return Object.assign(new EventEmitter(), {
    argv: ['/runtime/node', '/project/scripts/start-server.mjs'],
    cwd: () => '/project',
    env: {},
    execPath: '/runtime/node',
    exitCode: undefined,
  }, overrides);
}

test('resolves one effective port from CLI, environment, or the default', () => {
  assert.equal(resolveEffectivePort([], {}), 3010);
  assert.equal(resolveEffectivePort([], { PORT: '4100' }), 4100);
  assert.equal(resolveEffectivePort(['--port', '4200'], { PORT: '4100' }), 4200);
  assert.equal(resolveEffectivePort(['--port=4300'], {}), 4300);
  assert.throws(() => resolveEffectivePort(['--port', '0'], {}), /valid TCP port/);
  assert.throws(() => resolveEffectivePort(['--hostname', 'localhost'], {}), /Unexpected argument/);
});

test('checks runtime and storage before spawning Next with the same Node executable', async () => {
  const events = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const processLike = fakeProcess({
    env: { PORT: '4100', NODE_ENV: 'production' },
  });

  const launched = startManagedServer({
    argv: ['--port', '4200'],
    projectRoot: '/project',
    processLike,
    checkRuntimeAndStorageImpl(options) {
      events.push(['check', options]);
      return { ok: true };
    },
    resolveNextBinImpl() {
      events.push(['resolve-next']);
      return '/project/node_modules/next/dist/bin/next';
    },
    spawnImpl(command, args, options) {
      events.push(['spawn', command, args, options]);
      return child;
    },
  });

  assert.deepEqual(events, [
    ['check', { mode: 'check-only', projectRoot: '/project' }],
    ['resolve-next'],
    [
      'spawn',
      '/runtime/node',
      ['/project/node_modules/next/dist/bin/next', 'start', '--port', '4200'],
      {
        cwd: '/project',
        env: { ...processLike.env, PORT: '4200' },
        stdio: 'inherit',
      },
    ],
  ]);

  child.emit('exit', 23, null);
  await launched.completion;
  assert.equal(processLike.exitCode, 23);
});

test('does not spawn when check-only fails', () => {
  let spawned = false;
  assert.throws(
    () => startManagedServer({
      projectRoot: '/project',
      nextBin: '/project/next',
      processLike: fakeProcess(),
      checkRuntimeAndStorageImpl() {
        throw new Error('unsafe storage');
      },
      spawnImpl() {
        spawned = true;
      },
    }),
    /unsafe storage/,
  );
  assert.equal(spawned, false);
});

test('forwards termination signals and preserves signal exit status', async () => {
  const child = new EventEmitter();
  const forwarded = [];
  child.kill = (signal) => {
    forwarded.push(signal);
    return true;
  };
  const processLike = fakeProcess();
  const launched = startManagedServer({
    projectRoot: '/project',
    nextBin: '/project/next',
    processLike,
    checkRuntimeAndStorageImpl() {},
    spawnImpl() {
      return child;
    },
  });

  processLike.emit('SIGTERM');
  assert.deepEqual(forwarded, ['SIGTERM']);

  child.emit('exit', null, 'SIGTERM');
  await launched.completion;
  assert.equal(processLike.exitCode, 1);
  assert.equal(processLike.listenerCount('SIGINT'), 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
});

test('PM2 imported entry explicitly starts the managed server', async () => {
  const entrySource = readFileSync(
    path.join(projectRoot, 'scripts', 'start-pm2.mjs'),
    'utf8',
  );
  const marker = '__agentsChatPm2EntryCalls';
  globalThis[marker] = 0;
  const stubUrl = `data:text/javascript,${encodeURIComponent(`
    export function runManagedServer() {
      globalThis.${marker} += 1;
    }
  `)}`;
  const executableEntry = entrySource.replace(
    './start-server.mjs',
    stubUrl,
  );

  try {
    await import(`data:text/javascript,${encodeURIComponent(executableEntry)}`);
    assert.equal(globalThis[marker], 1);
  } finally {
    delete globalThis[marker];
  }
});

test('allows a genuinely fresh install but rejects an established missing database', () => {
  const freshRoot = createProject('fresh');
  const fresh = checkRuntimeAndStorage({
    mode: 'check-only',
    projectRoot: freshRoot,
  });

  assert.equal(fresh.storage.fresh, true);
  assert.equal(fresh.storage.stateExists, false);
  assert.equal(existsSync(path.join(freshRoot, '.data')), false);

  const establishedRoot = createProject('established');
  writeFileSync(
    path.join(establishedRoot, '.agents-chat-storage.json'),
    `${JSON.stringify({
      version: 1,
      expectedDatabases: ['chats.db'],
      updatedAt: new Date().toISOString(),
    })}\n`,
  );

  assert.throws(
    () => checkRuntimeAndStorage({
      mode: 'check-only',
      projectRoot: establishedRoot,
    }),
    /DATABASE_MISSING/,
  );
});

test('npm start, PM2, and build instrumentation cannot bypass the managed guard', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  );
  const ecosystem = readFileSync(
    path.join(projectRoot, 'ecosystem.config.js'),
    'utf8',
  );
  const instrumentation = readFileSync(
    path.join(projectRoot, 'instrumentation.ts'),
    'utf8',
  );

  assert.equal(packageJson.scripts.start, 'node scripts/start-server.mjs');
  assert.equal(packageJson.scripts['start:prod'], 'npm run build && npm start');
  assert.match(ecosystem, /script:\s*['"]scripts\/start-pm2\.mjs['"]/);
  assert.match(ecosystem, /process\.env\.AGENTS_CHAT_NODE/);
  assert.match(ecosystem, /path\.isAbsolute\(interpreter\)/);
  assert.match(ecosystem, /\sinterpreter,/);
  assert.match(ecosystem, /exec_mode:\s*['"]fork['"]/);
  assert.match(ecosystem, /instances:\s*1/);
  assert.doesNotMatch(ecosystem, /script:\s*['"]npm['"]/);
  assert.match(
    instrumentation,
    /if\s*\(process\.env\.NEXT_PHASE\s*===\s*["']phase-production-build["']\)\s*return;/,
  );
});
