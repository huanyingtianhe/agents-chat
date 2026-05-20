import { NextRequest, NextResponse } from 'next/server';
import { getAuthToken, isAdminToken } from '../../../lib/auth';
import { openScheduleStore } from '../../../lib/scheduler/scheduleStore';
import { getRuntime } from '../../../lib/scheduler/schedulerRuntime';
import { specToCron, validateSpec } from '../../../app/features/scheduler/scheduleSpec';
import { getAllAgents } from '../../../lib/configStore';

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
  const { agentId, name, prompt, scheduleSpec, enabled } = body ?? {};
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
  });
  getRuntime()?.scheduleJob(job);
  return NextResponse.json({ job }, { status: 201 });
}
