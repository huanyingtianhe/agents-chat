'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMENT_SIDEBAR_CARD_GAP,
  COMMENT_SIDEBAR_CARD_PADDING,
  COMMENT_SIDEBAR_COLLAPSED_CARD_HEIGHT,
  COMMENT_SIDEBAR_EXPANDED_CARD_HEIGHT,
  FILE_REVIEW_LINE_HEIGHT,
  extractFileCommentsFromText,
  isMarkdownFile,
} from '../fileWorkspaceHelpers';
import type { CommentAddRange, ExtractedAgentFileComment, FileComment } from '../fileWorkspaceTypes';
import type { UseFileWorkspaceStateResult } from './useFileWorkspaceState';
import { useLiveEditorSelection } from './useLiveEditorSelection';
import type { UseFileCommentsDeps, UseFileCommentsResult } from './fileCommentsHookTypes';
export type { UseFileCommentsResult } from './fileCommentsHookTypes';
export function useFileComments(workspace: UseFileWorkspaceStateResult, deps: UseFileCommentsDeps): UseFileCommentsResult {
  const [commentSidebarOpen, setCommentSidebarOpen] = useState(false);
  const [fileComments, setFileComments] = useState<FileComment[]>([]);
  const fileCommentsRef = useRef<FileComment[]>([]);
  fileCommentsRef.current = fileComments;
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [commentFilter, setCommentFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [commentInput, setCommentInput] = useState('');
  const [commentAddRange, setCommentAddRange] = useState<CommentAddRange | null>(null);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [replyInput, setReplyInput] = useState('');
  const [expandedReplyIds, setExpandedReplyIds] = useState<Set<string>>(new Set());
  const commentSidebarRef = useRef<HTMLDivElement>(null);
  const commentAddFormRef = useRef<HTMLDivElement>(null);
  const [commentSourceScrollTop, setCommentSourceScrollTop] = useState(0);
  useEffect(() => {
    if (!deps.mounted) return;
    const savedCommentSidebar = window.localStorage.getItem('commentSidebarOpen');
    if (savedCommentSidebar != null) setCommentSidebarOpen(savedCommentSidebar === 'true');
  }, [deps.mounted]);
  useEffect(() => {
    if (deps.mounted) window.localStorage.setItem('commentSidebarOpen', String(commentSidebarOpen));
  }, [commentSidebarOpen, deps.mounted]);
  useEffect(() => {
    workspace.setWorkspaceScrollTop(commentSourceScrollTop);
  }, [commentSourceScrollTop, workspace.setWorkspaceScrollTop]);
  const loadFileComments = useCallback(async (agentId: string, filePath: string) => {
    try {
      const res = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.ok) setFileComments(data.comments);
    } catch {
      // Comment loading should never block opening files.
    }
  }, []);
  const getCommentsByLine = useCallback((): Map<number, FileComment[]> => {
    const map = new Map<number, FileComment[]>();
    for (const c of fileComments) {
      if (c.rangeStartLine == null) continue;
      const end = c.rangeEndLine ?? c.rangeStartLine;
      for (let i = c.rangeStartLine; i <= end; i++) {
        const comments = map.get(i) || [];
        comments.push(c);
        map.set(i, comments);
      }
    }
    return map;
  }, [fileComments]);
  const selection = useLiveEditorSelection({
    workspace,
    fileComments,
    selectedCommentId,
    commentSidebarOpen,
    commentAddRange,
    showCommentInput,
    setCommentSourceScrollTop,
    setCommentAddRange,
    setShowCommentInput,
    setCommentSidebarOpen,
    getCommentsByLine,
  });
  const resetForFileOpen = useCallback((agentId: string, filePath: string, restoreScrollTop = 0) => {
    setCommentSourceScrollTop(restoreScrollTop);
    const applyScroll = () => {
      selection.mdLiveContainerRef.current?.scrollTo({ top: restoreScrollTop });
      selection.fileContentRef.current?.scrollTo({ top: restoreScrollTop });
    };
    window.requestAnimationFrame(() => {
      applyScroll();
      window.requestAnimationFrame(() => {
        applyScroll();
        window.setTimeout(applyScroll, 120);
      });
    });
    setFileComments([]);
    setSelectedCommentId(null);
    setShowCommentInput(false);
    setCommentAddRange(null);
    selection.clearLiveSelectionDraft();
    void loadFileComments(agentId, filePath);
  }, [loadFileComments, selection]);
  const createComment = useCallback(async (range: CommentAddRange, content: string) => {
    if (!workspace.mdSelectedAgentId || !workspace.mdSelectedFile || !content.trim()) return;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId: workspace.mdSelectedAgentId,
          filePath: workspace.mdSelectedFile,
          rangeStartLine: range.startLine,
          rangeEndLine: range.endLine,
          rangeStartChar: range.startChar,
          rangeEndChar: range.endChar,
          content: content.trim(),
          authorType: 'user',
        }),
      });
      const data = await res.json();
      if (!data.ok) return;
      const submitAnchorTop = selection.liveSelectionDraftAnchor?.rects?.[0]?.top;
      if (typeof data.id === 'string' && submitAnchorTop != null) {
        selection.recentLiveCommentAnchorsRef.current.set(data.id, submitAnchorTop);
      }
      setCommentInput('');
      setShowCommentInput(false);
      setCommentAddRange(null);
      selection.clearLiveSelectionDraft();
      await loadFileComments(workspace.mdSelectedAgentId, workspace.mdSelectedFile);
      if (!commentSidebarOpen) setCommentSidebarOpen(true);
      if (typeof data.id === 'string') setSelectedCommentId(data.id);
    } catch {
      // Ignore comment save failures; the UI remains editable.
    }
  }, [commentSidebarOpen, loadFileComments, selection, workspace.mdSelectedAgentId, workspace.mdSelectedFile]);
  const handleCreateComment = useCallback(async () => {
    if (!commentAddRange) return;
    await createComment(commentAddRange, commentInput);
  }, [commentAddRange, commentInput, createComment]);
  const handleRejectComment = useCallback(async (commentId: string) => {
    try {
      await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject', commentId }) });
      if (workspace.mdSelectedAgentId && workspace.mdSelectedFile) void loadFileComments(workspace.mdSelectedAgentId, workspace.mdSelectedFile);
    } catch {
      // Ignore network errors for comment mutations.
    }
  }, [loadFileComments, workspace.mdSelectedAgentId, workspace.mdSelectedFile]);
  const handleDeleteComment = useCallback(async (commentId: string) => {
    try {
      await fetch('/api/comments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', commentId }) });
      if (selectedCommentId === commentId) setSelectedCommentId(null);
      if (workspace.mdSelectedAgentId && workspace.mdSelectedFile) void loadFileComments(workspace.mdSelectedAgentId, workspace.mdSelectedFile);
    } catch {
      // Ignore network errors for comment mutations.
    }
  }, [loadFileComments, selectedCommentId, workspace.mdSelectedAgentId, workspace.mdSelectedFile]);
  const handleReplyComment = useCallback(async (commentId: string) => {
    if (!replyInput.trim()) return;
    try {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reply', commentId, content: replyInput.trim(), authorType: 'user' }),
      });
      setReplyInput('');
      setReplyingToCommentId(null);
      if (workspace.mdSelectedAgentId && workspace.mdSelectedFile) void loadFileComments(workspace.mdSelectedAgentId, workspace.mdSelectedFile);
    } catch {
      // Ignore network errors for comment mutations.
    }
  }, [loadFileComments, replyInput, workspace.mdSelectedAgentId, workspace.mdSelectedFile]);
  const openCommentReviewChat = useCallback((chatId: string) => {
    void deps.onOpenReviewChat(chatId);
  }, [deps]);
  const getContextForComment = useCallback((comment: FileComment) => {
    const lines = workspace.mdFileContent.split('\n');
    const startLine = Math.max(0, (comment.rangeStartLine ?? 1) - 3);
    const endLine = Math.min(lines.length, (comment.rangeEndLine ?? comment.rangeStartLine ?? 1) + 3);
    return lines.slice(startLine, endLine).join('\n');
  }, [workspace.mdFileContent]);
  const resetProcessingCommentForRetry = useCallback(async (commentId: string) => {
    setFileComments(prev => prev.map(c => c.id === commentId ? { ...c, status: 'active' as const, linkedChatId: null } : c));
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset-processing', commentId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Failed to reset processing comment', data.error || res.statusText);
      }
    } catch (err) {
      console.error('Failed to reset processing comment', err);
    }
  }, []);
  const dispatchReviewCommentToAgent = useCallback(async (agentId: string, prompt: string, commentId: string, chatId: string) => {
    try {
      await deps.onDispatchToAgent(agentId, prompt, `comment-${commentId}`, 'worker', { chatId, commentId });
      return true;
    } catch (err) {
      console.error('Failed to dispatch approved comment', err);
      await resetProcessingCommentForRetry(commentId);
      return false;
    }
  }, [deps, resetProcessingCommentForRetry]);
  const startNextQueuedComment = useCallback(async (chatId: string) => {
    const queuedComment = fileCommentsRef.current.find(c => c.linkedChatId === chatId && c.status === 'queued');
    const fileContent = queuedComment ? getContextForComment(queuedComment) : workspace.mdFileContent;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start-next-queued', chatId, fileContent }),
      });
      const data = await res.json();
      if (!data.ok || !data.started) return;
      setFileComments(prev => prev.map(c => c.id === data.commentId ? { ...c, status: 'processing' as const, linkedChatId: data.chatId } : c));
      await deps.onLoadChatIntoCache(data.chatId);
      if (data.agentId && data.prompt) await dispatchReviewCommentToAgent(data.agentId, data.prompt, data.commentId, data.chatId);
    } catch (err) {
      console.error('Failed to start queued comment', err);
    }
  }, [deps, dispatchReviewCommentToAgent, getContextForComment, workspace.mdFileContent]);
  const resolveProcessingCommentForChat = useCallback(async (chatId: string, commentId: string) => {
    const commentToResolve = fileCommentsRef.current.find(c => c.id === commentId && c.linkedChatId === chatId && c.status === 'processing');
    if (!commentToResolve) return;
    setFileComments(prev => prev.map(c => c.id === commentToResolve.id ? { ...c, status: 'resolved' as const } : c));
    try {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', commentId: commentToResolve.id }),
      });
    } catch (err) {
      console.error('Failed to resolve comment', err);
    }
    await startNextQueuedComment(chatId);
  }, [startNextQueuedComment]);
  const handleStopProcessingComment = useCallback(async (comment: FileComment) => {
    if (comment.status !== 'processing' || !comment.linkedChatId) return;
    const reviewChatId = comment.linkedChatId;
    const activeRun = deps.onGetActiveRun(reviewChatId, comment.id);
    const agentId = activeRun?.agentId || comment.agentId;
    try {
      await deps.onInterruptAgent(agentId, reviewChatId);
    } catch (err) {
      console.error('Failed to stop processing comment', err);
      return;
    }
    if (activeRun) {
      deps.onUpdateMessage(activeRun.pendingId, {
        content: activeRun.currentText || '⏹ Stopped',
        pending: false,
        statusText: undefined,
        ptyPhase: undefined,
        userRequest: undefined,
      }, activeRun.chatId);
      deps.onDeleteActiveRun(activeRun.runKey);
      deps.onRunStateChanged();
    }
    await resetProcessingCommentForRetry(comment.id);
    setSelectedCommentId(comment.id);
    await startNextQueuedComment(reviewChatId);
  }, [deps, resetProcessingCommentForRetry, startNextQueuedComment]);
  const handleApproveComment = useCallback(async (commentId: string) => {
    const comment = fileComments.find(c => c.id === commentId);
    if (!comment) return;
    try {
      const res = await fetch('/api/comments/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, fileContent: getContextForComment(comment) }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Failed to approve comment', data.error || 'unknown error');
        return;
      }
      const nextStatus: FileComment['status'] = data.status === 'queued' ? 'queued' : 'processing';
      setFileComments(prev => prev.map(c => c.id === commentId ? { ...c, status: nextStatus, linkedChatId: data.chatId } : c));
      await deps.onLoadChatIntoCache(data.chatId);
      if (nextStatus === 'processing' && data.agentId && data.prompt) {
        await dispatchReviewCommentToAgent(data.agentId, data.prompt, commentId, data.chatId);
      }
    } catch (err) {
      console.error('Failed to approve comment', err);
    }
  }, [deps, dispatchReviewCommentToAgent, fileComments, getContextForComment]);
  const getCommentLineTop = useCallback((comment: FileComment): number => Math.max(0, ((comment.rangeStartLine ?? 1) - 1) * FILE_REVIEW_LINE_HEIGHT), []);
  const getCommentDisplayTop = useCallback((comment: FileComment): number => {
    if (workspace.mdEditorMode === 'live' && workspace.mdSelectedFile && isMarkdownFile(workspace.mdSelectedFile)) {
      const recent = selection.recentLiveCommentAnchorsRef.current.get(comment.id);
      if (recent != null) return recent;
      const marker = selection.liveCommentMarkers.find(m => m.commentIds.includes(comment.id));
      if (marker) return marker.top;
    }
    return getCommentLineTop(comment);
  }, [getCommentLineTop, selection.liveCommentMarkers, selection.recentLiveCommentAnchorsRef, workspace.mdEditorMode, workspace.mdSelectedFile]);
  const getVisibleSidebarComments = useCallback((): FileComment[] => fileComments
    .filter(c => commentFilter === 'all' || (commentFilter === 'active' ? c.status !== 'resolved' : c.status === 'resolved'))
    .slice()
    .sort((a, b) => {
      const lineDiff = (a.rangeStartLine ?? Number.MAX_SAFE_INTEGER) - (b.rangeStartLine ?? Number.MAX_SAFE_INTEGER);
      if (lineDiff !== 0) return lineDiff;
      return a.createdAt.localeCompare(b.createdAt);
    }), [commentFilter, fileComments]);
  const getEstimatedCommentCardHeight = useCallback((comment: FileComment): number => {
    const expanded = selectedCommentId === comment.id || comment.status === 'processing' || comment.status === 'queued';
    const replyHeight = expanded ? Math.min(comment.replies.length, 2) * 24 : 0;
    const replyInputHeight = replyingToCommentId === comment.id ? 40 : 0;
    return (expanded ? COMMENT_SIDEBAR_EXPANDED_CARD_HEIGHT : COMMENT_SIDEBAR_COLLAPSED_CARD_HEIGHT) + replyHeight + replyInputHeight;
  }, [replyingToCommentId, selectedCommentId]);
  const getCommentStatusLabel = useCallback((status: FileComment['status']): string => {
    if (status === 'processing') return 'Processing';
    if (status === 'queued') return 'Queued';
    if (status === 'resolved') return 'Resolved';
    return 'Active';
  }, []);
  const getCommentSidebarDesiredTop = useCallback((comment: FileComment): number => getCommentDisplayTop(comment) - commentSourceScrollTop, [commentSourceScrollTop, getCommentDisplayTop]);
  const compareCommentsBySidebarTop = useCallback((a: FileComment, b: FileComment): number => {
    const topDiff = getCommentDisplayTop(a) - getCommentDisplayTop(b);
    if (Math.abs(topDiff) > 0.5) return topDiff;
    const lineDiff = (a.rangeStartLine ?? Number.MAX_SAFE_INTEGER) - (b.rangeStartLine ?? Number.MAX_SAFE_INTEGER);
    if (lineDiff !== 0) return lineDiff;
    return a.createdAt.localeCompare(b.createdAt);
  }, [getCommentDisplayTop]);
  const getCommentSidebarLayout = useCallback((comments: FileComment[]): Map<string, number> => {
    const layout = new Map<string, number>();
    const placeComments = (commentsToPlace: FileComment[], startTop: number): number => {
      let nextAvailableTop = startTop;
      for (const comment of commentsToPlace) {
        const top = Math.max(getCommentSidebarDesiredTop(comment), nextAvailableTop);
        layout.set(comment.id, top);
        nextAvailableTop = top + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP;
      }
      return nextAvailableTop;
    };
    const sortedComments = comments.slice().sort(compareCommentsBySidebarTop);
    const selectedComment = sortedComments.find(c => c.id === selectedCommentId);
    if (selectedComment && workspace.mdEditorMode === 'live' && workspace.mdSelectedFile && isMarkdownFile(workspace.mdSelectedFile)) {
      const selectedTop = getCommentSidebarDesiredTop(selectedComment);
      const commentsBeforeSelected: FileComment[] = [];
      const commentsAfterSelected: FileComment[] = [];
      for (const comment of sortedComments) {
        if (comment.id === selectedComment.id) continue;
        const desiredTop = getCommentSidebarDesiredTop(comment);
        const bottom = desiredTop + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP;
        if (bottom <= selectedTop) commentsBeforeSelected.push(comment);
        else commentsAfterSelected.push(comment);
      }
      const beforeBottom = placeComments(commentsBeforeSelected, -commentSourceScrollTop);
      layout.set(selectedComment.id, selectedTop);
      placeComments(commentsAfterSelected, Math.max(beforeBottom, selectedTop + getEstimatedCommentCardHeight(selectedComment) + COMMENT_SIDEBAR_CARD_GAP));
      return layout;
    }
    let nextAvailableTop = -commentSourceScrollTop;
    for (const comment of sortedComments) {
      const top = Math.max(getCommentSidebarDesiredTop(comment), nextAvailableTop);
      layout.set(comment.id, top);
      nextAvailableTop = top + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP;
    }
    return layout;
  }, [commentSourceScrollTop, compareCommentsBySidebarTop, getCommentSidebarDesiredTop, getEstimatedCommentCardHeight, selectedCommentId, workspace.mdEditorMode, workspace.mdSelectedFile]);
  const getCommentSidebarHeight = useCallback((comments: FileComment[], layout: Map<string, number>): number => {
    const commentBottom = comments.reduce((height, comment) => {
      const top = layout.get(comment.id) ?? getCommentLineTop(comment);
      return Math.max(height, top + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP);
    }, 0);
    const draftBottom = commentAddRange ? ((commentAddRange.startLine - 1) * FILE_REVIEW_LINE_HEIGHT) + COMMENT_SIDEBAR_CARD_PADDING : 0;
    const fileBottom = Math.max(1, workspace.mdEditContent.split('\n').length) * FILE_REVIEW_LINE_HEIGHT + COMMENT_SIDEBAR_CARD_PADDING;
    return Math.max(commentBottom, draftBottom, fileBottom);
  }, [commentAddRange, getCommentLineTop, getEstimatedCommentCardHeight, workspace.mdEditContent]);
  const openLineComment = useCallback((commentsForLine: FileComment[]) => {
    const nextComment = commentsForLine.find(c => c.id === selectedCommentId) || commentsForLine[0];
    if (!nextComment) return;
    setSelectedCommentId(nextComment.id);
    if (!commentSidebarOpen) setCommentSidebarOpen(true);
  }, [commentSidebarOpen, selectedCommentId]);
  const openCommentIds = useCallback((commentIds: string[]) => {
    const comments = commentIds
      .map(id => fileComments.find(c => c.id === id))
      .filter((comment): comment is FileComment => Boolean(comment));
    openLineComment(comments);
  }, [fileComments, openLineComment]);
  const extractFileComments = useCallback((text: string, _agentId: string) => extractFileCommentsFromText(text), []);
  const saveAgentComments = useCallback(async (agentId: string, comments: ExtractedAgentFileComment[], agentName?: string) => {
    for (const c of comments) {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId,
          filePath: c.filePath,
          rangeStartLine: c.rangeStartLine,
          rangeEndLine: c.rangeEndLine,
          content: c.content,
          authorType: 'agent',
          authorName: agentName,
        }),
      }).catch(() => { /* ignore */ });
    }
  }, []);
  const replyDraftByCommentId = useMemo(() => replyingToCommentId ? { [replyingToCommentId]: replyInput } : {}, [replyInput, replyingToCommentId]);
  return {
    comments: fileComments,
    activeCommentId: selectedCommentId,
    replyDraftByCommentId,
    setActiveCommentId: setSelectedCommentId,
    setReplyDraft: (commentId, value) => { setReplyingToCommentId(commentId); setReplyInput(value); },
    addComment: createComment,
    addReply: handleReplyComment,
    resolveComment: handleApproveComment,
    reopenComment: resetProcessingCommentForRetry,
    startReviewChat: async (commentId) => {
      const comment = fileCommentsRef.current.find(c => c.id === commentId);
      if (comment?.linkedChatId) await deps.onOpenReviewChat(comment.linkedChatId);
    },
    commentSidebarOpen,
    setCommentSidebarOpen,
    fileComments,
    setFileComments,
    fileCommentsRef,
    selectedCommentId,
    setSelectedCommentId,
    commentFilter,
    setCommentFilter,
    commentInput,
    setCommentInput,
    commentAddRange,
    setCommentAddRange,
    showCommentInput,
    setShowCommentInput,
    replyingToCommentId,
    setReplyingToCommentId,
    replyInput,
    setReplyInput,
    expandedReplyIds,
    setExpandedReplyIds,
    commentSidebarRef,
    commentAddFormRef,
    commentSourceScrollTop,
    setCommentSourceScrollTop,
    selection,
    loadFileComments,
    resetForFileOpen,
    handleCreateComment,
    handleRejectComment,
    handleDeleteComment,
    handleReplyComment,
    openCommentReviewChat,
    getContextForComment,
    startNextQueuedComment,
    resolveProcessingCommentForChat,
    resetProcessingCommentForRetry,
    handleStopProcessingComment,
    dispatchReviewCommentToAgent,
    handleApproveComment,
    getCommentsByLine,
    getCommentLineTop,
    getCommentDisplayTop,
    getVisibleSidebarComments,
    getEstimatedCommentCardHeight,
    getCommentStatusLabel,
    getCommentSidebarDesiredTop,
    compareCommentsBySidebarTop,
    getCommentSidebarLayout,
    getCommentSidebarHeight,
    openLineComment,
    openCommentIds,
    extractFileComments,
    saveAgentComments,
  };
}
