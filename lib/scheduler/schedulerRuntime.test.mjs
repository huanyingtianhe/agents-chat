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
