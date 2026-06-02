import { NextRequest, NextResponse } from 'next/server';
import { getAuthToken, isAdminToken } from '../../../lib/auth';
import { openScheduleStore } from '../../../lib/scheduler/scheduleStore';
import { getRuntime, ensureRuntime } from '../../../lib/scheduler/schedulerRuntime';
import { specToCron, validateSpec } from '../../../app/features/scheduler/scheduleSpec';
import { getAllAgents } from '../../../lib/configStore';
import { DEFAULT_TIMEOUT_MINUTES, MIN_TIMEOUT_MINUTES, MAX_TIMEOUT_MINUTES } from '../../../app/features/scheduler/scheduleTypes';

function normalizeTimeoutMinutes(value: unknown): number | { error: string } {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MINUTES;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { error: 'timeoutMinutes must be an integer' };
  if (n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
    return { error: `timeoutMinutes must be between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES}` };
  }
  return n;
}

export async function GET(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token?.email) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const store = openScheduleStore();
  const isAdmin = isAdminToken(token);
  const all = store.listJobs();
  const jobs = isAdmin ? all : all.filter((j) => j.ownerEmail === token.email);
  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token?.email) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json();
  const { agentId, name, prompt, scheduleSpec, enabled, timeoutMinutes } = body ?? {};
  if (!agentId || !name || !prompt || !scheduleSpec)
    return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  const agent = getAllAgents().find((a) => a.id === agentId);
  if (!agent) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
  try {
    validateSpec(scheduleSpec);
  } catch (e: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  const timeout = normalizeTimeoutMinutes(timeoutMinutes);
  if (typeof timeout !== 'number') return NextResponse.json({ error: timeout.error }, { status: 400 });
  const cronExpr = specToCron(scheduleSpec);
  const store = openScheduleStore();
  const job = store.createJob({
    agentId,
    ownerEmail: token.email as string,
    name,
    prompt,
    scheduleSpec,
    cronExpr,
    enabled: enabled !== false,
    timeoutMinutes: timeout,
  });
  getRuntime()?.scheduleJob(job);
  // Ensure the singleton is initialized in the background so the cron triggers
  // start firing even if instrumentation didn't run yet.
  void ensureRuntime().then((rt) => rt?.scheduleJob(job));
  return NextResponse.json({ job, id: job.id }, { status: 201 });
}
