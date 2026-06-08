import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { upsertOrchestrationNode } from '@/lib/chatStore';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  return token?.email || token?.name || token?.sub || 'anonymous';
}

const VALID_STATUSES = new Set([
  'pending', 'running', 'awaiting-input',
  'ok', 'failed', 'skipped', 'stopped',
]);

/**
 * PATCH /api/orchestrations/:id/nodes/:nodeId
 * Body: { status, result }
 * UPSERT a single node row. Returns 404 if parent orchestration doesn't exist.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; nodeId: string }> },
) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const userId = getUserId(token);

  const { id, nodeId } = await params;
  if (!id || !nodeId) {
    return NextResponse.json({ ok: false, error: 'missing_params' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const { status, result } = body || {};
  if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
    return NextResponse.json({ ok: false, error: 'invalid_status' }, { status: 400 });
  }
  const resultValue: string | null =
    result == null ? null : (typeof result === 'string' ? result : String(result));

  const ok = await upsertOrchestrationNode(userId, id, nodeId, status, resultValue);
  if (!ok) {
    return NextResponse.json({ ok: false, error: 'parent_not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
