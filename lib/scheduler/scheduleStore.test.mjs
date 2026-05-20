import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openScheduleStore } from "./scheduleStore.ts";

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "sched-"));
  const store = openScheduleStore(path.join(dir, "test.db"));
  return { 
    store, 
    cleanup: () => {
      store._db.close();
      rmSync(dir, { recursive: true, force: true });
    } 
  };
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
