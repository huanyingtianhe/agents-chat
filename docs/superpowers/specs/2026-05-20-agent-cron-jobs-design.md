# Agent Cron Jobs — Design

## Problem

Users want agents to run automatically on a schedule (e.g. a daily summary, an hourly check) without manually opening a chat. Today every agent invocation requires a live chat session in the browser.

## Goals (v1)

- Schedule a fixed prompt to run against a chosen agent on a recurring timer.
- Runs execute silently on the server; no chat-UI integration.
- Persist run history (status, reply, error, raw transcript) for later review.
- Friendly schedule UX (presets + custom interval); no raw cron expressions exposed to users.
- Manage schedules from a new top-level "Schedules" panel in the right sidebar.

## Non-Goals (v1)

- Notifications, webhooks, or posting results back into a chat.
- Multi-step orchestration / chaining jobs.
- Per-run model override (always use the agent's default model).
- Per-job timeout configuration (uses a single constant).
- Cross-server / clustered scheduling.

## Permissions

Anyone with `canTalk` access to a target agent may create / edit / delete / run-now its schedules and view its run history. Admins are always allowed.

## UX

### Schedules panel (right sidebar)

A new toggle button in the sidebar header opens a "Schedules" panel alongside Agents / Nodes.

- Lists all jobs visible to the current user, grouped by agent name.
- `+ New` button opens the editor modal.
- Each job row shows: name, status dot (green=enabled, gray=disabled, red=last run errored), friendly schedule summary, next fire time in the browser's local timezone, and inline actions: Run now · Toggle enabled · Edit · Delete.
- Clicking a row expands its run history (last 100, paginated 20 at a time). Clicking a run opens a drawer with the assistant reply and a collapsible raw NDJSON transcript.
- Empty state: "No schedules yet. Create one to run an agent on a timer."

### Editor modal

Fields:

- **Name** (text)
- **Agent** (dropdown, restricted to agents the user can talk to)
- **Prompt** (multiline)
- **Schedule** (one of):
  - Every `[N]` `[minutes / hours / days]`
  - Daily at `[HH:MM]` (user enters local time)
  - Weekly on `[weekday]` at `[HH:MM]` (user enters local time)
- **Enabled** toggle
- Live preview: "Next 3 fires: …" in browser-local time, plus "Stored as: `cron <expr>` (UTC)" for transparency.
- Save / Cancel using the existing dialog button styles.

The agent's default model is always used; there is no model override.

### Timezone

Storage is UTC. All display is converted to the browser's local timezone via `Intl.DateTimeFormat`. Editor inputs are local → converted to UTC on save.

## Architecture

### Approach (chosen)

In-process scheduler driven by `node-cron` inside the Next.js server. A singleton boots once via Next's `instrumentation.ts`, loads enabled jobs from SQLite, runs a backfill sweep for missed ticks, and registers each job with `node-cron` (TZ = `'UTC'`). Job execution reuses the existing ACP machinery (`app/api/acp/route.ts`) through an extracted server-side runner that does not require an SSE consumer.

### Alternatives considered

- **Separate worker process** — survives Next restarts independently but adds process-management complexity on Windows. Rejected for v1.
- **External Windows Scheduled Task hitting an internal endpoint** — clashes with cross-platform deployment, harder to test locally. Rejected.

### Module layout

- `app/features/scheduler/`
  - `components/SchedulesPanel.tsx` — sidebar panel + job list grouped by agent.
  - `components/ScheduleEditor.tsx` — create/edit modal with friendly schedule builder.
  - `components/RunHistory.tsx` — expandable run list + run-detail drawer.
  - `hooks/useSchedules.ts` — client data hook (fetch + mutate jobs and runs).
  - `scheduleTypes.ts` — `CronJob`, `CronRun`, `ScheduleSpec` types.
  - `scheduleSpec.ts` — pure helpers: friendly spec ↔ cron expression, local ↔ UTC conversions, "next N fires" preview, validation.
- `lib/scheduler/`
  - `scheduleStore.ts` — `better-sqlite3` CRUD for `cron_jobs` and `cron_runs` in `.data/chats.db`.
  - `schedulerRuntime.ts` — singleton: load + register jobs, backfill sweep, per-job FIFO queue, orphan recovery, retention pruning.
  - `agentRunner.ts` — extracted from `app/api/acp/route.ts`: spawn an agent, drive a single prompt to completion server-side, collect transcript and final reply text. Used by both the SSE chat route and the scheduler.
- API routes (each handler stays thin — parse, authorize, delegate to `lib/scheduler/`):
  - `app/api/schedules/route.ts` — `GET` list, `POST` create.
  - `app/api/schedules/[id]/route.ts` — `GET` (job + recent runs summary), `PATCH`, `DELETE`.
  - `app/api/schedules/[id]/runs/[runId]/route.ts` — `GET` full run (reply + raw log).
  - `app/api/schedules/[id]/run/route.ts` — `POST` "Run now" (enqueues a manual run).
- Boot: `instrumentation.ts` calls `schedulerRuntime.start()` once (idempotent).

### Touched existing files

- `app/api/acp/route.ts` — refactor to extract `lib/scheduler/agentRunner.ts` (shared single-prompt server-side execution). No behavior change for the live chat flow.
- Right-sidebar host component — add a new "Schedules" toggle and mount `SchedulesPanel`.
- `package.json` — add `node-cron` dependency.

## Data Model

Two new tables in `.data/chats.db`.

### `cron_jobs`

| column          | type            | notes                                                                                            |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `id`            | TEXT PK         | uuid                                                                                             |
| `agent_id`      | TEXT            | logical FK to agent (no SQL FK constraint, matches existing style)                               |
| `name`          | TEXT            | user-supplied label                                                                              |
| `prompt`        | TEXT            | fixed message sent each run                                                                      |
| `schedule_kind` | TEXT            | `'every_minutes' \| 'every_hours' \| 'every_days' \| 'daily' \| 'weekly'`                        |
| `schedule_spec` | TEXT (JSON)     | e.g. `{n:30}`, `{hour:9,minute:0}`, `{weekday:1,hour:9,minute:0}` — times stored in **UTC**     |
| `cron_expr`     | TEXT            | derived cron expression cached for `node-cron`                                                   |
| `enabled`       | INTEGER (0/1)   | toggle                                                                                           |
| `created_by`    | TEXT            | username                                                                                         |
| `created_at`    | INTEGER         | ms epoch                                                                                         |
| `updated_at`    | INTEGER         | ms epoch                                                                                         |
| `last_fired_at` | INTEGER NULL    | last tick the runtime acted on; used for backfill                                                |

Index: `cron_jobs(agent_id, enabled)`.

### `cron_runs`

| column          | type            | notes                                                                  |
| --------------- | --------------- | ---------------------------------------------------------------------- |
| `id`            | TEXT PK         | uuid                                                                   |
| `job_id`        | TEXT            | logical FK → `cron_jobs.id`; deletes cascade in app code               |
| `agent_id`      | TEXT            | denormalized for fast filtering                                        |
| `trigger`       | TEXT            | `'schedule' \| 'manual' \| 'backfill'`                                 |
| `status`        | TEXT            | `'queued' \| 'running' \| 'success' \| 'error' \| 'skipped'`           |
| `started_at`    | INTEGER NULL    | ms epoch                                                               |
| `finished_at`   | INTEGER NULL    | ms epoch                                                               |
| `duration_ms`   | INTEGER NULL    |                                                                        |
| `reply_text`    | TEXT NULL       | final assistant text                                                   |
| `error_message` | TEXT NULL       |                                                                        |
| `raw_log`       | TEXT NULL       | NDJSON transcript, truncated to 256 KB                                 |
| `created_at`    | INTEGER         | ms epoch                                                               |

Index: `cron_runs(job_id, created_at DESC)`.

### Retention

After each run insert: `DELETE FROM cron_runs WHERE job_id=? AND id NOT IN (SELECT id FROM cron_runs WHERE job_id=? ORDER BY created_at DESC LIMIT 100)`.

## Runtime Behavior

### Boot (idempotent)

1. Mark any orphan `cron_runs` with `status IN ('queued','running')` older than 1 hour as `error` with message "interrupted by restart".
2. Load all `cron_jobs WHERE enabled=1`.
3. **Backfill sweep**: for each job, compute every scheduled tick between `last_fired_at` (or `created_at` if null) and `now`. Enqueue a `cron_runs` row per missed tick with `trigger='backfill'`, `status='queued'`. Cap at 100 enqueued backfills per job — if more would have fired, record one additional `skipped` run noting the dropped count.
4. Register each enabled job with `node-cron` (TZ `'UTC'`) using its cached `cron_expr`.

### Tick

- Insert a `queued` run (`trigger='schedule'`), update `last_fired_at = now`.
- Hand the run id to the per-job FIFO queue.

### Per-job FIFO queue

In-memory `Map<jobId, Promise<void>>`. Each new run `.then()`s onto the chain so executions never overlap for the same job. Different jobs run independently. Manual and backfill runs share the same chain.

### Executing one run

1. `UPDATE cron_runs SET status='running', started_at=now WHERE id=?`.
2. Call `agentRunner.runOnce({ agentId, prompt, actor: created_by })` — spawns the agent via existing ACP machinery, collects NDJSON transcript and final assistant text. Hard timeout: 10 minutes (single constant for v1).
3. On success → `status='success'`, store `reply_text`, truncated `raw_log`, `finished_at`, `duration_ms`.
4. On error → `status='error'`, store `error_message` and any partial `raw_log`.
5. Prune to last 100 runs for that job.

### Manual "Run now"

API enqueues onto the same per-job chain with `trigger='manual'`.

### Toggle enabled→disabled

Unregister from `node-cron`. In-flight runs finish; queued runs are left in the chain and will complete (matches the "queue overlapping" policy).

### Toggle disabled→enabled

Re-register; run a backfill sweep for that single job.

### Edit schedule

Unregister old, write new `cron_expr`, register new. Do **not** backfill on edit (would surprise the user).

### Delete job

Unregister and delete the `cron_jobs` row plus all its `cron_runs`.

## API Surface

All endpoints are gated by the existing NextAuth middleware. Authorization: caller must have `canTalk` access to the target agent (admins always allowed).

- `GET  /api/schedules` → list jobs visible to caller. Optional `?agentId=`. Response summary: `{ id, agentId, name, scheduleKind, scheduleSpec, enabled, lastFiredAt, lastRunStatus, nextFireAt }`.
- `POST /api/schedules` → create. Body: `{ agentId, name, prompt, scheduleKind, scheduleSpec, enabled? }`. Validates spec, derives `cron_expr`, inserts, registers with runtime if enabled. Returns the created job.
- `GET  /api/schedules/[id]` → job plus last 100 runs (no `reply_text` / `raw_log` in list).
- `PATCH /api/schedules/[id]` → partial update of `{ name?, prompt?, scheduleKind?, scheduleSpec?, enabled? }`. Re-derives `cron_expr` if schedule changed; re-registers; toggles per rules above.
- `DELETE /api/schedules/[id]` → unregister + delete job + runs.
- `GET  /api/schedules/[id]/runs/[runId]` → full run row including `reply_text` and `raw_log`.
- `POST /api/schedules/[id]/run` → enqueue a manual run. Returns `{ runId }`.

Error responses follow `{ error: string }` with `400` validation, `403` unauthorized, `404` not found, `409` conflict.

## Error Handling

- Spec validation rejects out-of-range values (e.g. `n < 1`, `hour > 23`, unknown `schedule_kind`).
- Agent spawn failure → run marked `error` with the spawn error message; runtime continues with next ticks.
- Run timeout (10 min) → child process killed, run marked `error` with "timed out".
- Server restart mid-run → orphan recovery on next boot marks affected runs `error`.
- API authorization failures return `403` without leaking job existence.

## Testing Strategy

- **Pure helpers** (`scheduleSpec.ts`) — `*.test.mjs` via `node --test`. Cover friendly-spec ↔ cron expression, UTC ↔ local conversions, "next N fires" preview, validation errors.
- **Store** (`scheduleStore.ts`) — `*.test.mjs` against a temp SQLite file. Cover CRUD, retention prune, cascade-on-delete behavior.
- **Runtime** (`schedulerRuntime.ts`) — `*.test.mjs` with an injected clock + fake `node-cron`. Cover backfill sweep (with cap), per-job FIFO serialization, edit-replaces-registration, orphan recovery on boot.
- **API** — `test/api-schedules.spec.ts` using the existing Playwright setup (already drives HTTP). Cover auth gating, CRUD round-trip, toggle, run-now enqueues a row, delete cascades runs.
- **E2E** — `test/test-schedules.spec.ts` (Playwright): open sidebar panel, create an "Every 1 minute" job against a mock agent, see a run appear, open run-detail drawer, toggle disabled, delete.

## Conventions

- New code lives under `app/features/scheduler/` and `lib/scheduler/` per repo guardrails.
- API route handlers stay thin; business logic in `lib/scheduler/`.
- Styling via `styled-jsx` only.
- `better-sqlite3` direct usage with raw SQL (no ORM).
- New dependency: `node-cron`.
