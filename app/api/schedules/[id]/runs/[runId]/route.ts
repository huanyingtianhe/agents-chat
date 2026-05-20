import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../../../../lib/auth";
import { openScheduleStore } from "../../../../../../lib/scheduler/scheduleStore";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!token?.email || (!isAdminToken(token) && token.email !== job.ownerEmail))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const run = store.getRun(runId);
  if (!run || run.jobId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ run });
}
