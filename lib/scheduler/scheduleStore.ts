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
