# Agent Cron Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side cron-job scheduling for agents — schedules fire silently in-process, run a fixed prompt against the chosen agent's default model, persist runs and logs, and expose management via a right-sidebar "Schedules" panel.

**Architecture:** Singleton `node-cron`-driven runtime booted from `instrumentation.ts`. Two SQLite tables (`cron_jobs`, `cron_runs`) in `.data/chats.db`. Per-job FIFO queue handles overlap. Server-side `agentRunner` composes existing `lib/acp/*` primitives to run a single prompt without touching the live chat code path. UI is a new feature module under `app/features/scheduler`.

**Tech Stack:** Next.js 16 (App Router, React 19), better-sqlite3, node-cron, styled-jsx, NextAuth, `node --test` (`*.test.mjs`) for unit, Playwright for E2E/API.

**Spec:** `docs/superpowers/specs/2026-05-20-agent-cron-jobs-design.md`

---

## File Structure

**New files:**
- `app/features/scheduler/scheduleTypes.ts` — TS types
- `app/features/scheduler/scheduleSpec.ts` — pure helpers (spec ↔ cron, preview, validate)
- `app/features/scheduler/scheduleSpec.test.mjs` — unit tests
- `app/features/scheduler/hooks/useSchedules.ts` — client data hook
- `app/features/scheduler/components/SchedulesPanel.tsx`
- `app/features/scheduler/components/ScheduleEditor.tsx`
- `app/features/scheduler/components/RunHistory.tsx`
- `lib/scheduler/scheduleStore.ts` — better-sqlite3 store
- `lib/scheduler/scheduleStore.test.mjs`
- `lib/scheduler/agentRunner.ts` — server-side single-prompt runner
- `lib/scheduler/schedulerRuntime.ts` — singleton runtime
- `lib/scheduler/schedulerRuntime.test.mjs`
- `instrumentation.ts` — Next.js boot hook
- `app/api/schedules/route.ts` — list + create
- `app/api/schedules/[id]/route.ts` — get/patch/delete
- `app/api/schedules/[id]/runs/[runId]/route.ts` — full run detail
- `app/api/schedules/[id]/run/route.ts` — manual run
- `test/api-schedules.spec.ts` — Playwright API tests
- `test/test-schedules.spec.ts` — Playwright E2E

**Modified files:**
- `package.json` — add `node-cron` + `@types/node-cron`
- `app/features/layout/components/ChatShell.tsx` — extend `mobilePanel` union
- `app/page.tsx` or its chat client wrapper — mount SchedulesPanel as `rightPanel` (find exact integration point during Task 17)

---

## Task 1: Install node-cron

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime + types**

Run: `npm install node-cron && npm install -D @types/node-cron`
Expected: both added to `package.json`, lockfile updated.

- [ ] **Step 2: Verify build still passes**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(scheduler): add node-cron dependency"
```

---

## Task 2: Schedule types

**Files:**
- Create: `app/features/scheduler/scheduleTypes.ts`

- [ ] **Step 1: Write types file**

```ts
export type ScheduleKind =
  | "every_minutes"
  | "every_hours"
  | "every_days"
  | "daily"
  | "weekly";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type ScheduleSpec =
  | { kind: "every_minutes"; interval: number }
  | { kind: "every_hours"; interval: number }
  | { kind: "every_days"; interval: number; hour: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: Weekday[]; hour: number; minute: number };

