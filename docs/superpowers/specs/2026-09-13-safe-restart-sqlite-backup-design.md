# Safe Restart and SQLite Backup Design

## Context

The application uses the native `better-sqlite3` package for two production
databases:

- `.data/chats.db` stores chat history, shares, comments, workflows, schedules,
  and related state.
- `.data/config.db` stores agents, nodes, user settings, and agent environment
  variables.

The September 2026 incident was not caused by deleted or corrupted databases.
Dependencies had been installed under Node.js 20 (ABI 115), while
`pm2 restart agents-chat --update-env` launched the application under Node.js
24 (ABI 137). The native addon could not load, database-backed API requests
failed, and the UI appeared to have lost all configuration and history. Once
`better-sqlite3` was rebuilt for the active Node runtime, the original data was
readable again.

The current repository does not prevent this failure:

- `package.json` does not enforce a Node version.
- CI uses both Node 20 and Node 22.
- PM2 launches `npm`, so a changed `PATH` can select a different Node runtime.
- systemd records an npm path but has no pre-start runtime or database check.
- Windows Scheduled Task startup has a hard-coded Node path and no native-addon
  check.
- Existing health checks call `/api/auth/providers`, which does not exercise
  SQLite.
- There is no automatic, verified SQLite backup policy.
- `scripts/pack.ps1` copies only `chats.db` and can miss committed WAL data.

## Goals

1. Standardize production, CI, PM2, systemd, Windows, and release builds on
   Node.js 24.x.
2. Detect Node/native-addon mismatches before stopping a healthy service.
3. Detect missing, inaccessible, or corrupt production databases instead of
   silently presenting an empty application.
4. Create and verify a consistent backup before every supported deployment or
   restart, retaining the latest 10 complete backup batches.
5. Give PM2, systemd, and Windows Scheduled Task users one documented safe
   restart path per platform.
6. Retain startup guards when users bypass the recommended wrapper.
7. Test failure paths without touching the developer's or production `.data`
   directory.
8. Make every failed restart explain what failed, whether the previous service
   and data are safe, and the exact next actions an operator can take.

## Non-goals

- The local backup set is not an off-host disaster recovery system.
- The design does not provide zero-downtime deployment.
- It does not automatically restore a database after startup failure.
- It does not make multiple PM2 instances or multiple hosts sharing one SQLite
  directory a supported topology.
- It does not make snapshots of `chats.db` and `config.db` one cross-database
  transaction. The application has no cross-database transactional invariant;
  each file is independently consistent.

## Runtime Baseline

Node.js 24.x is the only supported application and build runtime.

- Add `.node-version` with major version `24`.
- Add `engines.node` to `package.json`.
- Add `.npmrc` with `engine-strict=true`, because `engines` alone only warns.
- Change Playwright and release workflows to Node 24.
- Validate `process.versions.node`, `process.versions.modules`, `process.execPath`,
  platform, and architecture during preflight.
- Continue to validate the actual `better-sqlite3` load. Matching a Node major
  is necessary but does not prove that a native binary matches the ABI,
  platform, or architecture.

All diagnostics may log runtime metadata and resolved data paths, but must not
log environment variable values, agent secrets, or database contents.

## Shared Safety Commands

Cross-platform behavior belongs in focused Node scripts. Bash and PowerShell
wrappers only perform platform-specific service management.

### Runtime preflight

`scripts/runtime-preflight.mjs` supports two modes:

- `prepare`: acquire the operation lock, validate runtime/storage, run full
  database checks, create and validate a backup, and return a verified batch.
- `check-only`: validate the runtime, expected storage state, and databases
  without creating a backup. This is used immediately before process startup.

The command performs these checks in order:

1. Confirm Node.js 24.x and print the executable, Node version, native module
   ABI, platform, and architecture.
2. Confirm the working directory is the project root using repository markers,
   or the generated release root using `RELEASE.txt` and `server.js`, not only
   the current folder name.
3. Resolve `.data` to an absolute path and reject unsafe or unexpected paths.
4. Confirm the data and backup directories have restrictive permissions and
   are writable.
