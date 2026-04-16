import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { listChats, getChat, saveChat, deleteChat, migrateFromJson, StoredChat } from '@/lib/chatStore';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  return token?.email || token?.name || token?.sub || 'anonymous';
}

function isAdminToken(token: any): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!token) return false;
  if (token.role === 'admin' || token.sub === 'admin') return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((token.email || '').toLowerCase());
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const chatId = req.nextUrl.searchParams.get('id');

  if (chatId) {
    const chat = await getChat(userId, chatId);
    if (!chat) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, chat });
  }

  const chats = await listChats(userId);
  return NextResponse.json({ ok: true, chats });
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const body = await req.json().catch(() => ({}));

  // Admin-only: migrate JSON files to SQLite
  if (body?.action === 'migrate') {
    if (!isAdminToken(token)) return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
    const result = await migrateFromJson();
    return NextResponse.json({ ok: true, migrated: result });
  }

  const chat = body?.chat as StoredChat | undefined;

  if (!chat?.id || !chat?.name || !Array.isArray(chat?.messages)) {
    return NextResponse.json({ ok: false, error: 'invalid_chat' }, { status: 400 });
  }

  // Ensure agentSessions is present
  if (!chat.agentSessions) chat.agentSessions = {};

  await saveChat(userId, chat);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const chatId = req.nextUrl.searchParams.get('id');
  if (!chatId) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  await deleteChat(userId, chatId);
  return NextResponse.json({ ok: true });
}
