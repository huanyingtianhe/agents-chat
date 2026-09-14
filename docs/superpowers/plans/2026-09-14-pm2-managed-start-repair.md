# PM2 Managed Start Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `./scripts/safe-restart.sh pm2` start the real Next.js process instead of leaving an idle PM2 container with nothing listening on port 3010.

**Architecture:** Keep `scripts/start-server.mjs` as the reusable managed launcher and direct/systemd entry point. Add an internal side-effect entry module for PM2, which imports and explicitly invokes the managed launcher, then point the ecosystem configuration at that adapter.

**Tech Stack:** Node.js 24 ESM, PM2 fork mode, Next.js 16, Node `node:test`, Bash.

---

## File Map

**Create**

- `scripts/start-pm2.mjs` — internal PM2 adapter that explicitly invokes the managed launcher when PM2 imports the configured module.

**Modify**

- `scripts/start-server.mjs` — expose one error-handled `runManagedServer` entry function for direct and PM2 callers.
- `ecosystem.config.js` — point PM2 at the dedicated adapter while preserving the validated absolute Node interpreter.
- `tests/managed-start.test.mjs` — execute the adapter as an imported module with a stub launcher and assert that it invokes startup.
- `tests/safe-restart-scripts.test.js` — require the PM2 ecosystem contract to use the dedicated adapter.

### Task 1: Add PM2 Entry Regression Coverage

**Files:**
- Modify: `tests/managed-start.test.mjs`
- Modify: `tests/safe-restart-scripts.test.js:183-205`

- [ ] **Step 1: Write the failing imported-entry test**

Add this test after the termination-signal test in
`tests/managed-start.test.mjs`:

```js
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
```

This test intentionally reads `scripts/start-pm2.mjs` before that file exists,
so the red phase proves coverage is capable of detecting the missing PM2
adapter.

- [ ] **Step 2: Tighten the ecosystem contract**

In `tests/safe-restart-scripts.test.js`, add this assertion beside the existing
ecosystem assertions:

```js
assert.match(ecosystem, /script:\s*['"]scripts\/start-pm2\.mjs['"]/);
```

In `tests/managed-start.test.mjs`, change the existing ecosystem assertion:

```js
assert.match(ecosystem, /script:\s*['"]scripts\/start-pm2\.mjs['"]/);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
node --test tests/managed-start.test.mjs tests/safe-restart-scripts.test.js
```

Expected: FAIL because `scripts/start-pm2.mjs` does not exist and
`ecosystem.config.js` still references `scripts/start-server.mjs`.

### Task 2: Implement the Dedicated PM2 Entry

**Files:**
- Create: `scripts/start-pm2.mjs`
- Modify: `scripts/start-server.mjs:66-82`
- Modify: `ecosystem.config.js:10`

- [ ] **Step 1: Expose the shared error-handled launcher**

Replace the bottom-level error handling and direct invocation in
`scripts/start-server.mjs` with:

```js
function handleMainError(error) {
  if (error instanceof SafetyError) {
    process.stderr.write(`${JSON.stringify({ ok: false, failure: error.failure })}\n`);
    process.stderr.write(`${renderFailure(error.failure, 'generic')}\n`);
  } else {
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
  process.exitCode = 1;
}

export function runManagedServer(options) {
  try {
    return startManagedServer(options);
  } catch (error) {
    handleMainError(error);
    return undefined;
  }
}

if (
  process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runManagedServer();
}
```

The direct-execution guard remains in place so importing launcher helpers does
not start Next.js. `runManagedServer` gives the PM2 adapter an explicit,
error-handled API.

- [ ] **Step 2: Add the PM2 side-effect adapter**

Create `scripts/start-pm2.mjs`:

```js
#!/usr/bin/env node

import { runManagedServer } from './start-server.mjs';

runManagedServer();
```

This module intentionally invokes startup at import time because PM2 fork mode
loads the configured script through its process container.

- [ ] **Step 3: Point PM2 at the adapter**

In `ecosystem.config.js`, change only the script path:

```js
script: 'scripts/start-pm2.mjs',
```

Keep `interpreter`, `cwd`, `exec_mode`, `instances`, and `env` unchanged.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
node --test tests/managed-start.test.mjs tests/safe-restart-scripts.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Run formatting and diff checks**

Run:

```bash
git diff --check
```

Expected: exit code 0 with no output.

- [ ] **Step 6: Commit the repair**

```bash
git add scripts/start-pm2.mjs scripts/start-server.mjs ecosystem.config.js \
  tests/managed-start.test.mjs tests/safe-restart-scripts.test.js
git commit -m "fix: start managed server through PM2" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: one new commit on `feat/safe-restart-sqlite-backups`.

### Task 3: Validate the Real PM2 Restart and Update PR 48

**Files:**
- No additional source files.

- [ ] **Step 1: Execute the user-facing restart command**

Run:

```bash
./scripts/safe-restart.sh pm2
```

Expected: the command prints `storage health passed on :3010`, saves the PM2
process list, and ends with `agents-chat pm2 restart completed safely`.

- [ ] **Step 2: Verify PM2 topology and the listening port**

Run:

```bash
pm2 describe agents-chat --no-color
ss -ltnp '( sport = :3010 )'
```

Expected: PM2 reports one fork-mode `agents-chat` process as `online`, and
`ss` reports a listening socket on port 3010.

- [ ] **Step 3: Verify storage-backed readiness**

Run:

```bash
curl -fsS http://localhost:3010/api/health/storage
```

Expected: HTTP success with a JSON response containing `"ok":true`.

- [ ] **Step 4: Push the PR branch**

Run:

```bash
git push origin feat/safe-restart-sqlite-backups
```

Expected: the new design and repair commits are pushed to the head branch of
`huanyingtianhe/agents-chat#48`.

- [ ] **Step 5: Confirm PR 48 contains both commits**

Run:

```bash
gh pr view 48 --repo huanyingtianhe/agents-chat \
  --json headRefName,commits,url
```

Expected: `headRefName` is `feat/safe-restart-sqlite-backups`, and the commit
list includes `docs: clarify PM2 managed startup` and
`fix: start managed server through PM2`.