5. Load `better-sqlite3` and successfully open an in-memory database.
6. For every existing protected database, open it without allowing implicit
   creation and run `PRAGMA quick_check`.
7. Compare the live files with an untracked `.agents-chat-storage.json` record
   in the project root. The record deliberately lives outside `.data`, so
   deletion of the entire data directory is still detectable. A fresh install
   may have no databases; after a successful initialized startup, a previously
   expected database that disappears is a hard failure.

The protected database list is centralized and initially contains `chats.db`
and `config.db`. A test scans production SQLite stores so a future third
database cannot be added without updating the protection list.

### Operation lock

Deployments, backups, restarts, and restores use one atomic cross-platform
operation lock in the project root. The lock is an operation lease: preflight
creates it with a random operation ID, every subsequent safety command requires
that ID, and the wrapper releases it in its final cleanup block. The lease
therefore covers dependency installation, backup, build, manager restart, and
post-start health verification rather than ending when the preflight process
exits.

- A second operation fails immediately with the owner PID and start time.
- Bash traps and PowerShell `finally` blocks release an owned lock on handled
  signals and normal exit.
- A stale lock is reclaimed only after its process is confirmed absent and its
  age exceeds the defined timeout.
- Locking is local-machine protection. A shared network filesystem deployment
  remains unsupported.

### Backup

Each successful backup is a complete batch:

```text
.data/backups/20260913T143000Z-<random>/
  chats.db
  config.db
  manifest.json
```

The backup implementation:

1. Checks available disk space against the current database sizes with a safety
   margin and verifies directory permissions.
2. Uses the `better-sqlite3` online backup API. It never copies a live `.db`
   file directly, so committed WAL data is included.
3. Applies bounded busy retries. A long transaction or lock eventually causes
   a clear failure while the old service remains running.
4. Writes each output with a `.partial` suffix.
5. Opens each candidate backup and requires `PRAGMA quick_check` to return
   `ok`.
6. Writes a manifest containing only batch time, runtime metadata, protected
   filenames, sizes, and validation results.
7. Atomically publishes the batch only after every expected database and the
   manifest pass validation.
8. Retains the newest 10 complete batches. Partial or invalid batches never
   count as recoverable backups and are never selected for restore.

On a fresh installation, absent databases are recorded as not yet initialized;
the backup command does not create them merely to make a batch. The first
storage-health request may initialize schemas through the canonical stores and
then atomically records both files as expected in the project-root state file.
On rollout to an older installation, it records the files that already exist
and adds a newly initialized database after canonical initialization. Once a
file is expected, its disappearance is an error before any store is allowed to
recreate it. Add the state and operation-lock files to `.gitignore`.

Backups inherit restrictive storage permissions: `0700` directories and `0600`
files on Linux, and the existing protected data-directory ACL on Windows.
`config.db` backups contain agent environment values and must never be included
in Git, logs, or release artifacts.

### Restore

Restoration is explicit and never part of an automatic rollback.

`scripts/restore-databases.mjs --from <batch>`:

1. Requires the service to be stopped and an explicit confirmation flag.
2. Acquires the operation lock.
3. Validates the selected manifest and both backup databases.
4. Preserves the current database files as a recovery snapshot.
5. Removes or isolates stale `-wal` and `-shm` sidecars only after the service
   is confirmed stopped.
6. Atomically replaces each live database individually where the platform
   permits. Because two filesystem renames cannot form one transaction, it
   retains recoverable originals and rolls back the first replacement if the
   second fails.
7. Validates both restored files before declaring success.

The wrappers and README provide manager-specific stop, restore, and start
steps. An automatic restore is prohibited because writes may have occurred
after the pre-restart snapshot.

## Service-manager Flows

### Linux systemd

#### Deployment

The existing command remains:

```bash
sudo ./scripts/deploy.sh
```

The revised flow is:

1. Acquire the deployment lock.
2. Validate Node 24 before changing dependencies or service state.
3. Pull code unless disabled.
4. Run `npm ci` unless disabled. This is the step that can repair an addon
   installed for a different ABI. If it fails, report that the old process may
   still be serving but on-disk dependencies are incomplete and must not be
   restarted.
