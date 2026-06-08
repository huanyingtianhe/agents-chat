import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  upsertOrchestration,
  listOrchestrationsForChat,
  deleteOrchestration,
  deleteOrchestrationsForChat,
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

export async function GET(req: NextRequest) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const chatId = req.nextUrl.searchParams.get('chatId');
  if (!chatId) return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });
  const items = await listOrchestrationsForChat(userId, chatId);
  return NextResponse.json({ ok: true, items });
}

export async function POST(req: NextRequest) {
  const userId = await auth(req);
  if (!userId) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { id, chatId, state } = body || {};
  if (typeof id !== 'string' || typeof chatId !== 'string' || !state) {
    return NextResponse.json({ ok: false, error: 'missing_fields' }, { status: 400 });
  }
  await upsertOrchestration(userId, chatId, id, state);
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
