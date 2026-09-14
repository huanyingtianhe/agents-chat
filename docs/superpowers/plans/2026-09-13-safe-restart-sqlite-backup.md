# Safe Restart and SQLite Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Node/native-addon drift from making persisted data appear lost, and provide verified backups, guarded restarts, actionable failures, and storage-aware health checks on Linux, PM2, and Windows.

**Architecture:** A shared ESM safety library owns runtime validation, operation leases, SQLite checks, online backup/restore, and structured failures. Thin Bash/PowerShell wrappers orchestrate platform managers, while one managed server launcher guarantees the app and preflight use the same Node executable. Application storage health and error presentation remain typed TypeScript modules and use a JSON database registry shared with the ESM tooling.

**Tech Stack:** Node.js 24, Next.js 16 App Router, TypeScript, `better-sqlite3`, Node `node:test`, Bash, Windows PowerShell 5.1, PM2, systemd, Playwright.

---

## File Map

**Create**

- `.node-version` — canonical Node major.
- `.npmrc` — enforce package engine compatibility.
- `lib/storage/databases.json` — shared protected database registry.
- `lib/storage/storagePaths.ts` — app-side canonical paths and instance-state paths.
- `lib/storage/storageErrors.ts` — classify storage failures and build safe 503 responses.
- `lib/storage/storageHealth.ts` — established-instance checks, fresh initialization, and lightweight reads.
- `app/api/health/storage/route.ts` — storage-aware readiness endpoint.
- `app/features/layout/components/StorageUnavailableBanner.tsx` — persistent user-visible storage failure.
- `scripts/lib/safety-errors.mjs` — stable failure codes and platform action rendering.
- `scripts/lib/runtime-safety.mjs` — runtime/root/database validation and operation leases.
- `scripts/lib/database-backup.mjs` — online backup, verification, retention, and restore primitives.
- `scripts/runtime-preflight.mjs` — `prepare`, `check-only`, `diagnose`, and lease commands.
- `scripts/restore-databases.mjs` — explicit guarded restore CLI.
- `scripts/start-server.mjs` — same-process preflight followed by Next.js.
- `scripts/safe-restart.sh` — Linux systemd/PM2 restart-only flow.
- `scripts/safe-restart.ps1` — Windows Scheduled Task restart-only flow.
- `tests/runtime-version-config.test.js` — Node baseline contract.
- `tests/runtime-safety.test.mjs` — validation, lease, and failure rendering.
- `tests/database-backup.test.mjs` — WAL-safe backup, retention, and restore.
- `tests/storage-health.test.ts` — storage health and error classification.
- `tests/safe-restart-scripts.test.js` — cross-platform script ordering contracts.
- `tests/storage-unavailable.spec.ts` — API/UI storage failure behavior.

**Modify**

- `package.json`, `package-lock.json` — Node engine and safety test/start commands.
- `.gitignore` — state/lease artifacts.
- `.github/workflows/playwright.yml`, `.github/workflows/release.yml` — Node 24 and safety/release smoke tests.
- `instrumentation.ts` — do not initialize runtime during production build.
- `lib/chatStore.ts`, `lib/configStore.ts`, `lib/scheduler/scheduleStore.ts`, `lib/workflowStore.ts` — canonical paths and exported health initialization.
- `app/api/chats/route.ts`, `app/api/acp/route.ts` — typed storage-unavailable responses.
- `app/features/chat/chatApi.ts`, `app/features/chat/runtime/useAgentRegistry.ts`,
  `app/features/chat/runtime/useChatRuntime.ts`,
  `app/features/chat/runtime/chatPersistenceService.ts` — preserve state and surface storage failures.
- `app/features/chat/ChatPageClient.tsx`,
  `app/features/layout/components/ChatShell.tsx`, `app/globals.css` — banner wiring and styling.
- `ecosystem.config.js` — managed launcher and explicit Node interpreter.
- `scripts/agents-chat.service`, `scripts/deploy.sh` — guarded systemd flow.
- `scripts/deploy.ps1`, `scripts/start.ps1`, `scripts/service-watchdog.ps1`,
  `scripts/install-scheduled-task.ps1` — guarded Windows flow.