5. Validate the newly installed native addon, then run the complete storage
   preflight and verified pre-migration backup.
6. Run `npm run build` with application runtime initialization disabled.
7. Render the systemd unit with the validated absolute Node path and reload the
   unit.
8. Restart the service.
9. Let `ExecStartPre` run `runtime-preflight.mjs check-only` using the same Node
   executable as `ExecStart`.
10. Poll the storage-aware health endpoint on the effective application port.

`instrumentation.ts` must not start scheduler runtime or touch production
storage during `next build`.

#### Restart only

```bash
sudo ./scripts/safe-restart.sh systemd
```

This runs preflight and backup before invoking `systemctl restart`. Direct
`systemctl restart agents-chat` remains possible, and `ExecStartPre` prevents
an incompatible application from starting, but it cannot guarantee a backup
while the old process is still available. It is an emergency fallback, not the
documented routine path.

### PM2

```bash
./scripts/safe-restart.sh pm2
```

The wrapper:

1. Rejects a conflicting active systemd deployment.
2. Requires one fork-mode `agents-chat` instance.
3. Runs preflight and backup before stopping the process.
4. Starts or reloads from `ecosystem.config.js`, explicitly using the validated
   Node 24 executable and a managed JavaScript server launcher instead of
   relying on the `npm` shebang and mutable `PATH`.
5. Updates environment values, checks actual PM2 interpreter/runtime metadata,
   verifies storage health, and runs `pm2 save`.

The managed server launcher runs check-only before loading Next.js, so neither
`pm2 restart agents-chat --update-env` nor manual `npm start` can bypass the
guard. A direct restart can prevent a bad runtime from serving requests, but
cannot guarantee a pre-stop online backup.

### Windows Scheduled Task

#### Deployment

The existing elevated command remains:

```powershell
.\scripts\deploy.ps1
```

The revised flow is:

1. Validate the installed Node 24 executable and use `npm ci`.
2. Run complete preflight and backup while the existing task remains active.
3. Build the application before stopping the existing task.
4. Signal `service-watchdog.ps1` to stop its own process tree gracefully and
   wait for shutdown.
5. If the configured port remains occupied by an unrelated process, report its
   PID and abort instead of killing it.
6. Start the Scheduled Task.
7. Let `start.ps1` run check-only before server startup.
8. Poll the storage-aware health endpoint.

The Scheduled Task installer records the validated Node executable instead of
depending on a hard-coded `C:\Program Files\nodejs` or user-specific PATH.

#### Restart only

```powershell
.\scripts\safe-restart.ps1
```

The wrapper performs the same pre-stop backup and graceful Scheduled Task
restart without git pull, dependency installation, or a build. `start.ps1`
serves an existing production build and fails with instructions to run
`deploy.ps1` if that build is absent; watchdog recovery therefore does not
rebuild the application on every retry.

Starting the task manually remains a guarded fallback because `start.ps1`
performs check-only. It does not guarantee that an online backup was completed
before the previous process stopped.

The watchdog retains bounded exponential backoff when startup fails. A stable
preflight error is logged once per attempt so an ABI mismatch cannot create an
unbounded high-frequency restart/log loop.

## Port and Process Ownership

Startup and health checks use one shared effective-port rule per deployment.
The current Linux default is 3010 and Windows default is 3000; configured
overrides must affect both the launched server and health URL.

Service wrappers stop only processes they own. They do not kill an arbitrary
PID merely because it occupies the configured port. If another process owns
the port after a graceful stop, the operation fails with actionable
diagnostics.

Before restarting, wrappers detect conflicting managers. PM2 and systemd must
not run the same checkout simultaneously because they would duplicate agents,
schedulers, and port ownership even though SQLite itself serializes writes.

## Managed Server Launcher

Add one small JavaScript launcher used by `npm start`, PM2, systemd, and the
Windows scripts. It runs check-only under the exact Node process that will host
the app and only then loads the local Next.js server entry. This closes the gap
where a shell precheck succeeds under one `node` executable but a manager
starts the app under another.

