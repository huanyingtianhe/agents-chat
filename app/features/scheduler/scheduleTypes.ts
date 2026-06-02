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
  timeoutMinutes: number;
};

export const DEFAULT_TIMEOUT_MINUTES = 10;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 1440;

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
