import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { putTransferChunk, deleteTransfer, transferStatus } from '@/lib/chatTransferStore';
import { ChatSyncError, isRecord } from '@/lib/chatSyncProtocol';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api.chat-transfers');

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  const userId = String(token.email || token.name || token.sub || 'anonymous');
  try {
    const body: unknown = await req.json();
    if (isRecord(body) && body.userId !== undefined && body.userId !== userId) throw new ChatSyncError('account_changed', 403);
    if (isRecord(body) && body.action === 'status' && typeof body.id === 'string') {
      return NextResponse.json({ ok: true, chunks: transferStatus(userId, body.id) });
    }
    if (isRecord(body) && body.action === 'delete' && typeof body.id === 'string') deleteTransfer(userId, body.id);
    else putTransferChunk(userId, body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ChatSyncError) return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    logger.error({ err: error }, 'Failed to store chat upload');
    return NextResponse.json({ ok: false, error: 'upload_failed' }, { status: 500 });
  }
}