The launcher forwards termination signals and preserves the server exit code.
Release launchers perform the equivalent check against the standalone bundle.

## Storage-aware Health

Add a Node-runtime route such as `GET /api/health/storage`.

The route:

- On an established instance, verifies expected files before calling stores,
  so a missing database cannot be silently recreated.
- On a genuinely fresh instance, initializes schemas through the canonical
  stores, verifies both databases, and records the initialized instance state.
- Executes bounded lightweight reads against required tables in both
  databases, thereby proving the native addon loads and the schema is usable.
- Returns HTTP 200 with a minimal `{ "ok": true }` response.
- Returns HTTP 503 with a stable generic error code on failure.
- Logs detailed errors server-side without paths, secrets, row values, or
  stack traces in the response.

Full `quick_check` remains a preflight and backup-validation operation. It is
not run on every watchdog poll, avoiding repeated whole-database scans.

## Application Failure Semantics

Startup prevention is not sufficient for storage that becomes unavailable
while the process is running. Add a shared storage-error classifier and use it
at database-backed API boundaries.

- Chat/config APIs return HTTP 503 with
  `{ "ok": false, "error": "storage_unavailable" }` for native-load, missing
  file, I/O, read-only, corrupt, or busy-timeout failures.
- Expected application errors such as not-found or invalid input keep their
  existing status codes and are not mislabeled as storage failures.
- The chat and agent clients preserve currently displayed data and show a
  persistent storage-unavailable error. They must not replace existing state
  with empty arrays after a failed request.
- Detailed causes are logged once with safe runtime metadata; responses do not
  expose filesystem paths, SQL, secrets, or stack traces.

## Release Bundles and Manual Packaging

Linux and Windows release jobs build under Node 24 on their target operating
systems. The packaging step includes the runtime check needed by generated
`start-release.sh` and `start-release.ps1`; it does not include live databases,
backup directories, or environment files.

The generated launchers use the effective port consistently and run check-only
before starting `server.js`.

`scripts/pack.ps1` must stop copying live `chats.db` directly. When history is
requested, it creates a verified SQLite snapshot through the shared backup
implementation and packages both databases from that snapshot. This prevents
WAL loss and includes configuration needed on the target machine.

## Error Handling

Every safety command emits a stable stage name and exits non-zero on failure.

- Failures before service stop leave the old service running.
- A failed backup never triggers restart.
- A failed build never triggers restart.
- A failed startup keeps the verified backup and prints the relevant
  `journalctl`, `pm2 logs`, or Windows log paths.
- A corrupt source database is not overwritten, automatically repaired, or
  represented as empty data.
- Cleanup failure after a valid backup is reported explicitly; no failure is
  converted into a success-shaped result.
- Ctrl+C and termination handlers release owned locks and retain completed
  backups.

## Operator-facing Failure Guidance

A failed restart must never end with only a stack trace, native loader error,
or generic message such as `health check failed`. Shared safety code returns a
structured failure object; Bash and PowerShell wrappers render the same
information in platform-appropriate commands.

Every terminal failure contains these fields in this order:

```text
SAFE RESTART FAILED [NATIVE_ADDON_INCOMPATIBLE]

What failed:
  better-sqlite3 cannot load under Node.js 24.20.0 (ABI 137).

Service state:
  The existing agents-chat service is still running. It was not restarted.

Data state:
  chats.db and config.db were not modified.

Next actions:
  1. Activate Node.js 24.
  2. Reinstall locked dependencies: npm ci
  3. Retry: sudo ./scripts/safe-restart.sh systemd

Diagnostics:
  node --version
  node -p "process.execPath + ' ABI=' + process.versions.modules"
  sudo journalctl -u agents-chat -n 100 --no-pager
```

The exact wording may vary by platform, but every failure must answer:

1. What failed, in plain language?
2. Did the restart begin, and is the old service still running?
3. Were the live databases modified?
4. Was a verified backup created, and where is its batch directory?
5. What safe commands should the user run next?
6. Where can the user find detailed logs?

### Stable failure categories