export type CronJob = {
  id: string;
  agentId: string;
  ownerEmail: string;
  name: string;
  prompt: string;
  scheduleSpec: ScheduleSpec;
  cronExpr: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

export type CronRunStatus = "queued" | "running" | "success" | "error" | "skipped";

export type CronRun = {
  id: string;
  jobId: string;
  scheduledFor: number;
  startedAt: number | null;
  finishedAt: number | null;
  status: CronRunStatus;
  replyText: string | null;
  errorMessage: string | null;
  rawLogPath: string | null;
};
```

- [ ] **Step 2: Verify tsc**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/features/scheduler/scheduleTypes.ts
git commit -m "feat(scheduler): add schedule types"
```

---

## Task 3: scheduleSpec helpers (TDD)

**Files:**
- Create: `app/features/scheduler/scheduleSpec.ts`
- Test: `app/features/scheduler/scheduleSpec.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { specToCron, validateSpec, nextFires } from "./scheduleSpec.ts";

test("every_minutes -> */N * * * *", () => {
  assert.equal(specToCron({ kind: "every_minutes", interval: 15 }), "*/15 * * * *");
});

test("daily 09:30 -> 30 9 * * *", () => {
  assert.equal(specToCron({ kind: "daily", hour: 9, minute: 30 }), "30 9 * * *");
});

test("weekly Mon+Wed 08:00 -> 0 8 * * 1,3", () => {
  assert.equal(
    specToCron({ kind: "weekly", weekdays: [1, 3], hour: 8, minute: 0 }),
    "0 8 * * 1,3"
  );
});

test("every_hours 2 -> 0 */2 * * *", () => {
  assert.equal(specToCron({ kind: "every_hours", interval: 2 }), "0 */2 * * *");
});

test("every_days 3 at 06:00 -> 0 6 */3 * *", () => {
  assert.equal(
    specToCron({ kind: "every_days", interval: 3, hour: 6, minute: 0 }),
    "0 6 */3 * *"
  );
});

test("validateSpec rejects interval <= 0", () => {
  assert.throws(() => validateSpec({ kind: "every_minutes", interval: 0 }));
});

test("validateSpec rejects hour out of range", () => {
  assert.throws(() => validateSpec({ kind: "daily", hour: 24, minute: 0 }));
});

test("nextFires returns N future timestamps", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const fires = nextFires({ kind: "every_minutes", interval: 10 }, 3, now);
  assert.equal(fires.length, 3);
  assert.ok(fires[0] > now);
  assert.ok(fires[1] > fires[0]);
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test --experimental-strip-types app/features/scheduler/scheduleSpec.test.mjs`
Expected: failures (module not found).

- [ ] **Step 3: Implement**

```ts
import type { ScheduleSpec } from "./scheduleTypes";

export function validateSpec(spec: ScheduleSpec): void {
  switch (spec.kind) {
    case "every_minutes":
      if (!Number.isInteger(spec.interval) || spec.interval < 1 || spec.interval > 59)
        throw new Error("interval must be 1-59 minutes");
      return;
    case "every_hours":
      if (!Number.isInteger(spec.interval) || spec.interval < 1 || spec.interval > 23)
        throw new Error("interval must be 1-23 hours");
      return;
    case "every_days":
      if (!Number.isInteger(spec.interval) || spec.interval < 1 || spec.interval > 30)
        throw new Error("interval must be 1-30 days");
      assertHM(spec.hour, spec.minute);
      return;
    case "daily":
      assertHM(spec.hour, spec.minute);
      return;
    case "weekly":
      if (!spec.weekdays.length) throw new Error("pick at least one weekday");
      for (const d of spec.weekdays)
        if (d < 0 || d > 6) throw new Error("weekday out of range");
      assertHM(spec.hour, spec.minute);
      return;
  }
}

function assertHM(h: number, m: number) {
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error("hour 0-23");
  if (!Number.isInteger(m) || m < 0 || m > 59) throw new Error("minute 0-59");
}

export function specToCron(spec: ScheduleSpec): string {
  validateSpec(spec);
  switch (spec.kind) {
    case "every_minutes":
      return `*/${spec.interval} * * * *`;
    case "every_hours":
      return `0 */${spec.interval} * * *`;
    case "every_days":
      return `${spec.minute} ${spec.hour} */${spec.interval} * *`;
    case "daily":
      return `${spec.minute} ${spec.hour} * * *`;
    case "weekly": {
      const days = [...spec.weekdays].sort((a, b) => a - b).join(",");
      return `${spec.minute} ${spec.hour} * * ${days}`;
    }
  }
}

export function nextFires(spec: ScheduleSpec, count: number, fromUtcMs: number): number[] {
  const out: number[] = [];
  let t = Math.floor(fromUtcMs / 60000) * 60000 + 60000;
  const limit = fromUtcMs + 1000 * 60 * 60 * 24 * 366;
  while (out.length < count && t < limit) {
    if (matches(spec, t)) out.push(t);
    t += 60000;
  }
  return out;
}

function matches(spec: ScheduleSpec, utcMs: number): boolean {
  const d = new Date(utcMs);
  const mm = d.getUTCMinutes();
  const hh = d.getUTCHours();
  const dom = d.getUTCDate();
  const dow = d.getUTCDay();
  switch (spec.kind) {
    case "every_minutes":
      return mm % spec.interval === 0;
    case "every_hours":
      return mm === 0 && hh % spec.interval === 0;
    case "every_days":
      return mm === spec.minute && hh === spec.hour && ((dom - 1) % spec.interval === 0);
    case "daily":
      return mm === spec.minute && hh === spec.hour;
    case "weekly":
      return mm === spec.minute && hh === spec.hour && spec.weekdays.includes(dow as 0);
  }
}
```

- [ ] **Step 4: Run test (passing)**

Run: `node --test --experimental-strip-types app/features/scheduler/scheduleSpec.test.mjs`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add app/features/scheduler/scheduleSpec.ts app/features/scheduler/scheduleSpec.test.mjs
git commit -m "feat(scheduler): spec <-> cron helpers with validation"
```

---

## Task 4: scheduleStore (TDD)

**Files:**
- Create: `lib/scheduler/scheduleStore.ts`
- Test: `lib/scheduler/scheduleStore.test.mjs`

Pattern reference: `lib/configStore.ts` (DB init, migrations, WAL, rowTo mappers).

- [ ] **Step 1: Write failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openScheduleStore } from "./scheduleStore.ts";

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "sched-"));
  const store = openScheduleStore(path.join(dir, "test.db"));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("createJob + listJobs", () => {
  const { store, cleanup } = freshStore();
  try {
    const j = store.createJob({
      agentId: "a1",
      ownerEmail: "u@example.com",
      name: "Hourly",
      prompt: "ping",
      scheduleSpec: { kind: "every_hours", interval: 1 },
      cronExpr: "0 */1 * * *",
      enabled: true,
    });
    assert.ok(j.id);
    const list = store.listJobs();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "Hourly");
  } finally { cleanup(); }
});

test("createRun + listRuns + retention prunes to 100", () => {
  const { store, cleanup } = freshStore();
  try {
    const j = store.createJob({
      agentId: "a1", ownerEmail: "u@example.com", name: "x", prompt: "p",
      scheduleSpec: { kind: "every_minutes", interval: 1 }, cronExpr: "*/1 * * * *", enabled: true,
    });
    for (let i = 0; i < 110; i++) {
      store.createRun({ jobId: j.id, scheduledFor: i * 1000, status: "success" });
    }
    const runs = store.listRuns(j.id);
    assert.equal(runs.length, 100);
  } finally { cleanup(); }
});

test("deleteJob cascades runs", () => {
  const { store, cleanup } = freshStore();
  try {
    const j = store.createJob({
      agentId: "a1", ownerEmail: "u@example.com", name: "x", prompt: "p",
      scheduleSpec: { kind: "daily", hour: 9, minute: 0 }, cronExpr: "0 9 * * *", enabled: true,
    });
    store.createRun({ jobId: j.id, scheduledFor: 1, status: "success" });
    store.deleteJob(j.id);
    assert.equal(store.listJobs().length, 0);
    assert.equal(store.listRuns(j.id).length, 0);
  } finally { cleanup(); }
});

test("markOrphansAsError flips stuck queued/running runs", () => {
  const { store, cleanup } = freshStore();
  try {
    const j = store.createJob({
      agentId: "a1", ownerEmail: "u@example.com", name: "x", prompt: "p",
      scheduleSpec: { kind: "daily", hour: 9, minute: 0 }, cronExpr: "0 9 * * *", enabled: true,
    });
    const r = store.createRun({ jobId: j.id, scheduledFor: 1, status: "running" });
    const n = store.markOrphansAsError(Date.now());
    assert.ok(n >= 1);
    const got = store.getRun(r.id);
    assert.equal(got.status, "error");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test --experimental-strip-types lib/scheduler/scheduleStore.test.mjs`
Expected: fail (module missing).

- [ ] **Step 3: Implement scheduleStore**

```ts
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { CronJob, CronRun, CronRunStatus, ScheduleSpec } from "../../app/features/scheduler/scheduleTypes";

export type ScheduleStore = ReturnType<typeof openScheduleStore>;

export function openScheduleStore(dbPath?: string) {
  const file = dbPath ?? path.join(process.cwd(), ".data", "chats.db");
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);

  function createJob(input: Omit<CronJob, "id" | "createdAt" | "updatedAt" | "lastRunAt" | "nextRunAt">): CronJob {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO cron_jobs
      (id, agent_id, owner_email, name, prompt, schedule_spec, cron_expr, enabled, created_at, updated_at, last_run_at, next_run_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
      id, input.agentId, input.ownerEmail, input.name, input.prompt,
      JSON.stringify(input.scheduleSpec), input.cronExpr, input.enabled ? 1 : 0, now, now
    );
    return getJob(id)!;
  }

  function updateJob(id: string, patch: Partial<Pick<CronJob, "name" | "prompt" | "scheduleSpec" | "cronExpr" | "enabled" | "lastRunAt" | "nextRunAt">>): CronJob | null {
    const cur = getJob(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    db.prepare(`UPDATE cron_jobs SET name=?, prompt=?, schedule_spec=?, cron_expr=?, enabled=?, updated_at=?, last_run_at=?, next_run_at=? WHERE id=?`).run(
      next.name, next.prompt, JSON.stringify(next.scheduleSpec), next.cronExpr,
      next.enabled ? 1 : 0, next.updatedAt, next.lastRunAt, next.nextRunAt, id
    );
    return getJob(id);
  }

  function deleteJob(id: string): void {
    db.prepare("DELETE FROM cron_runs WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
  }

  function getJob(id: string): CronJob | null {
    const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as any;
    return row ? rowToJob(row) : null;
  }

  function listJobs(): CronJob[] {
    return (db.prepare("SELECT * FROM cron_jobs ORDER BY created_at DESC").all() as any[]).map(rowToJob);
  }

  function listEnabledJobs(): CronJob[] {
    return (db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all() as any[]).map(rowToJob);
  }

  function createRun(input: { jobId: string; scheduledFor: number; status: CronRunStatus; }): CronRun {
    const id = randomUUID();
    db.prepare(`INSERT INTO cron_runs (id, job_id, scheduled_for, started_at, finished_at, status, reply_text, error_message, raw_log_path)
      VALUES (?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL)`).run(id, input.jobId, input.scheduledFor, input.status);
    pruneRuns(input.jobId);
    return getRun(id)!;
  }

  function updateRun(id: string, patch: Partial<Pick<CronRun, "startedAt" | "finishedAt" | "status" | "replyText" | "errorMessage" | "rawLogPath">>): CronRun | null {
    const cur = getRun(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    db.prepare(`UPDATE cron_runs SET started_at=?, finished_at=?, status=?, reply_text=?, error_message=?, raw_log_path=? WHERE id=?`).run(
      next.startedAt, next.finishedAt, next.status, next.replyText, next.errorMessage, next.rawLogPath, id
    );
    return getRun(id);
  }

  function getRun(id: string): CronRun | null {
    const row = db.prepare("SELECT * FROM cron_runs WHERE id = ?").get(id) as any;
    return row ? rowToRun(row) : null;
  }

  function listRuns(jobId: string, limit = 100): CronRun[] {
    return (db.prepare("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY scheduled_for DESC LIMIT ?").all(jobId, limit) as any[]).map(rowToRun);
  }

  function pruneRuns(jobId: string) {
    db.prepare(`DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (
      SELECT id FROM cron_runs WHERE job_id = ? ORDER BY scheduled_for DESC LIMIT 100
    )`).run(jobId, jobId);
  }

  function markOrphansAsError(nowMs: number): number {
    const cutoff = nowMs - 60 * 60 * 1000;
    const res = db.prepare(`UPDATE cron_runs SET status='error', error_message='orphaned', finished_at=?
      WHERE status IN ('queued','running') AND scheduled_for < ?`).run(nowMs, cutoff);
    return res.changes;
  }

  return { createJob, updateJob, deleteJob, getJob, listJobs, listEnabledJobs,
    createRun, updateRun, getRun, listRuns, markOrphansAsError, _db: db };
}

function migrate(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_spec TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_run_at INTEGER,
    next_run_at INTEGER
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS cron_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    status TEXT NOT NULL,
    reply_text TEXT,
    error_message TEXT,
    raw_log_path TEXT,
    FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_runs_job_sched ON cron_runs(job_id, scheduled_for DESC);`);
}

