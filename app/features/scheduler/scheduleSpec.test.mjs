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