- `scripts/pack.ps1`, `scripts/package-release.mjs` — verified snapshots and release preflight.
- `tests/start-script-healthcheck.test.js`,
  `tests/deploy-script-scheduled-task.test.js` — updated Windows contracts.
- `README.md` — systemd, PM2, Windows, backup, restore, and troubleshooting user flows.

## Task 1: Standardize Node.js 24

**Files:**
- Create: `.node-version`
- Create: `.npmrc`
- Create: `tests/runtime-version-config.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/playwright.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `README.md:7-11`

- [ ] **Step 1: Write the failing runtime baseline contract**

Create `tests/runtime-version-config.test.js` using `node:test`. Parse
`package.json`, `.node-version`, `.npmrc`, and both workflow files, and assert:

```js
assert.equal(pkg.engines.node, '>=24 <25');
assert.equal(nodeVersion.trim(), '24');
assert.match(npmrc, /^engine-strict=true$/m);
assert.doesNotMatch(playwrightWorkflow, /node-version:\s*(20|22)\b/);
assert.doesNotMatch(releaseWorkflow, /node-version:\s*(20|22)\b/);
assert.match(readme, /\*\*Node\.js\*\* 24\.x/);
```

- [ ] **Step 2: Run the test and confirm the current mixed baseline fails**

Run: `node --test tests/runtime-version-config.test.js`

Expected: FAIL because `engines`, `.node-version`, and `.npmrc` are absent and
the workflows use Node 20/22.

- [ ] **Step 3: Add the enforced baseline**

Set `.node-version` to `24`, `.npmrc` to `engine-strict=true`, add:

```json
"engines": {
  "node": ">=24 <25",
  "npm": ">=10"
}
```

Run `npm install --package-lock-only` under Node 24, update both workflows to
`node-version: 24`, and change the README prerequisite to Node 24.x.

- [ ] **Step 4: Verify and commit**

Run:

```bash
node --test tests/runtime-version-config.test.js
npm install --package-lock-only --ignore-scripts
```

Expected: PASS and no lockfile drift after the second command.

Commit:

```bash
git add .node-version .npmrc package.json package-lock.json .github/workflows README.md tests/runtime-version-config.test.js
git commit -m "build: standardize runtime on Node 24"
```

## Task 2: Add Structured Safety Errors and Operation Leases

**Files:**
- Create: `scripts/lib/safety-errors.mjs`
- Create: `scripts/lib/runtime-safety.mjs`
- Create: `tests/runtime-safety.test.mjs`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing tests for errors, path validation, and leases**

Use temporary project roots and assert:

```js
const failure = createSafetyFailure('NODE_VERSION_MISMATCH', {
  stage: 'runtime',
  serviceState: 'running',
  dataState: 'unchanged',
  details: { expected: '24.x', actual: '22.0.0' },
});
assert.match(renderFailure(failure, 'systemd'), /activate Node\.js 24/i);
assert.match(renderFailure(failure, 'systemd'), /old service is still running/i);
assert.doesNotMatch(renderFailure(failure, 'systemd'), /secret-value/);

const lease = acquireOperationLease(projectRoot, 'test-owner');
assert.throws(() => acquireOperationLease(projectRoot, 'second-owner'), /OPERATION_IN_PROGRESS/);
releaseOperationLease(projectRoot, lease.operationId);
```

Also cover a root with spaces/Unicode, wrong root markers, mismatched operation
IDs, a live owner PID, and reclaiming a dead stale lease.

- [ ] **Step 2: Run tests and confirm missing-module failures**

Run: `node --test tests/runtime-safety.test.mjs`

Expected: FAIL with module-not-found for `scripts/lib/safety-errors.mjs`.

- [ ] **Step 3: Implement stable failures**

Export:

```js
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
```

`createSafetyFailure` must require `stage`, `serviceState`, and `dataState`.
`renderFailure` must output “What failed”, “Service state”, “Data state”,
“Backup state”, numbered “Next actions”, and manager-specific diagnostics.

- [ ] **Step 4: Implement project validation and lease lifecycle**

Use `.agents-chat-operation.json` in the project root with exclusive `wx`
creation and `{ operationId, pid, owner, startedAt }`. Export:

```js
export function validateProjectRoot(projectRoot, { release = false } = {});
export function assertNode24(versions = process.versions, execPath = process.execPath);
export function acquireOperationLease(projectRoot, owner);
export function assertOperationLease(projectRoot, operationId);
export function releaseOperationLease(projectRoot, operationId);
```

Only reclaim a stale lease when the PID is absent and the timestamp is older
than 30 minutes. Add `.agents-chat-operation.json` and
`.agents-chat-storage.json` to `.gitignore`.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/runtime-safety.test.mjs`