function rowToJob(r: any): CronJob {
  return {
    id: r.id, agentId: r.agent_id, ownerEmail: r.owner_email,
    name: r.name, prompt: r.prompt,
    scheduleSpec: JSON.parse(r.schedule_spec) as ScheduleSpec,
    cronExpr: r.cron_expr, enabled: !!r.enabled,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastRunAt: r.last_run_at, nextRunAt: r.next_run_at,
  };
}

function rowToRun(r: any): CronRun {
  return {
    id: r.id, jobId: r.job_id, scheduledFor: r.scheduled_for,
    startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status as CronRunStatus,
    replyText: r.reply_text, errorMessage: r.error_message,
    rawLogPath: r.raw_log_path,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test --experimental-strip-types lib/scheduler/scheduleStore.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scheduler/scheduleStore.ts lib/scheduler/scheduleStore.test.mjs
git commit -m "feat(scheduler): sqlite store for cron jobs and runs"
```

---

## Task 5: agentRunner (server-side single-prompt runner)

**Files:**
- Create: `lib/scheduler/agentRunner.ts`

The runner must NOT depend on the streaming response in `app/api/acp/route.ts`. Instead it composes existing `lib/acp/*` primitives (rpc, runtimeState, models). Read `app/api/acp/route.ts` and reuse the same spawn + initialize + session/new + session/prompt sequence as a non-streaming, awaited call. The runner returns when the agent emits the final `session/prompt` response or the timeout (10 min) elapses.

- [ ] **Step 1: Implement runner**

```ts
import { loadAgents } from "../configStore";
import type { CronJob } from "../../app/features/scheduler/scheduleTypes";

export type RunResult = {
  replyText: string;
  rawLog: string;
  error: string | null;
};

export async function runAgentOnce(job: CronJob, opts?: { timeoutMs?: number }): Promise<RunResult> {
  const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  const agents = loadAgents();
  const agent = agents.find((a) => a.id === job.agentId);
  if (!agent) return { replyText: "", rawLog: "", error: `agent not found: ${job.agentId}` };

  const logChunks: string[] = [];
  const append = (s: string) => {
    if (logChunks.join("").length < 256 * 1024) logChunks.push(s);
  };

  try {
    const replyText = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      // Compose lib/acp primitives here: spawn process, initialize, session/new,
      // session/prompt with job.prompt, listen for session/update text chunks,
      // resolve when prompt RPC response returns. See app/api/acp/route.ts
      // for the exact sequence — replicate it without the SSE stream.
      // TODO: extract a non-streaming helper from app/api/acp/route.ts into lib/acp
      // and call it here. Until that helper exists, implement the spawn loop inline
      // using lib/acp/rpc.ts and lib/acp/runtimeState.ts.
      runViaAcpPrimitives(agent, agent.defaultModelId ?? "", job.prompt, append, resolve, reject)
        .finally(() => clearTimeout(timer));
    });
    return { replyText, rawLog: logChunks.join(""), error: null };
  } catch (e: any) {
    return { replyText: "", rawLog: logChunks.join(""), error: String(e?.message ?? e) };
  }
}

async function runViaAcpPrimitives(
  agent: any,
  modelId: string,
  prompt: string,
  append: (s: string) => void,
  resolve: (text: string) => void,
  reject: (e: Error) => void
): Promise<void> {
  // Implementation note: this function MUST be filled in by reading
  // app/api/acp/route.ts and reusing the same imports from lib/acp/*
  // (rpc, runtimeState, models, attachments). The streaming SSE writer
  // is the only thing we drop — collect text chunks into `append` and
  // resolve with the concatenated assistant reply.
  throw new Error("agentRunner: ACP wiring not yet implemented");
}
```

> Implementer note: the body of `runViaAcpPrimitives` is the only TBD in this plan. Before writing it, open `app/api/acp/route.ts` and identify (a) the spawn-and-initialize block, (b) the `session/new` call, (c) the `session/prompt` call, (d) the `session/update` listener. Lift those into this function. If you find that the helper can be extracted cleanly from `route.ts` without behavior change, do so as a separate prep commit before completing this task.

- [ ] **Step 2: Smoke build**

Run: `npx tsc --noEmit`
Expected: no errors. (Function throws at runtime — that's covered by Task 6 tests using a fake runner.)

- [ ] **Step 3: Commit**

```bash
git add lib/scheduler/agentRunner.ts
git commit -m "feat(scheduler): agent runner scaffold (acp wiring TBD inline)"
```

---

## Task 6: schedulerRuntime (TDD)

**Files:**
- Create: `lib/scheduler/schedulerRuntime.ts`
- Test: `lib/scheduler/schedulerRuntime.test.mjs`

Runtime contract:
- `createRuntime({ store, runner, cron, now })` returns `{ start, stop, scheduleJob, unscheduleJob, runNow, enqueueTick }`
- `start()`: `markOrphansAsError(now)` → for each enabled job: backfill (cap 100; extras inserted with status `skipped`) → register cron callback that calls `enqueueTick(jobId, scheduledFor)`
- `enqueueTick(jobId, scheduledFor)`: appends to per-job FIFO queue → executes serially via `runner.runAgentOnce`
- Inject `cron` (the node-cron module) and `now` for tests

- [ ] **Step 1: Write failing tests**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openScheduleStore } from "./scheduleStore.ts";
import { createRuntime } from "./schedulerRuntime.ts";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "rt-"));
  const store = openScheduleStore(path.join(dir, "t.db"));
  const tasks = [];
  const cron = {
    schedule: (expr, fn) => { const t = { expr, fn, stop: () => {} }; tasks.push(t); return t; },
  };
  const calls = [];
  const runner = { runAgentOnce: async (job) => { calls.push(job.id); return { replyText: "ok", rawLog: "log", error: null }; } };
  return { dir, store, cron, runner, calls, tasks, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("start registers cron tasks for enabled jobs only", async () => {
  const s = setup();
  try {
    s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n1", prompt: "p",
      scheduleSpec: { kind: "every_minutes", interval: 1 }, cronExpr: "*/1 * * * *", enabled: true });
    s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n2", prompt: "p",
      scheduleSpec: { kind: "every_minutes", interval: 5 }, cronExpr: "*/5 * * * *", enabled: false });
    const rt = createRuntime({ store: s.store, runner: s.runner, cron: s.cron, now: () => Date.now() });
    await rt.start();
    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0].expr, "*/1 * * * *");
  } finally { s.cleanup(); }
});

