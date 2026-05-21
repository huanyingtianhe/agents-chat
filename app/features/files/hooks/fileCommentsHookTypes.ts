import type { MutableRefObject } from 'react';
import type { ChatMessage, DispatchToAgentOptions } from '../../chat/chatTypes';
import type { CommentAddRange, ExtractedAgentFileComment, FileComment, FileCommentsController } from '../fileWorkspaceTypes';
import type { UseLiveEditorSelectionResult } from './useLiveEditorSelection';

export type ActiveCommentRun = {
  runKey: string;
  agentId: string;
  pendingId: string;
  currentText: string;
  chatId: string;
};

export type UseFileCommentsDeps = {
  mounted: boolean;
  onOpenReviewChat: (chatId: string) => void | Promise<void>;
  onLoadChatIntoCache: (chatId: string) => Promise<void>;
  onDispatchToAgent: (
    agentId: string,
    prompt: string,
    orchestrationId: string,
    kind: 'worker' | 'summary',
    options?: DispatchToAgentOptions,
  ) => Promise<unknown>;
  onInterruptAgent: (agentId: string, chatId: string) => Promise<unknown>;
  onGetActiveRun: (chatId: string, commentId: string) => ActiveCommentRun | null;
  onUpdateMessage: (messageId: string, patch: Partial<ChatMessage>, chatId?: string) => void;
  onDeleteActiveRun: (runKey: string) => void;
  onRunStateChanged: () => void;
};

export type UseFileCommentsResult = FileCommentsController & {
  commentSidebarOpen: boolean;
  setCommentSidebarOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  fileComments: FileComment[];
  setFileComments: (comments: FileComment[] | ((comments: FileComment[]) => FileComment[])) => void;
  fileCommentsRef: MutableRefObject<FileComment[]>;
  selectedCommentId: string | null;
  setSelectedCommentId: (commentId: string | null) => void;
  commentFilter: 'all' | 'active' | 'resolved';
  setCommentFilter: (filter: 'all' | 'active' | 'resolved') => void;
  commentInput: string;
  setCommentInput: (value: string) => void;
  commentAddRange: CommentAddRange | null;
  setCommentAddRange: (range: CommentAddRange | null) => void;
  showCommentInput: boolean;
  setShowCommentInput: (show: boolean) => void;
  replyingToCommentId: string | null;
  setReplyingToCommentId: (commentId: string | null) => void;
  replyInput: string;
  setReplyInput: (value: string) => void;
  expandedReplyIds: Set<string>;
  setExpandedReplyIds: (updater: Set<string> | ((ids: Set<string>) => Set<string>)) => void;
  commentSidebarRef: MutableRefObject<HTMLDivElement | null>;
  commentAddFormRef: MutableRefObject<HTMLDivElement | null>;
  commentSourceScrollTop: number;
  setCommentSourceScrollTop: (scrollTop: number) => void;
  selection: UseLiveEditorSelectionResult;
  loadFileComments: (agentId: string, filePath: string) => Promise<void>;
  resetForFileOpen: (agentId: string, filePath: string, restoreScrollTop?: number) => void;
  handleCreateComment: () => Promise<void>;
  handleRejectComment: (commentId: string) => Promise<void>;
  handleDeleteComment: (commentId: string) => Promise<void>;
  handleReplyComment: (commentId: string) => Promise<void>;
  openCommentReviewChat: (chatId: string) => void;
  getContextForComment: (comment: FileComment) => string;
  startNextQueuedComment: (chatId: string) => Promise<void>;
  resolveProcessingCommentForChat: (chatId: string, commentId: string) => Promise<void>;
  resetProcessingCommentForRetry: (commentId: string) => Promise<void>;
  handleStopProcessingComment: (comment: FileComment) => Promise<void>;
  dispatchReviewCommentToAgent: (agentId: string, prompt: string, commentId: string, chatId: string) => Promise<boolean>;
  handleApproveComment: (commentId: string) => Promise<void>;
  getCommentsByLine: () => Map<number, FileComment[]>;
  getCommentLineTop: (comment: FileComment) => number;
  getCommentDisplayTop: (comment: FileComment) => number;
  getVisibleSidebarComments: () => FileComment[];
  getEstimatedCommentCardHeight: (comment: FileComment) => number;
  getCommentStatusLabel: (status: FileComment['status']) => string;
  getCommentSidebarDesiredTop: (comment: FileComment) => number;
  compareCommentsBySidebarTop: (a: FileComment, b: FileComment) => number;
  getCommentSidebarLayout: (comments: FileComment[]) => Map<string, number>;
  getCommentSidebarHeight: (comments: FileComment[], layout: Map<string, number>) => number;
  openLineComment: (commentsForLine: FileComment[]) => void;
  openCommentIds: (commentIds: string[]) => void;
  extractFileComments: (text: string, agentId: string) => { cleanText: string; comments: ExtractedAgentFileComment[] };
  saveAgentComments: (agentId: string, comments: ExtractedAgentFileComment[], agentName?: string) => Promise<void>;
};
