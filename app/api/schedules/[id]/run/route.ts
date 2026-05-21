import { NextRequest, NextResponse } from "next/server";
import { getAuthToken, isAdminToken } from "../../../../../lib/auth";
import { openScheduleStore } from "../../../../../lib/scheduler/scheduleStore";
import { ensureRuntime } from "../../../../../lib/scheduler/schedulerRuntime";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getAuthToken(req);
  const store = openScheduleStore();
  const job = store.getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!token?.email || (!isAdminToken(token) && token.email !== job.ownerEmail))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const rt = await ensureRuntime();
  if (!rt) return NextResponse.json({ error: "runtime unavailable" }, { status: 503 });
  const run = await rt.runNow(id);
  return NextResponse.json({ run });
}