test("tick enqueues run and runner executes serially", async () => {
  const s = setup();
  try {
    const j = s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n", prompt: "p",
      scheduleSpec: { kind: "every_minutes", interval: 1 }, cronExpr: "*/1 * * * *", enabled: true });
    const rt = createRuntime({ store: s.store, runner: s.runner, cron: s.cron, now: () => 1000 });
    await rt.start();
    await rt.enqueueTick(j.id, 1000);
    await rt.enqueueTick(j.id, 2000);
    await new Promise((r) => setTimeout(r, 50));
    const runs = s.store.listRuns(j.id);
    assert.ok(runs.length >= 2);
    assert.ok(runs.every((r) => r.status === "success"));
  } finally { s.cleanup(); }
});

test("runNow inserts a run and executes", async () => {
  const s = setup();
  try {
    const j = s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n", prompt: "p",
      scheduleSpec: { kind: "daily", hour: 9, minute: 0 }, cronExpr: "0 9 * * *", enabled: true });
    const rt = createRuntime({ store: s.store, runner: s.runner, cron: s.cron, now: () => 5000 });
    await rt.start();
    const r = await rt.runNow(j.id);
    assert.equal(r.status, "success");
  } finally { s.cleanup(); }
});

test("runner error is captured", async () => {
  const s = setup();
  s.runner.runAgentOnce = async () => ({ replyText: "", rawLog: "x", error: "boom" });
  try {
    const j = s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n", prompt: "p",
      scheduleSpec: { kind: "daily", hour: 9, minute: 0 }, cronExpr: "0 9 * * *", enabled: true });
    const rt = createRuntime({ store: s.store, runner: s.runner, cron: s.cron, now: () => 5000 });
    await rt.start();
    const r = await rt.runNow(j.id);
    assert.equal(r.status, "error");
    assert.equal(r.errorMessage, "boom");
  } finally { s.cleanup(); }
});
```

- [ ] **Step 2: Run failing tests**

Run: `node --test --experimental-strip-types lib/scheduler/schedulerRuntime.test.mjs`
Expected: fail (module missing).

- [ ] **Step 3: Implement runtime**

```ts
import type { ScheduleStore } from "./scheduleStore";
import type { CronJob, CronRun } from "../../app/features/scheduler/scheduleTypes";
import { nextFires } from "../../app/features/scheduler/scheduleSpec";

