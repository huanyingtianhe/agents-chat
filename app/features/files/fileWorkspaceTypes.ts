export type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

export type MdConflictState = {
  path: string;
  baseContent: string;
  mineContent: string;
  serverContent: string;
  serverMtime: string | null;
  mode: 'choice' | 'manual';
};

export type LeftSidebarTab = 'chats' | 'files';
export type MdEditorMode = 'split' | 'live' | 'review';

export type FileWorkspaceState = {
  tab: LeftSidebarTab;
  agentId: string | null;
  filePath: string | null;
  diffOnly: boolean;
  editorMode: MdEditorMode;
  scrollTop?: number;
};

export type DiffLine = {
  type: 'same' | 'removed' | 'added' | 'changed';
  serverLine?: string;
  mineLine?: string;
  key: string;
};

export type FileCommentReply = {
  id: string;
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  createdAt: string;
};

export type FileComment = {
  id: string;
  agentId: string;
  filePath: string;
  rangeStartLine: number | null;
  rangeEndLine: number | null;
  rangeStartChar: number | null;
  rangeEndChar: number | null;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  status: 'active' | 'queued' | 'processing' | 'resolved';
  linkedChatId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: FileCommentReply[];
};

export type LiveSelectionDraftAnchor = {
  rects: { left: number; top: number; width: number; height: number }[];
};

export type LiveEditorSelectionSnapshot = {
  start: number;
  end: number;
};

export type LiveCommentMarker = {
  lineNum: number;
  commentIds: string[];
  top: number;
  left: number;
  color: string;
  selected: boolean;
  label: string;
  title: string;
  count: number;
};

export type CommentAddRange = {
  startLine: number;
  endLine: number;
  startChar?: number;
  endChar?: number;
};

export type ExtractedAgentFileComment = {
  filePath: string;
  rangeStartLine?: number;
  rangeEndLine?: number;
  content: string;
};

export type FileWorkspaceController = {
  workspace: FileWorkspaceState;
  activeFilePath: string | null;
  activeFileContent: string;
  editorMode: MdEditorMode;
  diffLines: DiffLine[];
  conflictState: MdConflictState | null;
  setActiveFilePath: (path: string | null) => void;
  setEditorMode: (mode: MdEditorMode) => void;
  openFilePath: (path: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
};

export type FileCommentsController = {
  comments: FileComment[];
  activeCommentId: string | null;
  replyDraftByCommentId: Record<string, string>;
  setActiveCommentId: (commentId: string | null) => void;
  setReplyDraft: (commentId: string, value: string) => void;
  addComment: (range: CommentAddRange, content: string) => Promise<void>;
  addReply: (commentId: string) => Promise<void>;
  resolveComment: (commentId: string) => Promise<void>;
  reopenComment: (commentId: string) => Promise<void>;
  startReviewChat: (commentId: string) => Promise<void>;
};
