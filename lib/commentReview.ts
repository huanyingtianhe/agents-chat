import type { FileComment, StoredMessage } from './chatStore';

export const COMMENT_REVIEW_CHAT_PREFIX = 'comment-review:';

export function normalizeReviewFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function getCommentReviewChatId(filePath: string): string {
  return `${COMMENT_REVIEW_CHAT_PREFIX}${encodeURIComponent(normalizeReviewFilePath(filePath))}`;
}

export function getCommentReviewChatName(filePath: string): string {
  const normalized = normalizeReviewFilePath(filePath);
  const displayPath = normalized.length > 90 ? `...${normalized.slice(-87)}` : normalized;
  return `Review: ${displayPath}`;
}

export function buildCommentReviewPrompt(comment: Pick<FileComment, 'filePath' | 'rangeStartLine' | 'rangeEndLine' | 'content'>, fileContent?: string): string {
  const rangeLabel = comment.rangeStartLine != null
    ? comment.rangeEndLine != null && comment.rangeEndLine !== comment.rangeStartLine
      ? `lines ${comment.rangeStartLine}-${comment.rangeEndLine}`
      : `line ${comment.rangeStartLine}`
    : 'the file';

  const contextSnippet = fileContent
    ? `\n\nRelevant file content (${comment.filePath}):\n\`\`\`\n${fileContent}\n\`\`\``
    : '';

  return `Review comment on ${comment.filePath} (${rangeLabel}):\n\n"${comment.content}"${contextSnippet}\n\nPlease address this comment by making the necessary changes.`;
}

export function createCommentReviewUserMessage(prompt: string, now = Date.now()): StoredMessage {
  return {
    id: `comment-review-${now}`,
    type: 'user',
    content: prompt,
    ts: now,
  };
}