Expected: all tests PASS.

Commit:

```bash
git add .gitignore scripts/lib/safety-errors.mjs scripts/lib/runtime-safety.mjs tests/runtime-safety.test.mjs
git commit -m "feat: add runtime safety errors and operation leases"
```

## Task 3: Implement WAL-safe Backup, Retention, and Restore

**Files:**
- Create: `lib/storage/databases.json`
- Create: `scripts/lib/database-backup.mjs`
- Create: `scripts/runtime-preflight.mjs`
- Create: `scripts/restore-databases.mjs`
- Create: `tests/database-backup.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing isolated database tests**

Create temp `chats.db` and `config.db`, enable WAL, insert committed rows
without manually checkpointing, then assert `createVerifiedBackup` copies both
rows. Add tests for corruption, missing expected files, partial output,
retention after 12 batches, lock timeout, and restore with stale `-wal/-shm`.

The public contract is:

```js
const batch = await createVerifiedBackup({
  projectRoot,
  operationId,
  retain: 10,
});
assert.equal(batch.databases.length, 2);
assert.equal(await readValue(batch.paths['chats.db']), 'chat-in-wal');

await restoreVerifiedBackup({
  projectRoot,
  operationId,
  batchPath: batch.path,
  serviceStopped: true,
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `node --test tests/database-backup.test.mjs`

Expected: FAIL because backup functions and registry do not exist.

- [ ] **Step 3: Implement the protected registry and online backup**

Set `lib/storage/databases.json` to:

```json
{
  "databases": [
    { "file": "chats.db", "requiredTables": ["chats", "user_prefs"] },
    { "file": "config.db", "requiredTables": ["agents", "nodes"] }
  ]
}
```

Open sources with `{ readonly: true, fileMustExist: true }`, use
`await source.backup(partialPath)`, reopen each result read-only, require
`PRAGMA quick_check` to return `ok`, then publish the batch directory. Use
`statfsSync` for a size-plus-25%-margin check and bounded busy retries. Set
Linux directories to `0700` and files to `0600`.

- [ ] **Step 4: Implement preflight and explicit restore CLIs**

`runtime-preflight.mjs` accepts:

```text
acquire-lease --project-root <path> --owner <name>
prepare --project-root <path> --operation-id <id>
check-only --project-root <path>
diagnose --project-root <path> --manager <systemd|pm2|windows>
release-lease --project-root <path> --operation-id <id>
```

It validates Node 24, `better-sqlite3`, root/data paths, instance state, source
`quick_check`, and backup verification. `restore-databases.mjs` requires
`--service-stopped --from <batch> --operation-id <id>`, validates first,
preserves current files, removes sidecars after stop confirmation, and rolls
back the first per-file rename if the second fails.

Add package scripts:

```json
"test:safety": "node --test tests/runtime-safety.test.mjs tests/database-backup.test.mjs",
"diagnose": "node scripts/runtime-preflight.mjs diagnose"
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test:safety
node scripts/runtime-preflight.mjs diagnose --project-root "$PWD" --manager systemd
```

Expected: tests PASS; diagnose prints Node/ABI/root/database status without
changing live files.

Commit:

```bash
git add lib/storage/databases.json scripts/lib/database-backup.mjs scripts/runtime-preflight.mjs scripts/restore-databases.mjs tests/database-backup.test.mjs package.json package-lock.json
git commit -m "feat: add verified SQLite backup and restore"
```

## Task 4: Add Storage Health and Explicit API Failures

**Files:**
- Create: `lib/storage/storagePaths.ts`
- Create: `lib/storage/storageErrors.ts`
- Create: `lib/storage/storageHealth.ts`
- Create: `app/api/health/storage/route.ts`
- Create: `tests/storage-health.test.ts`
- Modify: `lib/chatStore.ts`
- Modify: `lib/configStore.ts`
- Modify: `lib/scheduler/scheduleStore.ts`
- Modify: `lib/workflowStore.ts`
- Modify: `app/api/chats/route.ts`
- Modify: `app/api/acp/route.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing health/error tests**

Test fresh initialization, established healthy files, missing expected file,
wrong schema, corrupt file, and error mapping:

```ts
assert.deepEqual(await checkStorageHealth({ projectRoot, initialize: true }), { ok: true });
assert.equal((await checkStorageHealth({ projectRoot, initialize: false })).ok, true);
assert.equal((await checkStorageHealth({ projectRoot: missingRoot, initialize: false })).code, 'DATABASE_MISSING');
assert.equal(toStorageErrorResponse(new Error('database disk image is malformed')).status, 503);
assert.equal(isStorageError(new Error('validation failed')), false);
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx tsx --test tests/storage-health.test.ts`

Expected: FAIL because storage modules are absent.

- [ ] **Step 3: Implement canonical paths and health**

`storagePaths.ts` exports canonical project/data/database/state paths.
`storageHealth.ts` checks `.agents-chat-storage.json` before opening stores.
On a fresh instance only, call exported `getDb()` and `getConfigDb()` to create
canonical schemas, run lightweight required-table reads, and atomically record
expected files. Export `getConfigDb` from `configStore.ts`; change all stores
to consume canonical paths or the shared `chats.db` path.

- [ ] **Step 4: Add health route and API boundary mapping**

Install the repository-local TypeScript test runner used by this focused test:

```bash
npm install --save-dev tsx
```

The route returns only:

```ts
return result.ok
  ? NextResponse.json({ ok: true })
  : NextResponse.json({ ok: false, error: 'storage_unavailable' }, { status: 503 });
```

Wrap chat route handlers and the ACP top-level catch with
`toStorageErrorResponse`; preserve 400/401/403/404 application errors. Log the
safe code and runtime metadata, never SQL, rows, environment values, or paths
in responses.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx tsx --test tests/storage-health.test.ts
npx tsc --noEmit
```

Expected: PASS.

Commit:

```bash
git add lib/storage app/api/health app/api/chats/route.ts app/api/acp/route.ts lib/chatStore.ts lib/configStore.ts lib/scheduler/scheduleStore.ts lib/workflowStore.ts tests/storage-health.test.ts package.json package-lock.json
git commit -m "feat: add storage health and explicit API failures"
```

## Task 5: Preserve UI State During Storage Failure

**Files:**
- Create: `app/features/layout/components/StorageUnavailableBanner.tsx`
- Create: `tests/storage-unavailable.spec.ts`
- Modify: `app/features/chat/chatApi.ts`
- Modify: `app/features/chat/runtime/useAgentRegistry.ts`
- Modify: `app/features/chat/runtime/useChatRuntime.ts`
- Modify: `app/features/chat/runtime/chatPersistenceService.ts`
- Modify: `app/features/chat/ChatPageClient.tsx`
- Modify: `app/features/layout/components/ChatShell.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Write failing Playwright behavior**

First return one known chat from `/api/chats`, then switch the route handler to
HTTP 503 before invoking Retry so preservation can be observed:

```ts
await page.route('**/api/chats**', route => route.fulfill({
  status: 503,
  contentType: 'application/json',
  body: JSON.stringify({ ok: false, error: 'storage_unavailable' }),
}));
await expect(page.getByRole('alert')).toContainText('Stored chats and agent configuration are temporarily unavailable');
await expect(page.getByText('Previously loaded chat')).toBeVisible();
```

Also assert retry triggers fresh requests and a later 200 response dismisses
the banner without reloading the page.

- [ ] **Step 2: Run the targeted E2E test and confirm failure**

With the app running on port 3010, run:

```bash
npx playwright test --config tests/playwright.config.ts tests/storage-unavailable.spec.ts
```

Expected: FAIL because no alert is rendered and failures are swallowed.

- [ ] **Step 3: Add typed client failure propagation**

Add `StorageUnavailableError` and `isStorageUnavailableResult` to `chatApi.ts`.
`useAgentRegistry` exposes `storageError` and does not call `setAgents([])` on
503. `useChatRuntime` exposes the same state for initial history/load/save and
does not replace existing history/messages on failure. Replace silent catches
in persistence paths with the shared callback while retaining existing data.

- [ ] **Step 4: Render the persistent actionable banner**

`StorageUnavailableBanner` uses `role="alert"` and shows:

```text
Stored chats and agent configuration are temporarily unavailable.
Your existing data has not been replaced. Ask the server operator to run
`npm run diagnose`, then retry.
```

Provide Retry and Dismiss controls. Wire it through `ChatShell` as a slot so
`ChatPageClient` remains composition-only. Use existing global CSS conventions;
do not add CSS modules or Tailwind.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npx tsc --noEmit
npx playwright test --config tests/playwright.config.ts tests/storage-unavailable.spec.ts
```

Expected: PASS.

Commit:

```bash
git add app/features tests/storage-unavailable.spec.ts
git commit -m "feat: surface storage outages without clearing chat state"
```

## Task 6: Add the Managed Server Launcher and Build Guard

**Files:**
- Create: `scripts/start-server.mjs`
- Create: `tests/managed-start.test.mjs`
- Modify: `package.json`
- Modify: `instrumentation.ts`
- Modify: `ecosystem.config.js`

- [ ] **Step 1: Write failing launcher/build tests**

Inject a fake child command and assert preflight occurs first, exit codes are
preserved, and SIGTERM is forwarded. Add a source contract asserting
`instrumentation.ts` exits during `NEXT_PHASE=phase-production-build`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/managed-start.test.mjs`

Expected: FAIL because `scripts/start-server.mjs` does not exist.

- [ ] **Step 3: Implement the launcher**

The launcher calls `checkRuntimeAndStorage({ mode: 'check-only' })`, resolves
the effective port once, then spawns:

```js
const child = spawn(process.execPath, [nextBin, 'start', '--port', String(port)], {
  cwd: projectRoot,
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
```

Set `npm start` to this launcher. Configure PM2 with `script:
'scripts/start-server.mjs'`, `interpreter: process.execPath`, one fork instance,
and the existing cwd/env.

- [ ] **Step 4: Guard build instrumentation**

At the start of `register()`:

```ts
if (process.env.NEXT_PHASE === 'phase-production-build') return;
if (process.env.NEXT_RUNTIME !== 'nodejs') return;
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test tests/managed-start.test.mjs
npm run build
```

Expected: PASS; build does not create or modify database files.

Commit:

```bash
git add scripts/start-server.mjs tests/managed-start.test.mjs package.json package-lock.json instrumentation.ts ecosystem.config.js
git commit -m "feat: guard the managed server runtime"
```

## Task 7: Implement Linux systemd and PM2 Safe Restart

**Files:**
- Create: `scripts/safe-restart.sh`
- Create: `tests/safe-restart-scripts.test.js`
- Modify: `scripts/deploy.sh`
- Modify: `scripts/agents-chat.service`
- Modify: `ecosystem.config.js`

- [ ] **Step 1: Write failing script-order contracts**

Assert the Linux scripts:

```js
assertBefore(deploy, 'runtime-preflight.mjs acquire-lease', 'npm ci');
assertBefore(deploy, 'npm ci', 'runtime-preflight.mjs prepare');
assertBefore(deploy, 'runtime-preflight.mjs prepare', 'npm run build');
assertBefore(deploy, 'npm run build', 'systemctl restart');
assert.match(unit, /ExecStartPre=.*runtime-preflight\.mjs check-only/);
assert.match(unit, /ExecStart=.*node.*scripts\/start-server\.mjs/);
assert.match(safeRestart, /systemd\|pm2/);
assert.match(safeRestart, /pm2 save/);
```

Add fixtures/mocks so executing the wrapper proves a failed preflight never
calls `systemctl` or `pm2`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node --test tests/safe-restart-scripts.test.js`

Expected: FAIL because the wrapper and unit guard are absent.

- [ ] **Step 3: Implement systemd orchestration**

Use `set -euo pipefail` and a trap that releases only the current operation ID.
Detect active PM2 conflict, run prepare while the old service is active, build,
render the validated absolute Node path into the unit, restart, and poll
`/api/health/storage`. On failure call `renderFailure` with actual
service/data/backup state and print `systemctl`/`journalctl` commands.

- [ ] **Step 4: Implement PM2 orchestration**

Require exactly one fork instance, reject active systemd, run prepare, use
`pm2 startOrReload ecosystem.config.js --only agents-chat --update-env`, verify
the interpreter/runtime and storage health, then `pm2 save`. Never stop the
other manager automatically.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test tests/safe-restart-scripts.test.js
bash -n scripts/deploy.sh scripts/safe-restart.sh
```

Expected: PASS.

Commit:

```bash
git add scripts/deploy.sh scripts/safe-restart.sh scripts/agents-chat.service ecosystem.config.js tests/safe-restart-scripts.test.js
git commit -m "feat: add safe systemd and PM2 restart flows"
```

## Task 8: Implement Windows Safe Deployment and Restart

**Files:**
- Create: `scripts/safe-restart.ps1`
- Modify: `scripts/deploy.ps1`
- Modify: `scripts/start.ps1`
- Modify: `scripts/service-watchdog.ps1`
- Modify: `scripts/install-scheduled-task.ps1`
- Modify: `tests/start-script-healthcheck.test.js`
- Modify: `tests/deploy-script-scheduled-task.test.js`
- Modify: `tests/safe-restart-scripts.test.js`

- [ ] **Step 1: Extend failing Windows contracts**

Assert `npm ci` replaces `npm install`, prepare/backup and build occur before
`Stop-ScheduledTask`, `start.ps1` performs check-only but no build, the
watchdog uses the installed Node path, and no code kills arbitrary port owners.

- [ ] **Step 2: Run contracts and confirm current behavior fails**

Run:

```bash
node tests/start-script-healthcheck.test.js
node tests/deploy-script-scheduled-task.test.js
node --test tests/safe-restart-scripts.test.js
```

Expected: FAIL on current install/build/kill behavior.

- [ ] **Step 3: Implement graceful task ownership**

Make the stop marker request watchdog shutdown, wait for its tracked child
tree, and only force that owned tree after timeout. If the port remains owned,
throw `PORT_IN_USE` with PID inspection commands. Store the validated Node 24
absolute path in the task action/environment rather than hard-coded user PATH.

- [ ] **Step 4: Implement deploy and restart flows**

`deploy.ps1` performs `npm ci`, prepare/backup, build, graceful stop, task start,
and storage health. `safe-restart.ps1` omits pull/install/build. Both keep the
operation ID in `try/finally`, render structured failures, and preserve
verified backup paths. `start.ps1` serves an existing build and fails with a
deploy instruction if `.next` is absent.

- [ ] **Step 5: Verify and commit**

Run the three tests from Step 2. On Windows CI additionally run:

```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\safe-restart.ps1), [ref]$null, [ref]$errors
) | Out-Null
if ($errors.Count) { throw ($errors -join "`n") }
```

Expected: all contracts and PowerShell parsing PASS.

Commit:

```bash
git add scripts/deploy.ps1 scripts/safe-restart.ps1 scripts/start.ps1 scripts/service-watchdog.ps1 scripts/install-scheduled-task.ps1 tests
git commit -m "feat: add safe Windows restart flow"
```

## Task 9: Make Packaging and Releases Storage-safe

**Files:**
- Modify: `scripts/pack.ps1`
- Modify: `scripts/package-release.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `tests/safe-restart-scripts.test.js`
- Create: `tests/release-runtime-smoke.test.mjs`

- [ ] **Step 1: Write failing package contracts**

Assert `pack.ps1` invokes verified backup and packages both snapshot databases,
never live `.data\chats.db`. Assert release output includes preflight and its
required ESM/JSON files but excludes `.data`, `.env.local`, state, and leases.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
node --test tests/safe-restart-scripts.test.js tests/release-runtime-smoke.test.mjs
```

Expected: FAIL because current pack copies a live DB and release lacks safety
files.

- [ ] **Step 3: Update pack and release generation**

Have `pack.ps1` acquire a lease, create a verified batch, and copy
`chats.db`/`config.db` from that batch. Update generated release launchers to
run check-only before `server.js`; copy only the safety runtime, database
registry, and public release metadata.

- [ ] **Step 4: Add per-OS release smoke checks**

In each release matrix job, unpack the artifact, run preflight with Node 24,
start on an ephemeral port, call `/api/health/storage`, stop the exact PID, and
fail if `.data`, backups, `.env.local`, or project state files are present in
the archive before first launch.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test tests/safe-restart-scripts.test.js tests/release-runtime-smoke.test.mjs
npm run build
node scripts/package-release.mjs
```

Expected: PASS and release contents contain no local data.

Commit:

```bash
git add scripts/pack.ps1 scripts/package-release.mjs .github/workflows/release.yml tests
git commit -m "fix: make release and transfer packaging storage-safe"
```

## Task 10: Document User Flows and Troubleshooting

**Files:**
- Modify: `README.md:27-130`

- [ ] **Step 1: Write a failing documentation contract**

Extend `tests/safe-restart-scripts.test.js` to require:

```js
assert.match(readme, /sudo \.\/scripts\/safe-restart\.sh systemd/);
assert.match(readme, /\.\/scripts\/safe-restart\.sh pm2/);
assert.match(readme, /\.\\scripts\\safe-restart\.ps1/);
assert.match(readme, /\.data\/backups/);
assert.match(readme, /latest 10/i);
assert.match(readme, /off-host/i);
assert.match(readme, /NATIVE_ADDON_INCOMPATIBLE/);
assert.match(readme, /storage_unavailable/);
```

- [ ] **Step 2: Run the contract and confirm failure**

Run: `node --test tests/safe-restart-scripts.test.js`

Expected: FAIL because the documented safe flows do not exist.

- [ ] **Step 3: Update README deployment sections**

Document these primary commands:

```bash
sudo ./scripts/deploy.sh
sudo ./scripts/safe-restart.sh systemd
./scripts/safe-restart.sh pm2
```

```powershell
.\scripts\deploy.ps1
.\scripts\safe-restart.ps1
```

Explain direct manager commands are guarded emergency fallbacks without a
guaranteed pre-stop backup. Document backup location/retention/permissions,
diagnose/list/restore flow, manager logs, effective ports, and off-host backup
limitations.

- [ ] **Step 4: Add troubleshooting table**

For every stable failure category, include cause, whether the old service/data
remain safe, and exact Linux/PM2/Windows next actions. Include the rule that
users must not delete/recreate `.data`, copy a live `.db`, or restore before
stopping the owning service.

- [ ] **Step 5: Verify and commit**

Run: `node --test tests/safe-restart-scripts.test.js`

Expected: PASS.

Commit:

```bash
git add README.md tests/safe-restart-scripts.test.js
git commit -m "docs: add safe restart and recovery runbook"
```

## Task 11: Full Verification and Failure Drills

**Files:**
- Modify only files required by failures found in this task.

- [ ] **Step 1: Run static and focused safety validation**

```bash
npm run test:safety
node --test tests/runtime-version-config.test.js tests/managed-start.test.mjs tests/safe-restart-scripts.test.js tests/release-runtime-smoke.test.mjs
npx tsx --test tests/storage-health.test.ts
npx tsc --noEmit
```

Expected: all PASS.

- [ ] **Step 2: Run production build**

Run: `npm run build`

Expected: PASS without changing live database mtimes or starting scheduler
jobs.

- [ ] **Step 3: Run targeted Playwright coverage**

With the app running on localhost:3010:

```bash
npx playwright test --config tests/playwright.config.ts tests/storage-unavailable.spec.ts tests/test-ui.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Perform isolated failure drills**

Against a temporary project/data root, verify:

1. Node mismatch exits with `NODE_VERSION_MISMATCH`.
2. An invalid native module exits with `NATIVE_ADDON_INCOMPATIBLE`.
3. Missing expected DB exits with `DATABASE_MISSING` without creating a file.
4. Corrupt DB exits with `DATABASE_INTEGRITY_FAILED`.
5. Backup disk/permission simulation exits before manager invocation.
6. WAL rows survive backup and explicit restore.
7. The 11th backup removes only the oldest complete batch.
8. Every message states service, data, backup, actions, and diagnostics.

Expected: each failure is non-zero, actionable, and leaves fixtures in the
documented state.

- [ ] **Step 5: Inspect final diff and commit fixes**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Fix only issues caused by this implementation. If verification required
changes, commit:

```bash
git add -u
git commit -m "test: verify safe restart recovery flows"
```
