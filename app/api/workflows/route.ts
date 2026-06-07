import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { listUserWorkflows, saveUserWorkflow } from '@/lib/workflowStore';
import { loadRepoWorkflows } from '@/lib/workflow/repoWorkflows.mjs';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  return token?.email || token?.name || token?.sub || 'anonymous';
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const userId = getUserId(token);
  const [user, repo] = await Promise.all([
    Promise.resolve(listUserWorkflows(userId)),
    loadRepoWorkflows(),
  ]);
  return NextResponse.json({ ok: true, user, repo });
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const userId = getUserId(token);
  const body = await req.json().catch(() => ({}));
  const { id, name, plan } = body || {};
  if (typeof name !== 'string' || !plan) {
    return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  }
  const res = saveUserWorkflow(userId, { id, name, plan });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, workflow: res.workflow });
}