| Code | User-facing meaning | Required next-action guidance |
|---|---|---|
| `NODE_VERSION_MISMATCH` | The command is using an unsupported Node version or executable. | Show expected and actual versions/path; activate or install Node 24, then retry the same safe command. |
| `NATIVE_ADDON_INCOMPATIBLE` | `better-sqlite3` was built for another ABI/platform or cannot load. | Keep the old service running; activate Node 24, run `npm ci`, rerun preflight, then retry safe restart. |
| `INVALID_PROJECT_ROOT` | The command is running from the wrong checkout/directory. | Show the resolved non-sensitive path and the exact `cd` command for the configured project root. |
| `OPERATION_IN_PROGRESS` | Another deploy, backup, restart, or restore owns the lease. | Show owner PID/start time; wait for it, inspect the process, and only use the documented stale-lock command when the process is absent. |
| `DATABASE_MISSING` | A database expected on this initialized instance is absent. | Do not start an empty database; verify the configured data path, list backup batches, and follow the restore procedure. |
| `DATABASE_INTEGRITY_FAILED` | SQLite reported corruption or unreadable pages. | Do not restart or run migrations; preserve the live files, inspect available verified backups, and restore explicitly or escalate for recovery. |
| `DATABASE_BUSY` | A long transaction prevented validation or backup within the timeout. | Keep the service running; wait for active work to finish, inspect logs, then retry. Do not copy the live `.db` manually. |
| `BACKUP_NO_SPACE` | There is not enough free space for a verified batch. | Show required and available space; free space or move old backups through the supported cleanup command, then retry. |
| `BACKUP_PERMISSION_DENIED` | The service account cannot write or secure the backup directory. | Show the expected owner/mode or Windows account and provide the applicable permission inspection commands. |
| `BACKUP_VALIDATION_FAILED` | A candidate backup could not be reopened or failed `quick_check`. | Do not restart; retain the source database, identify the partial batch, and inspect logs before retrying. |
| `DEPENDENCY_INSTALL_FAILED` | `npm ci` did not complete. | State that the old process may still run but on-disk dependencies are incomplete; rerun `npm ci` successfully before any restart. |
| `BUILD_FAILED` | The production build failed. | State that no restart occurred, point to build output, fix the build, and rerun deployment. |
| `MANAGER_CONFLICT` | Another manager is already running the same checkout. | Show which managers are active and commands to inspect/stop the unintended one; never stop it automatically. |
| `PORT_IN_USE` | An unrelated process owns the configured port. | Show the PID and inspection command; require the user to identify and stop/reconfigure it rather than killing it automatically. |
| `SERVICE_START_FAILED` | The manager could not start the guarded process. | State whether a verified backup exists and show `systemctl`, PM2, or Scheduled Task status/log commands. |
| `STORAGE_HEALTH_FAILED` | The process started but real database reads failed. | Show backup batch, manager logs, safe stop command, and explicit restore/repair options; do not report deployment success. |
| `RESTORE_PRECONDITION_FAILED` | Restore was requested while the service may still hold the databases or the batch is invalid. | Show how to stop and verify the selected manager, then revalidate the batch. |

The structured object also carries `stage`, `serviceState`, `dataState`,
`backupBatch`, and a list of action IDs. Wrappers map action IDs to commands so
Linux systemd, PM2, and Windows users never receive irrelevant instructions.
Unexpected failures use `UNEXPECTED_ERROR` but still report known service/data
state and log locations; they do not expose raw secrets or SQL.

If failure occurs after the old process has stopped, the message must say so
prominently and prioritize the shortest non-destructive recovery path:

1. Inspect the manager/startup logs.
2. Correct a runtime/configuration problem and retry guarded start.
3. Restore only when storage validation proves the live database is unusable
   and the operator has selected a verified batch.

README troubleshooting tables reproduce these categories in shorter form. The
safe scripts also support a non-mutating diagnostics command, for example
`runtime-preflight.mjs diagnose`, so users can rerun checks without attempting
a restart or creating another backup.

## Testing

Tests use temporary directories and isolated databases.

