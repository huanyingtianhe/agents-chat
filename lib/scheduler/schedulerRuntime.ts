import type { ScheduleStore } from "./scheduleStore.ts";
import type { CronJob, CronRun } from "../../app/features/scheduler/scheduleTypes.ts";
import { nextFires } from "../../app/features/scheduler/scheduleSpec.ts";
import { createLogger } from "../logger.ts";

const logger = createLogger("scheduler");

type Runner = { runAgentOnce: (job: CronJob, opts?: { timeoutMs?: number }) => Promise<{ replyText: string; rawLog: string; error: string | null }> };
type CronTaskLike = { stop: () => void; destroy?: () => void };
type CronLike = { schedule: (expr: string, fn: () => void, opts?: { timezone?: string }) => CronTaskLike };

export type SchedulerRuntime = ReturnType<typeof createRuntime>;

export function createRuntime(deps: { store: ScheduleStore; runner: Runner; cron: CronLike; now: () => number; backfillCap?: number }) {
  const { store, runner, cron, now } = deps;
  const backfillCap = deps.backfillCap ?? 100;
  const tasks = new Map<string, CronTaskLike>();
  const queues = new Map<string, Promise<void>>();

  async function start(): Promise<void> {
    store.markOrphansAsError(now());
    for (const job of store.listEnabledJobs()) {
      await backfill(job);
      register(job);
    }
  }

  function killTask(t: CronTaskLike): void {
    try { t.stop(); } catch { /* ignore */ }
    try { t.destroy?.(); } catch { /* ignore */ }
  }

  function stop(): void {
    for (const t of tasks.values()) killTask(t);
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
    const res = await runner.runAgentOnce(job, job.timeoutMinutes ? { timeoutMs: job.timeoutMinutes * 60_000 } : undefined);
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
    if (t) { killTask(t); tasks.delete(jobId); }
  }

  return { start, stop, scheduleJob, unscheduleJob, runNow, enqueueTick };
}

// Use globalThis so that Next.js dev mode HMR (which can re-evaluate this
// module) doesn't create a second singleton. Without this, an old module
// instance can keep its cron tasks alive while a new instance has no record
// of them, so unscheduleJob() can never stop them.
type GlobalScope = typeof globalThis & {
  __scheduler_singleton?: SchedulerRuntime | null;
  __scheduler_ensure?: Promise<SchedulerRuntime | null> | null;
};
const g = globalThis as GlobalScope;

export function getRuntime(): SchedulerRuntime | null { return g.__scheduler_singleton ?? null; }
export function setRuntime(rt: SchedulerRuntime | null) { g.__scheduler_singleton = rt; }

export async function ensureRuntime(): Promise<SchedulerRuntime | null> {
  if (g.__scheduler_singleton) return g.__scheduler_singleton;
  if (g.__scheduler_ensure) return g.__scheduler_ensure;
  g.__scheduler_ensure = (async () => {
    try {
      const cron = await import("node-cron");
      const { openScheduleStore } = await import("./scheduleStore");
      const { runAgentOnce } = await import("./agentRunner");
      if (g.__scheduler_singleton) return g.__scheduler_singleton;
      const store = openScheduleStore();
      const rt = createRuntime({
        store,
        runner: { runAgentOnce },
        cron: { schedule: (expr, fn, opts) => cron.schedule(expr, fn, opts as any) },
        now: () => Date.now(),
      });
      g.__scheduler_singleton = rt;
      await rt.start();
      return rt;
    } catch (err) {
      logger.error({ err }, "[scheduler] ensureRuntime failed");
      g.__scheduler_ensure = null;
      return null;
    }
  })();
  return g.__scheduler_ensure;
}