type Runner = { runAgentOnce: (job: CronJob) => Promise<{ replyText: string; rawLog: string; error: string | null }> };
type CronLike = { schedule: (expr: string, fn: () => void, opts?: { timezone?: string }) => { stop: () => void } };

export type SchedulerRuntime = ReturnType<typeof createRuntime>;

export function createRuntime(deps: { store: ScheduleStore; runner: Runner; cron: CronLike; now: () => number; backfillCap?: number }) {
  const { store, runner, cron, now } = deps;
  const backfillCap = deps.backfillCap ?? 100;
  const tasks = new Map<string, { stop: () => void }>();
  const queues = new Map<string, Promise<void>>();

  async function start(): Promise<void> {
    store.markOrphansAsError(now());
    for (const job of store.listEnabledJobs()) {
      await backfill(job);
      register(job);
    }
  }

  function stop(): void {
    for (const t of tasks.values()) t.stop();
    tasks.clear();
  }

  function register(job: CronJob) {
    const t = cron.schedule(job.cronExpr, () => { void enqueueTick(job.id, now()); }, { timezone: "UTC" });
    tasks.set(job.id, t);
  }

  async function backfill(job: CronJob): Promise<void> {
    const since = job.lastRunAt ?? job.createdAt;
    const cutoff = now();
    const missed: number[] = [];
    let t = Math.floor(since / 60000) * 60000 + 60000;
    while (t < cutoff && missed.length < backfillCap + 1) {
      const [next] = nextFires(job.scheduleSpec, 1, t - 60000);
      if (!next || next >= cutoff) break;
      missed.push(next);
      t = next + 60000;
    }
    const toRun = missed.slice(-backfillCap);
    const skipped = missed.slice(0, Math.max(0, missed.length - backfillCap));
    for (const s of skipped) store.createRun({ jobId: job.id, scheduledFor: s, status: "skipped" });
    for (const m of toRun) void enqueueTick(job.id, m);
  }

  function enqueueTick(jobId: string, scheduledFor: number): Promise<void> {
    const prev = queues.get(jobId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => execute(jobId, scheduledFor));
    queues.set(jobId, next);
    return next;
  }

  async function execute(jobId: string, scheduledFor: number): Promise<void> {
    const job = store.getJob(jobId);
    if (!job || !job.enabled) return;
    const run = store.createRun({ jobId, scheduledFor, status: "running" });
    store.updateRun(run.id, { startedAt: now() });
    const res = await runner.runAgentOnce(job);
    store.updateRun(run.id, {
      finishedAt: now(),
      status: res.error ? "error" : "success",
      replyText: res.replyText || null,
      errorMessage: res.error,
    });
    store.updateJob(jobId, { lastRunAt: now() });
  }

  async function runNow(jobId: string): Promise<CronRun> {
    await enqueueTick(jobId, now());
    const runs = store.listRuns(jobId, 1);
    return runs[0];
  }

  function scheduleJob(job: CronJob): void {
    unscheduleJob(job.id);
    if (job.enabled) register(job);
  }
  function unscheduleJob(jobId: string): void {
    const t = tasks.get(jobId);
    if (t) { t.stop(); tasks.delete(jobId); }
  }

  return { start, stop, scheduleJob, unscheduleJob, runNow, enqueueTick };
}

let singleton: SchedulerRuntime | null = null;
export function getRuntime(): SchedulerRuntime | null { return singleton; }
export function setRuntime(rt: SchedulerRuntime | null) { singleton = rt; }
```

- [ ] **Step 4: Run tests**

Run: `node --test --experimental-strip-types lib/scheduler/schedulerRuntime.test.mjs`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add lib/scheduler/schedulerRuntime.ts lib/scheduler/schedulerRuntime.test.mjs
git commit -m "feat(scheduler): in-process runtime with per-job FIFO and backfill"
```

---

## Task 7: instrumentation hook

**Files:**
- Create: `instrumentation.ts` (verify it does not already exist before creating)

- [ ] **Step 1: Verify file absence**

Run: `Test-Path Q:\Repos\Agents-Chat\instrumentation.ts`
Expected: `False`. If `True`, edit existing file instead of creating.

- [ ] **Step 2: Implement**

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const cron = await import("node-cron");
  const { openScheduleStore } = await import("./lib/scheduler/scheduleStore");
  const { createRuntime, setRuntime, getRuntime } = await import("./lib/scheduler/schedulerRuntime");
  const { runAgentOnce } = await import("./lib/scheduler/agentRunner");
  if (getRuntime()) return;
  const store = openScheduleStore();
  const runtime = createRuntime({
    store,
    runner: { runAgentOnce },
    cron: { schedule: (expr, fn, opts) => cron.schedule(expr, fn, opts as any) },
    now: () => Date.now(),
  });
  setRuntime(runtime);
  await runtime.start();
}
```

- [ ] **Step 3: Smoke run dev server**

Run (async, detached, brief): `npx next dev --port 3010` for ~15 s, then stop. Expected: no startup crash.

- [ ] **Step 4: Commit**

```bash
git add instrumentation.ts
git commit -m "feat(scheduler): boot runtime via Next.js instrumentation hook"
```

---

## Task 8: API — list + create

**Files:**
- Create: `app/api/schedules/route.ts`

Auth: use `getAuthToken` + `canTalkTo` from `lib/auth.ts`. Admin bypass via `isAdminToken`.

- [ ] **Step 1: Implement**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../lib/auth";
import { openScheduleStore } from "../../../lib/scheduler/scheduleStore";
import { getRuntime } from "../../../lib/scheduler/schedulerRuntime";
import { specToCron, validateSpec } from "../../../app/features/scheduler/scheduleSpec";
import { loadAgents } from "../../../lib/configStore";

export async function GET(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token?.email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const store = openScheduleStore();
  const isAdmin = isAdminToken(token);
  const all = store.listJobs();
  const jobs = isAdmin ? all : all.filter((j) => j.ownerEmail === token.email);
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token?.email) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  const { agentId, name, prompt, scheduleSpec, enabled } = body ?? {};
  if (!agentId || !name || !prompt || !scheduleSpec)
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  const agent = loadAgents().find((a) => a.id === agentId);
  if (!agent) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  try { validateSpec(scheduleSpec); }
  catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
  const cronExpr = specToCron(scheduleSpec);
  const store = openScheduleStore();
  const job = store.createJob({
    agentId, ownerEmail: token.email, name, prompt,
    scheduleSpec, cronExpr, enabled: enabled !== false,
  });
  getRuntime()?.scheduleJob(job);
  return NextResponse.json({ job }, { status: 201 });
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/schedules/route.ts
git commit -m "feat(api): GET/POST /api/schedules"
```

