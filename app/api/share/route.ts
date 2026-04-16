import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { getChat, shareChat, getSharedChat, saveChat } from '@/lib/chatStore';
import * as crypto from 'crypto';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  return token?.email || token?.name || token?.sub || 'anonymous';
}

/** POST — create a share link OR import a shared chat */
export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const body = await req.json().catch(() => ({}));
  const action = body?.action as string | undefined;

  // Import a shared chat into user's own history
  if (action === 'import') {
    const shareId = body?.shareId as string | undefined;
    if (!shareId) return NextResponse.json({ ok: false, error: 'missing_shareId' }, { status: 400 });

    const shared = await getSharedChat(shareId);
    if (!shared) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

    const chatId = `shared-${crypto.randomBytes(4).toString('hex')}`;
    await saveChat(userId, {
      id: chatId,
      name: shared.name,
      ts: Date.now(),
      messages: shared.messages,
      agentSessions: {},
    });

    return NextResponse.json({ ok: true, chatId });
  }

  // Create a share link
  const chatId = body?.chatId as string | undefined;
  if (!chatId) return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });

  const chat = await getChat(userId, chatId);
  if (!chat) return NextResponse.json({ ok: false, error: 'chat_not_found' }, { status: 404 });

  const userMessages = chat.messages.filter(m => m.type === 'user');
  if (userMessages.length === 0) {
    return NextResponse.json({ ok: false, error: 'cannot_share_empty_chat' }, { status: 400 });
  }

  const shareId = await shareChat(userId, chat);
  return NextResponse.json({ ok: true, shareId, url: `/share/${shareId}` });
}

/** GET — fetch a shared chat by shareId */
export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const shareId = req.nextUrl.searchParams.get('id');
  if (!shareId) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  const shared = await getSharedChat(shareId);
  if (!shared) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });

  return NextResponse.json({ ok: true, chat: shared });
}
