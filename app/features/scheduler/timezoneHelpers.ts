// Helpers for converting between local wall-clock time (shown in the UI)
// and UTC (how schedules are stored and how the server-side cron is run).
//
// Schedules are stored with UTC hour/minute/weekday because the runtime
// registers cron tasks with `{ timezone: "UTC" }`. Users, however, think
// and enter times in their browser's local zone, so the editor must
// convert at the boundary.
//
// Conversion is approximated using the browser's current UTC offset (via
// `Date#getTimezoneOffset`). This is exact for fixed-offset zones such as
// Asia/Shanghai (UTC+8). In zones that observe DST the converted time can
// drift by an hour across DST transitions; that's acceptable for the
// current MVP and matches how `node-cron` behaves with a fixed timezone.

export interface HMShift {
  hour: number;
  minute: number;
  dayShift: number; // -1, 0, or +1 days relative to the source date
}

function currentOffsetMinutes(): number {
  // Date#getTimezoneOffset returns (UTC - local) in minutes.
  // For UTC+8 it returns -480, meaning UTC = local + (-480) min.
  return new Date().getTimezoneOffset();
}

function normalize(totalMinutes: number): { hour: number; minute: number; dayShift: number } {
  let dayShift = 0;
  let t = totalMinutes;
  while (t < 0) {
    t += 24 * 60;
    dayShift -= 1;
  }
  while (t >= 24 * 60) {
    t -= 24 * 60;
    dayShift += 1;
  }
  return { hour: Math.floor(t / 60), minute: t % 60, dayShift };
}

export function localHMToUtc(hour: number, minute: number): HMShift {
  const offset = currentOffsetMinutes();
  // UTC = local + offset
  return normalize(hour * 60 + minute + offset);
}

export function utcHMToLocal(hour: number, minute: number): HMShift {
  const offset = currentOffsetMinutes();
  // local = UTC - offset
  return normalize(hour * 60 + minute - offset);
}

export function shiftWeekday(weekday: number, dayShift: number): number {
  return ((weekday + dayShift) % 7 + 7) % 7;
}