---

## Task 9: API — get/patch/delete by id

**Files:**
- Create: `app/api/schedules/[id]/route.ts`

- [ ] **Step 1: Implement**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../../lib/auth";
import { openScheduleStore } from "../../../../lib/scheduler/scheduleStore";
import { getRuntime } from "../../../../lib/scheduler/schedulerRuntime";
import { specToCron, validateSpec } from "../../../../app/features/scheduler/scheduleSpec";

function authorize(token: any, ownerEmail: string) {
  return token?.email && (isAdminToken(token) || token.email === ownerEmail);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!authorize(token, job.ownerEmail)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ job, runs: store.listRuns(id) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!authorize(token, job.ownerEmail)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json();
  const patch: any = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.prompt === "string") patch.prompt = body.prompt;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.scheduleSpec) {
    try { validateSpec(body.scheduleSpec); }
    catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
    patch.scheduleSpec = body.scheduleSpec;
    patch.cronExpr = specToCron(body.scheduleSpec);
  }
  const updated = store.updateJob(id, patch)!;
  getRuntime()?.scheduleJob(updated);
  return NextResponse.json({ job: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!authorize(token, job.ownerEmail)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  getRuntime()?.unscheduleJob(id);
  store.deleteJob(id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/schedules/[id]/route.ts
git commit -m "feat(api): GET/PATCH/DELETE /api/schedules/:id"
```

---

## Task 10: API — get run

**Files:**
- Create: `app/api/schedules/[id]/runs/[runId]/route.ts`

- [ ] **Step 1: Implement**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../../../../lib/auth";
import { openScheduleStore } from "../../../../../../lib/scheduler/scheduleStore";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!token?.email || (!isAdminToken(token) && token.email !== job.ownerEmail))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const run = store.getRun(runId);
  if (!run || run.jobId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run });
}
```

- [ ] **Step 2: Commit**

```bash
git add "app/api/schedules/[id]/runs/[runId]/route.ts"
git commit -m "feat(api): GET schedule run detail"
```

---

## Task 11: API — manual run

**Files:**
- Create: `app/api/schedules/[id]/run/route.ts`

- [ ] **Step 1: Implement**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../../../lib/auth";
import { openScheduleStore } from "../../../../../lib/scheduler/scheduleStore";
import { getRuntime } from "../../../../../lib/scheduler/schedulerRuntime";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!token?.email || (!isAdminToken(token) && token.email !== job.ownerEmail))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rt = getRuntime();
  if (!rt) return NextResponse.json({ error: "runtime unavailable" }, { status: 503 });
  const run = await rt.runNow(id);
  return NextResponse.json({ run });
}
```

- [ ] **Step 2: Commit**

```bash
git add "app/api/schedules/[id]/run/route.ts"
git commit -m "feat(api): POST run-now"
```

---

## Task 12: Playwright API tests

**Files:**
- Create: `test/api-schedules.spec.ts`

Read `test/api-config.spec.ts` (or nearest existing API spec) for auth-cookie setup pattern before writing.

- [ ] **Step 1: Tests**

```ts
import { test, expect, request } from "@playwright/test";

const BASE = "http://localhost:3010";

async function login(api: any) {
  // mirror existing API spec login pattern; if a helper exists in test/helpers, use it
  await api.post(`${BASE}/api/auth/callback/credentials`, {
    form: { username: "admin", password: "admin123", csrfToken: "x", redirect: "false", json: "true" },
  });
}

test("requires auth", async () => {
  const api = await request.newContext();
  const r = await api.get(`${BASE}/api/schedules`);
  expect([401, 302]).toContain(r.status());
});

test("create + list + run-now + delete", async () => {
  const api = await request.newContext();
  await login(api);
  const created = await api.post(`${BASE}/api/schedules`, {
    data: {
      agentId: "REPLACE_WITH_FIRST_AGENT_ID",
      name: "test", prompt: "ping",
      scheduleSpec: { kind: "daily", hour: 9, minute: 0 },
      enabled: true,
    },
  });
  expect(created.ok()).toBeTruthy();
  const { job } = await created.json();
  const list = await (await api.get(`${BASE}/api/schedules`)).json();
  expect(list.jobs.map((j: any) => j.id)).toContain(job.id);

  const ran = await api.post(`${BASE}/api/schedules/${job.id}/run`);
  expect([200, 503]).toContain(ran.status());

  const del = await api.delete(`${BASE}/api/schedules/${job.id}`);
  expect(del.ok()).toBeTruthy();
});
```

> Replace `REPLACE_WITH_FIRST_AGENT_ID` by fetching `/api/agents` at test setup time.

- [ ] **Step 2: Run**

Start dev: `npx next dev --port 3010` (async).
Run: `npx playwright test --config test/playwright.config.ts test/api-schedules.spec.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/api-schedules.spec.ts
git commit -m "test(scheduler): playwright api coverage"
```

---

## Task 13: useSchedules hook

**Files:**
- Create: `app/features/scheduler/hooks/useSchedules.ts`

- [ ] **Step 1: Implement**

```ts
"use client";
import { useCallback, useEffect, useState } from "react";
import type { CronJob, CronRun, ScheduleSpec } from "../scheduleTypes";

export function useSchedules() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/schedules");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async (input: { agentId: string; name: string; prompt: string; scheduleSpec: ScheduleSpec; enabled?: boolean }) => {
    const r = await fetch("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const update = useCallback(async (id: string, patch: Partial<{ name: string; prompt: string; enabled: boolean; scheduleSpec: ScheduleSpec }>) => {
    const r = await fetch(`/api/schedules/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    const r = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const runNow = useCallback(async (id: string) => {
    const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const loadDetail = useCallback(async (id: string): Promise<{ job: CronJob; runs: CronRun[] }> => {
    const r = await fetch(`/api/schedules/${id}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }, []);

  return { jobs, loading, error, refresh, create, update, remove, runNow, loadDetail };
}
```

- [ ] **Step 2: Commit**

```bash
git add app/features/scheduler/hooks/useSchedules.ts
git commit -m "feat(scheduler): client data hook"
```

---

## Task 14: SchedulesPanel component

**Files:**
- Create: `app/features/scheduler/components/SchedulesPanel.tsx`

Mirror styling and structure of `app/features/agents/components/AgentsPanel.tsx`. Group jobs by agent. Each row: name, schedule summary, last-run badge, "Run now", "Edit", toggle enabled, delete (with confirm).

- [ ] **Step 1: Implement (skeleton)**

```tsx
"use client";
import { useState } from "react";
import { useSchedules } from "../hooks/useSchedules";
import type { CronJob } from "../scheduleTypes";
import { ScheduleEditor } from "./ScheduleEditor";
import { RunHistory } from "./RunHistory";

