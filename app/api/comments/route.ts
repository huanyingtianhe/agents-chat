import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  listFileComments,
  createFileComment,
  addFileCommentReply,
  getFileComment,
  getChat,
  resolveProcessingCommentForReviewChat,
  startNextQueuedCommentForReviewChat,
  updateFileCommentStatus,
  deleteFileComment,
} from '@/lib/chatStore';
import {
  buildCommentReviewPrompt,
  createCommentReviewUserMessage,
  getCommentReviewChatName,
} from '@/lib/commentReview';

export const dynamic = 'force-dynamic';

function getUserName(token: any): string {
  return token?.name || token?.email || 'anonymous';
}

function getUserId(token: any): string {
  return token?.email || token?.name || token?.sub || 'anonymous';
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const agentId = req.nextUrl.searchParams.get('agentId');
  const filePath = req.nextUrl.searchParams.get('filePath');
  if (!agentId || !filePath) {
    return NextResponse.json({ ok: false, error: 'agentId and filePath required' }, { status: 400 });
  }

  const comments = await listFileComments(agentId, filePath);
  return NextResponse.json({ ok: true, comments });
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  if (action === 'create') {
    const { agentId, filePath, rangeStartLine, rangeEndLine, rangeStartChar, rangeEndChar, content, authorType, authorName } = body;
    if (!agentId || !filePath || !content || !authorType) {
      return NextResponse.json({ ok: false, error: 'missing required fields' }, { status: 400 });
    }
    const id = await createFileComment({
      agentId, filePath,
      rangeStartLine, rangeEndLine, rangeStartChar, rangeEndChar,
      content,
      authorType,
      authorName: authorName || getUserName(token),
    });
    return NextResponse.json({ ok: true, id });
  }

  if (action === 'reply') {
    const { commentId, content, authorType, authorName } = body;
    if (!commentId || !content || !authorType) {
      return NextResponse.json({ ok: false, error: 'missing required fields' }, { status: 400 });
    }
    const id = await addFileCommentReply({
      commentId, content, authorType,
      authorName: authorName || getUserName(token),
    });
    return NextResponse.json({ ok: true, id });
  }

  if (action === 'resolve') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
    const resolved = await resolveProcessingCommentForReviewChat(getUserId(token), commentId);
    if (resolved.ok) return NextResponse.json({ ok: true });
    if (resolved.reason === 'not_found') return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });
    if (resolved.reason === 'review_chat_not_found') return NextResponse.json({ ok: false, error: 'review chat not found' }, { status: 404 });
    if (resolved.reason === 'missing_linked_chat') {
      return NextResponse.json({ ok: false, error: 'processing comment has no linked chat' }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: 'comment is not processing', status: resolved.comment.status }, { status: 409 });
  }

  if (action === 'reset-processing') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });

    const comment = await getFileComment(commentId);
    if (!comment) return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });
    if (comment.status !== 'processing') {
      return NextResponse.json({ ok: false, error: 'comment is not processing', status: comment.status }, { status: 409 });
    }
    if (!comment.linkedChatId) {
      return NextResponse.json({ ok: false, error: 'processing comment has no linked chat' }, { status: 400 });
    }
    const chat = await getChat(getUserId(token), comment.linkedChatId);
    if (!chat) return NextResponse.json({ ok: false, error: 'review chat not found' }, { status: 404 });

    await updateFileCommentStatus(commentId, 'active', null);
    return NextResponse.json({ ok: true });
  }

  if (action === 'reject') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
    await updateFileCommentStatus(commentId, 'resolved');
    return NextResponse.json({ ok: true });
  }

  if (action === 'delete') {
    const { commentId } = body;
    if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
    await deleteFileComment(commentId);
    return NextResponse.json({ ok: true });
  }

  if (action === 'start-next-queued') {
    const { chatId, fileContent } = body;
    if (typeof chatId !== 'string' || !chatId) {
      return NextResponse.json({ ok: false, error: 'chatId required' }, { status: 400 });
    }

    const userId = getUserId(token);
    const chat = await getChat(userId, chatId);
    if (!chat) {
      return NextResponse.json({ ok: false, error: 'review chat not found' }, { status: 404 });
    }

    const promptFileContent = typeof fileContent === 'string' ? fileContent : undefined;
    const started = await startNextQueuedCommentForReviewChat(
      userId,
      { id: chat.id, name: chat.name },
      (comment) => createCommentReviewUserMessage(buildCommentReviewPrompt(comment, promptFileContent)),
    );
    if (!started) {
      return NextResponse.json({ ok: true, started: false });
    }

    const prompt = started.message.content;
    const chatName = started.chat.name || getCommentReviewChatName(started.comment.filePath);

    return NextResponse.json({
      ok: true,
      started: true,
      commentId: started.comment.id,
      chatId,
      chatName,
      prompt,
      agentId: started.comment.agentId,
      status: 'processing',
    });
  }

  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
