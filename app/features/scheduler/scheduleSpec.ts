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