export function SchedulesPanel({ agents }: { agents: { id: string; name: string }[] }) {
  const { jobs, loading, error, create, update, remove, runNow } = useSchedules();
  const [editing, setEditing] = useState<CronJob | "new" | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);

  const grouped = new Map<string, CronJob[]>();
  for (const j of jobs) {
    const arr = grouped.get(j.agentId) ?? [];
    arr.push(j);
    grouped.set(j.agentId, arr);
  }

  return (
    <aside className="panel">
      <header><h2>Schedules</h2><button onClick={() => setEditing("new")}>+ New</button></header>
      {loading && <p>Loading…</p>}
      {error && <p className="err">{error}</p>}
      {[...grouped.entries()].map(([agentId, list]) => {
        const agent = agents.find((a) => a.id === agentId);
        return (
          <section key={agentId}>
            <h3>{agent?.name ?? agentId}</h3>
            <ul>
              {list.map((j) => (
                <li key={j.id}>
                  <div className="row">
                    <strong>{j.name}</strong>
                    <span>{j.cronExpr}</span>
                  </div>
                  <div className="actions">
                    <button onClick={() => runNow(j.id)}>Run now</button>
                    <button onClick={() => setEditing(j)}>Edit</button>
                    <label><input type="checkbox" checked={j.enabled} onChange={(e) => update(j.id, { enabled: e.target.checked })} /> on</label>
                    <button onClick={() => setHistoryFor(j.id)}>History</button>
                    <button onClick={() => { if (confirm("Delete?")) remove(j.id); }}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {editing && (
        <ScheduleEditor
          agents={agents}
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            if (editing === "new") await create(input);
            else await update((editing as CronJob).id, input);
            setEditing(null);
          }}
        />
      )}
      {historyFor && <RunHistory jobId={historyFor} onClose={() => setHistoryFor(null)} />}
      <style jsx>{`
        .panel { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
        header { display: flex; justify-content: space-between; align-items: center; }
        .row { display: flex; justify-content: space-between; gap: 8px; }
        .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
        .err { color: #c33; }
      `}</style>
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/features/scheduler/components/SchedulesPanel.tsx
git commit -m "feat(scheduler): SchedulesPanel skeleton"
```

---

## Task 15: ScheduleEditor modal

**Files:**
- Create: `app/features/scheduler/components/ScheduleEditor.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useMemo, useState } from "react";
import type { CronJob, ScheduleSpec } from "../scheduleTypes";
import { nextFires, specToCron } from "../scheduleSpec";

export function ScheduleEditor(props: {
  agents: { id: string; name: string }[];
  initial: CronJob | null;
  onCancel: () => void;
  onSave: (input: { agentId: string; name: string; prompt: string; scheduleSpec: ScheduleSpec; enabled?: boolean }) => Promise<void>;
}) {
  const [agentId, setAgentId] = useState(props.initial?.agentId ?? props.agents[0]?.id ?? "");
  const [name, setName] = useState(props.initial?.name ?? "");
  const [prompt, setPrompt] = useState(props.initial?.prompt ?? "");
  const [spec, setSpec] = useState<ScheduleSpec>(props.initial?.scheduleSpec ?? { kind: "daily", hour: 9, minute: 0 });
  const [err, setErr] = useState<string | null>(null);

  const preview = useMemo(() => {
    try { return nextFires(spec, 3, Date.now()).map((t) => new Date(t).toLocaleString()); }
    catch (e: any) { return [`invalid: ${e.message}`]; }
  }, [spec]);

  async function submit() {
    setErr(null);
    try {
      specToCron(spec);
      await props.onSave({ agentId, name, prompt, scheduleSpec: spec, enabled: true });
    } catch (e: any) { setErr(String(e?.message ?? e)); }
  }

  return (
    <div className="modal" role="dialog">
      <div className="card">
        <h3>{props.initial ? "Edit schedule" : "New schedule"}</h3>
        <label>Agent
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Prompt <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} /></label>
        <fieldset>
          <legend>Schedule</legend>
          <select value={spec.kind} onChange={(e) => setSpec(defaultForKind(e.target.value as ScheduleSpec["kind"]))}>
            <option value="every_minutes">Every N minutes</option>
            <option value="every_hours">Every N hours</option>
            <option value="every_days">Every N days at HH:MM</option>
            <option value="daily">Daily at HH:MM</option>
            <option value="weekly">Weekly on selected days at HH:MM</option>
          </select>
          <SpecFields spec={spec} setSpec={setSpec} />
        </fieldset>
        <div className="preview">
          <strong>Next runs:</strong>
          <ul>{preview.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="row">
          <button onClick={props.onCancel}>Cancel</button>
          <button onClick={submit}>Save</button>
        </div>
      </div>
      <style jsx>{`
        .modal { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
        .card { background: var(--bg, #fff); padding: 16px; min-width: 360px; max-width: 520px; border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
        label { display: flex; flex-direction: column; gap: 4px; }
        .row { display: flex; justify-content: flex-end; gap: 8px; }
        .err { color: #c33; }
      `}</style>
    </div>
  );
}

function defaultForKind(kind: ScheduleSpec["kind"]): ScheduleSpec {
  switch (kind) {
    case "every_minutes": return { kind, interval: 15 };
    case "every_hours": return { kind, interval: 1 };
    case "every_days": return { kind, interval: 1, hour: 9, minute: 0 };
    case "daily": return { kind, hour: 9, minute: 0 };
    case "weekly": return { kind, weekdays: [1], hour: 9, minute: 0 };
  }
}

function SpecFields({ spec, setSpec }: { spec: ScheduleSpec; setSpec: (s: ScheduleSpec) => void }) {
  if (spec.kind === "every_minutes" || spec.kind === "every_hours")
    return <label>Interval <input type="number" min={1} value={spec.interval} onChange={(e) => setSpec({ ...spec, interval: +e.target.value })} /></label>;
  if (spec.kind === "every_days")
    return (<>
      <label>Every N days <input type="number" min={1} value={spec.interval} onChange={(e) => setSpec({ ...spec, interval: +e.target.value })} /></label>
      <label>Hour <input type="number" min={0} max={23} value={spec.hour} onChange={(e) => setSpec({ ...spec, hour: +e.target.value })} /></label>
      <label>Minute <input type="number" min={0} max={59} value={spec.minute} onChange={(e) => setSpec({ ...spec, minute: +e.target.value })} /></label>
    </>);
  if (spec.kind === "daily")
    return (<>
      <label>Hour <input type="number" min={0} max={23} value={spec.hour} onChange={(e) => setSpec({ ...spec, hour: +e.target.value })} /></label>
      <label>Minute <input type="number" min={0} max={59} value={spec.minute} onChange={(e) => setSpec({ ...spec, minute: +e.target.value })} /></label>
    </>);
  return (<>
    <div>
      {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => (
        <label key={d}><input type="checkbox" checked={spec.weekdays.includes(i as 0)}
          onChange={(e) => {
            const set = new Set(spec.weekdays);
            if (e.target.checked) set.add(i as 0); else set.delete(i as 0);
            setSpec({ ...spec, weekdays: [...set].sort((a,b)=>a-b) as any });
          }} />{d}</label>
      ))}
    </div>
    <label>Hour <input type="number" min={0} max={23} value={spec.hour} onChange={(e) => setSpec({ ...spec, hour: +e.target.value })} /></label>
    <label>Minute <input type="number" min={0} max={59} value={spec.minute} onChange={(e) => setSpec({ ...spec, minute: +e.target.value })} /></label>
  </>);
}
```

- [ ] **Step 2: Commit**

```bash
git add app/features/scheduler/components/ScheduleEditor.tsx
git commit -m "feat(scheduler): schedule editor modal with live preview"
```

---

## Task 16: RunHistory drawer

**Files:**
- Create: `app/features/scheduler/components/RunHistory.tsx`

- [ ] **Step 1: Implement**

```tsx
"use client";
import { useEffect, useState } from "react";
import type { CronRun } from "../scheduleTypes";

export function RunHistory({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CronRun | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/schedules/${jobId}`);
      const data = await r.json();
      setRuns(data.runs ?? []);
    })();
  }, [jobId]);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    void (async () => {
      const r = await fetch(`/api/schedules/${jobId}/runs/${openId}`);
      const data = await r.json();
      setDetail(data.run);
    })();
  }, [openId, jobId]);

  return (
    <div className="drawer">
      <header><h3>Run history</h3><button onClick={onClose}>Close</button></header>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <button onClick={() => setOpenId(r.id === openId ? null : r.id)}>
              {new Date(r.scheduledFor).toLocaleString()} — {r.status}
            </button>
            {openId === r.id && detail && (
              <pre>{detail.errorMessage ? `ERROR: ${detail.errorMessage}\n\n` : ""}{detail.replyText ?? ""}</pre>
            )}
          </li>
        ))}
      </ul>
      <style jsx>{`
        .drawer { position: fixed; right: 0; top: 0; bottom: 0; width: 420px; background: var(--bg,#fff); border-left: 1px solid #ccc; padding: 12px; overflow: auto; z-index: 90; }
        header { display: flex; justify-content: space-between; align-items: center; }
        pre { white-space: pre-wrap; background: #f6f6f6; padding: 8px; max-height: 240px; overflow: auto; }
      `}</style>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/features/scheduler/components/RunHistory.tsx
git commit -m "feat(scheduler): run history drawer"
```

---

## Task 17: Wire SchedulesPanel into sidebar

**Files:**
- Modify: `app/features/layout/components/ChatShell.tsx` (extend `mobilePanel` union to include `'schedules'`)
- Modify: the chat page client that owns the right panel (locate by grepping for `rightPanel=` or `AgentsPanel` usage); add a tab/button to swap between AgentsPanel and SchedulesPanel.

- [ ] **Step 1: Locate integration point**

Run: `grep -rn "rightPanel" app | head -20`

- [ ] **Step 2: Extend ChatShell union**

In `ChatShell.tsx`, change `mobilePanel?: 'chat' | 'agents' | 'nodes' | null` to also include `'schedules'`.

- [ ] **Step 3: Mount SchedulesPanel**

In the chat page client (e.g. `app/page.tsx` or `app/features/chat/...`), add state for active right-panel kind and render `<SchedulesPanel agents={agents} />` when selected. Pass the same `agents` array used by `AgentsPanel`.

- [ ] **Step 4: Smoke test in browser**

Start dev: `npx next dev --port 3010` (async). Open browser, log in, switch to Schedules panel, verify list loads.

- [ ] **Step 5: Commit**

```bash
git add app/features/layout/components/ChatShell.tsx app/page.tsx
git commit -m "feat(scheduler): mount SchedulesPanel in right sidebar"
```

---

## Task 18: Playwright E2E

**Files:**
- Create: `test/test-schedules.spec.ts`

- [ ] **Step 1: Tests**

```ts
import { test, expect } from "@playwright/test";

test("create a daily schedule, run now, see history, delete", async ({ page }) => {
  await page.goto("http://localhost:3010/login");
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "admin123");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/");

  await page.getByRole("button", { name: /schedules/i }).click();
  await page.getByRole("button", { name: /\+ New/ }).click();

  await page.getByLabel("Name").fill("e2e job");
  await page.getByLabel("Prompt").fill("hello");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("e2e job")).toBeVisible();
  await page.getByRole("button", { name: "Run now" }).first().click();
  await page.getByRole("button", { name: "History" }).first().click();
  await expect(page.locator(".drawer")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText("e2e job")).toHaveCount(0);
});
```

- [ ] **Step 2: Run**

Run: `npx playwright test --config test/playwright.config.ts test/test-schedules.spec.ts`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add test/test-schedules.spec.ts
git commit -m "test(scheduler): e2e create/run/delete flow"
```

---

## Final verification

- [ ] Run all unit tests: `node --test --experimental-strip-types app/features/scheduler/*.test.mjs lib/scheduler/*.test.mjs`
- [ ] Run Playwright: `npx playwright test --config test/playwright.config.ts`
- [ ] `npm run build` succeeds
- [ ] Hand off via `superpowers:finishing-a-development-branch`
