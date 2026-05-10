import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import {
  approveCommentForReviewChat,
  getFileComment,
} from '@/lib/chatStore';
import {
  buildCommentReviewPrompt,
  createCommentReviewUserMessage,
  getCommentReviewChatId,
  getCommentReviewChatName,
} from '@/lib/commentReview';

export const dynamic = 'force-dynamic';

function getUserId(token: any): string {
  return token?.email || token?.name || token?.sub || 'anonymous';
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { commentId, fileContent } = body;
  if (!commentId) {
    return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
  }

  const comment = await getFileComment(commentId);
  if (!comment) {
    return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });
  }

  const userId = getUserId(token);
  const chatId = getCommentReviewChatId(comment.filePath);
  const chatName = getCommentReviewChatName(comment.filePath);
  const prompt = buildCommentReviewPrompt(comment, fileContent);
  const approval = await approveCommentForReviewChat(
    userId,
    commentId,
    { id: chatId, name: chatName },
    createCommentReviewUserMessage(prompt),
  );
  if (!approval) {
    return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });
  }
  if (approval.status === 'resolved') {
    return NextResponse.json({ ok: false, error: 'comment already resolved', status: 'resolved' }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    chatId: approval.comment.linkedChatId || chatId,
    chatName,
    prompt,
    agentId: approval.comment.agentId,
    status: approval.status,
  });
}