### Node safety tests

Use the built-in `node:test` runner to cover:

- Node-major rejection and successful native-addon loading.
- Project-root and data-path validation, including spaces and Unicode.
- Fresh install with no database files.
- Detection of a previously expected but missing database.
- `quick_check` rejection of a corrupt database.
- WAL data present in a verified backup before checkpoint.
- Simultaneous writes during online backup.
- Both protected databases and manifest contents.
- Partial backup cleanup and atomic publication.
- Busy timeout, unwritable directory, and insufficient-space failures.
- Retention of exactly the newest 10 complete batches.
- Concurrent operation rejection and stale-lock recovery.
- Restore validation and correct handling of `-wal`/`-shm`.
- Health helper success, missing database, bad schema, and corrupt database.
- Storage-error classification without swallowing unrelated application
  errors.
- Stable operator-facing failures include service state, data state, backup
  state, platform-correct actions, and log commands.
- Failure rendering never includes secrets, SQL text, or database row values.
- A guard that every production SQLite file belongs to the protected list.

### Script contract tests

Extend existing lightweight script tests to verify:

- Linux deploy runs backup before build and restart.
- systemd uses the validated runtime and `ExecStartPre`.
- PM2 avoids an indirect npm interpreter and persists updated configuration.
- Windows deploy uses `npm ci`, backs up before stopping, and does not kill an
  unrelated port owner.
- Windows `start.ps1` runs check-only before Next.js.
- Windows watchdog restarts do not rebuild an existing deployment.
- Both safe-restart wrappers call the common safety implementation and the
  correct manager.
- Representative failures render actionable Linux systemd, PM2, and Windows
  instructions and preserve the original non-zero exit code.
- Build-time instrumentation does not initialize scheduler storage.
- The managed launcher executes preflight under the same Node process that
  loads Next.js and forwards termination correctly.

### Integration and release tests

- Add an API test for 200/503 storage health responses.
- Add API and UI coverage proving storage failure is shown as unavailable and
  does not become an empty chat/configuration state.
- Exercise a safe restart against a temporary test service where practical.
- On both release workflow operating systems, unpack the generated artifact,
  run its runtime preflight under Node 24, and smoke-start the standalone
  server.
- Validate recovery by writing known rows, creating a backup, replacing the
  live files, restoring the batch, and reading the original rows.

## Documentation

Update the root README:

- Require Node.js 24.x instead of `>= 20`.
- Document the Windows deployment and restart-only flows.
- Update **Deployment (Linux systemd)** with deployment, safe restart, direct
  command fallback, health behavior, logs, and restore guidance.
- Add the PM2 safe restart flow and warn against routine direct
  `pm2 restart ... --update-env`.
- Explain backup location, 10-batch retention, sensitive contents, restore
  prerequisites, and the lack of off-host disaster recovery.
- Add a troubleshooting table mapping stable failure codes to plain-language
  causes, service/data safety, diagnostic commands, and recovery actions.
- Correct port override documentation so it matches actual startup behavior.

## User Flows

### Linux systemd

```bash
# Deploy code and dependencies safely.
sudo ./scripts/deploy.sh

# Restart only, including environment changes.
sudo ./scripts/safe-restart.sh systemd

# Inspect failures.
sudo systemctl status agents-chat
sudo journalctl -u agents-chat -n 100 --no-pager
```

### PM2

```bash
# Restart safely and refresh environment.
./scripts/safe-restart.sh pm2

# Inspect failures.
pm2 describe agents-chat
pm2 logs agents-chat --lines 100
```

### Windows

```powershell
# Deploy code and dependencies safely.
.\scripts\deploy.ps1

# Restart only, including environment changes.
.\scripts\safe-restart.ps1

# Inspect the Scheduled Task and service logs.
Get-ScheduledTask -TaskName Agents-Chat-Startup
Get-Content .\logs\service-watchdog.log -Tail 100
Get-Content .\logs\start-service-child.err.log -Tail 100
```

Direct manager commands retain startup guards but are documented as emergency
fallbacks because they cannot guarantee a pre-stop online backup.
