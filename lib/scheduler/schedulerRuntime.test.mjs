import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openScheduleStore } from "./scheduleStore.ts";
import { createRuntime, ensureRuntime, getRuntime, setRuntime } from "./schedulerRuntime.ts";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "rt-"));
  const store = openScheduleStore(path.join(dir, "t.db"));
  const tasks = [];
  const cron = {
    schedule: (expr, fn) => {
      const t = {
        expr,
        fn,
        stopCount: 0,
        destroyCount: 0,
        stop() { this.stopCount += 1; },
        destroy() { this.destroyCount += 1; },
      };
      tasks.push(t);
      return t;
    },
  };
  const calls = [];
  const runner = { runAgentOnce: async (job) => { calls.push(job.id); return { replyText: "ok", rawLog: "log", error: null }; } };
  return { dir, store, cron, runner, calls, tasks, cleanup: () => { store._db.close(); rmSync(dir, { recursive: true, force: true }); } };
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

test("scheduleJob replaces existing task and calls stop+destroy on the old one", async () => {
  const s = setup();
  try {
    const j = s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n", prompt: "p",
      scheduleSpec: { kind: "every_minutes", interval: 1 }, cronExpr: "*/1 * * * *", enabled: true });
    const rt = createRuntime({ store: s.store, runner: s.runner, cron: s.cron, now: () => 1000 });
    await rt.start();
    assert.equal(s.tasks.length, 1);
    const oldTask = s.tasks[0];
    assert.equal(oldTask.expr, "*/1 * * * *");

    // Simulate the user editing the schedule from 1 -> 10 minutes.
    const updated = s.store.updateJob(j.id, {
      scheduleSpec: { kind: "every_minutes", interval: 10 },
      cronExpr: "*/10 * * * *",
    });
    rt.scheduleJob(updated);

    // The old task must be both stopped AND destroyed. node-cron 4.x leaks
    // the internal registration if you only call stop(), which is exactly
    // why edited schedules kept firing at the old interval.
    assert.equal(oldTask.stopCount, 1, "old task should be stopped");
    assert.equal(oldTask.destroyCount, 1, "old task should be destroyed");
    assert.equal(s.tasks.length, 2);
    assert.equal(s.tasks[1].expr, "*/10 * * * *");
  } finally { s.cleanup(); }
});

test("unscheduleJob calls stop+destroy and removes the task", async () => {
  const s = setup();
  try {
    const j = s.store.createJob({ agentId: "a", ownerEmail: "u", name: "n", prompt: "p",
      scheduleSpec: { kind: "every_minutes", interval: 1 }, cronExpr: "*/1 * * * *", enabled: true });
    const rt = createRuntime({ store: s.store, runner: s.runner, cron: s.cron, now: () => 1000 });
    await rt.start();
    const t = s.tasks[0];
    rt.unscheduleJob(j.id);
    assert.equal(t.stopCount, 1);
    assert.equal(t.destroyCount, 1);
    // Re-scheduling after unschedule should not touch the already-destroyed task again.
    rt.unscheduleJob(j.id);
    assert.equal(t.stopCount, 1);
    assert.equal(t.destroyCount, 1);
  } finally { s.cleanup(); }
});

test("ensureRuntime is a no-op when a singleton already exists on globalThis (HMR survival)", async () => {
  // Simulate a runtime that was created by an earlier module evaluation
  // (i.e. before Turbopack HMR re-imported this module). ensureRuntime must
  // return that same instance instead of constructing a second runtime that
  // would leak duplicate cron tasks.
  const prev = getRuntime();
  const fake = { __marker: "fake-singleton" };
  setRuntime(fake);
  try {
    const a = await ensureRuntime();
    const b = await ensureRuntime();
    assert.strictEqual(a, fake);
    assert.strictEqual(b, fake);
  } finally {
    setRuntime(prev);
  }
});
