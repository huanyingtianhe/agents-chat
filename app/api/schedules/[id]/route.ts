import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../../lib/auth";
import { openScheduleStore } from "../../../../lib/scheduler/scheduleStore";
import { getRuntime, ensureRuntime } from "../../../../lib/scheduler/schedulerRuntime";
import { specToCron, validateSpec } from "../../../../app/features/scheduler/scheduleSpec";

function authorize(token: any, ownerEmail: string) {
  return token?.email && (isAdminToken(token) || token.email === ownerEmail);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!authorize(token, job.ownerEmail)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ job, runs: store.listRuns(id) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!authorize(token, job.ownerEmail)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await req.json();
  const patch: any = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.prompt === "string") patch.prompt = body.prompt;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.scheduleSpec) {
    try { validateSpec(body.scheduleSpec); }
    catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }
    patch.scheduleSpec = body.scheduleSpec;
    patch.cronExpr = specToCron(body.scheduleSpec);
  }
  const updated = store.updateJob(id, patch)!;
  getRuntime()?.scheduleJob(updated);
  void ensureRuntime().then((rt) => rt?.scheduleJob(updated));
  return NextResponse.json({ job: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!authorize(token, job.ownerEmail)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  getRuntime()?.unscheduleJob(id);
  void ensureRuntime().then((rt) => rt?.unscheduleJob(id));
  store.deleteJob(id);
  return NextResponse.json({ ok: true });
}
