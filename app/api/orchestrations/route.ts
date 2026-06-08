import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  upsertOrchestrationParent,
  listOrchestrationsForChat,
  deleteOrchestration,
  deleteOrchestrationsForChat,
  StoredOrchestration,
} from '@/lib/chatStore';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  return token?.email || token?.name || token?.sub || 'anonymous';
}

async function auth(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return null;
  return getUserId(token);
}

/** Rebuild an OrchestrationState-shaped object from parent + node rows. */
function reconstructState(stored: StoredOrchestration): unknown {
  const plan = (stored.plan && typeof stored.plan === 'object') ? stored.plan as Record<string, unknown> : {};
  const nodeStatuses: Record<string, string> = {};
  const results: Record<string, string> = {};
  for (const n of stored.nodes) {
    nodeStatuses[n.nodeId] = n.status;
    if (n.result != null) results[n.nodeId] = n.result;
  }
  return {
    ...plan,
    id: stored.id,
    mode: stored.mode,
    sourceChatId: stored.chatId,
    summaryStarted: stored.summaryStarted,
    nodeStatuses,
    results,
  };
}

export async function GET(req: NextRequest) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (!chatId) return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });
  const stored = await listOrchestrationsForChat(userId, chatId);
  const items = stored.map((s) => ({ id: s.id, state: reconstructState(s) }));
  return NextResponse.json({ ok: true, items });
}

/**
 * PUT — UPSERT the parent orchestration row (immutable plan + summary flag).
 * Body: { id, chatId, mode, plan, summaryStarted }
 */
export async function PUT(req: NextRequest) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { id, chatId, mode, plan, summaryStarted } = body || {};
  if (typeof id !== 'string' || typeof chatId !== 'string' || typeof mode !== 'string' || plan == null) {
    return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  }
  await upsertOrchestrationParent(userId, chatId, id, mode, plan, !!summaryStarted);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (id) {
    await deleteOrchestration(userId, id);
    return NextResponse.json({ ok: true });
  }
  if (chatId) {
    await deleteOrchestrationsForChat(userId, chatId);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: 'missing_id_or_chatId' }, { status: 400 });
}
