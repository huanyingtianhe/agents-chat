'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSession, signOut } from 'next-auth/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { remark } from 'remark';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

/* ────────── Helpers ────────── */

// Convert markdown string to HTML string (for live-edit mode)
const mdProcessor = remark().use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(rehypeStringify, { allowDangerousHtml: true });
function markdownToHtml(md: string): string {
  return String(mdProcessor.processSync(md));
}

// Detect file paths ending in .html/.htm in text and wrap them with report links
const HTML_FILE_RE = /(?:[A-Za-z]:\\|\/|~\/)[^\s"'<>*?|]+\.html?/gi;

function linkifyHtmlPaths(text: string): (string | { href: string; label: string })[] {
  const parts: (string | { href: string; label: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(HTML_FILE_RE)) {
    const idx = m.index!;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push({ href: `/api/file?path=${encodeURIComponent(m[0])}`, label: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// Custom ReactMarkdown components to linkify HTML file paths in code blocks and paragraphs
const mdComponents = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: (props: any) => {
    const { children, className, ...rest } = props;
    const text = String(children || '');
    if (HTML_FILE_RE.test(text) && !className) {
      HTML_FILE_RE.lastIndex = 0;
      const segments = linkifyHtmlPaths(text);
      return (
        <code {...rest} className={className}>
          {segments.map((s, i) =>
            typeof s === 'string' ? s : <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="htmlFileLink">{s.label}</a>
          )}
        </code>
      );
    }
    return <code {...rest} className={className}>{children}</code>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: (props: any) => {
    const { children, ...rest } = props;
    // Process text children to linkify HTML paths
    const processed = Array.isArray(children) ? children : [children];
    const result = processed.flatMap((child: unknown, ci: number) => {
      if (typeof child !== 'string') return [child];
      if (!HTML_FILE_RE.test(child)) { HTML_FILE_RE.lastIndex = 0; return [child]; }
      HTML_FILE_RE.lastIndex = 0;
      const segments = linkifyHtmlPaths(child);
      return segments.map((s, si) =>
        typeof s === 'string' ? s : <a key={`${ci}-${si}`} href={s.href} target="_blank" rel="noopener noreferrer" className="htmlFileLink">{s.label}</a>
      );
    });
    return <p {...rest}>{result}</p>;
  },
};

/* ────────── Types ────────── */

type Agent = {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  relay?: boolean;
  relayConnectionName?: string;
  relayConnectionLabel?: string;
  owner?: string;
  canModify?: boolean;
  canTalk?: boolean;
  public?: boolean;
};

type PtyPhase = 'booting' | 'loading-environment' | 'idle-ready' | 'thinking' | 'replying';

type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const icons: Record<string, string> = {
    md: '📝', ts: '🟦', tsx: '⚛️', js: '🟨', jsx: '⚛️',
    json: '📋', yaml: '⚙️', yml: '⚙️', toml: '⚙️',
    py: '🐍', rs: '🦀', go: '🔵', java: '☕',
    css: '🎨', html: '🌐', htm: '🌐', xml: '📄',
    sh: '🖥️', bash: '🖥️', ps1: '🖥️', bat: '🖥️', cmd: '🖥️',
    txt: '📄', csv: '📊', env: '🔒', gitignore: '👁️',
  };
  return icons[ext] || '📄';
}

type MdConflictState = {
  path: string;
  baseContent: string;
  mineContent: string;
  serverContent: string;
  serverMtime: string | null;
  mode: 'choice' | 'manual';
};

type LeftSidebarTab = 'chats' | 'files';
type MdEditorMode = 'split' | 'live' | 'review';
const FILE_REVIEW_LINE_HEIGHT = 20;
const COMMENT_SIDEBAR_CARD_PADDING = 120;
const COMMENT_SIDEBAR_CARD_GAP = 8;
const COMMENT_SIDEBAR_COLLAPSED_CARD_HEIGHT = 54;
const COMMENT_SIDEBAR_EXPANDED_CARD_HEIGHT = 118;
const CHAT_ACTION_MENU_WIDTH = 132;
const CHAT_ACTION_MENU_HEIGHT = 124;

type FileWorkspaceState = {
  tab: LeftSidebarTab;
  agentId: string | null;
  filePath: string | null;
  diffOnly: boolean;
  editorMode: MdEditorMode;
};

type FileComment = {
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

type FileCommentReply = {
  id: string;
  commentId: string;
  content: string;
  authorType: 'agent' | 'user';
  authorName: string | null;
  createdAt: string;
};

type LiveSelectionDraftAnchor = {
  rects: { left: number; top: number; width: number; height: number }[];
};

type LiveCommentMarker = {
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

type CommentAddRange = {
  startLine: number;
  endLine: number;
  startChar?: number;
  endChar?: number;
};

type DiffLine = {
  type: 'same' | 'removed' | 'added' | 'changed';
  serverLine?: string;
  mineLine?: string;
  key: string;
};

function isLeftSidebarTab(value: unknown): value is LeftSidebarTab {
  return value === 'chats' || value === 'files';
}

function isMdEditorMode(value: unknown): value is MdEditorMode {
  return value === 'split' || value === 'live' || value === 'review';
}

function normalizeFileEditorMode(mode: MdEditorMode, filePath?: string | null): MdEditorMode {
  if (!filePath) return mode === 'review' ? 'live' : mode;
  if (isMarkdownFile(filePath)) return mode === 'review' ? 'live' : mode;
  if (isHtmlFile(filePath)) return 'live';
  return mode;
}

function parseFileWorkspaceState(raw: string | null): FileWorkspaceState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FileWorkspaceState>;
    const filePath = typeof parsed.filePath === 'string' && parsed.filePath ? parsed.filePath : null;
    const editorMode = isMdEditorMode(parsed.editorMode) ? parsed.editorMode : 'live';
    return {
      tab: isLeftSidebarTab(parsed.tab) ? parsed.tab : 'chats',
      agentId: typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId : null,
      filePath,
      diffOnly: parsed.diffOnly === true,
      editorMode: normalizeFileEditorMode(editorMode, filePath),
    };
  } catch {
    return null;
  }
}

function buildSimpleLineDiff(serverContent: string, mineContent: string): DiffLine[] {
  const serverLines = serverContent.split('\n');
  const mineLines = mineContent.split('\n');
  const max = Math.max(serverLines.length, mineLines.length);
  const rows: DiffLine[] = [];
  for (let i = 0; i < max; i++) {
    const serverLine = serverLines[i];
    const mineLine = mineLines[i];
    if (serverLine === mineLine) {
      rows.push({ type: 'same', serverLine, mineLine, key: `same-${i}` });
    } else if (serverLine === undefined) {
      rows.push({ type: 'added', mineLine, key: `added-${i}` });
    } else if (mineLine === undefined) {
      rows.push({ type: 'removed', serverLine, key: `removed-${i}` });
    } else {
      rows.push({ type: 'changed', serverLine, mineLine, key: `changed-${i}` });
    }
  }
  return rows;
}

function isMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}

function isHtmlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function buildFileTree(files: { path: string; name: string }[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const dirPath = parts.slice(0, i + 1).join('/');
      if (isLast) {
        current.push({ name: part, path: file.path, isDir: false, children: [] });
      } else {
        let dir = current.find(n => n.isDir && n.name === part);
        if (!dir) {
          dir = { name: part, path: dirPath, isDir: true, children: [] };
          current.push(dir);
        }
        current = dir.children;
      }
    }
  }
  // Sort: dirs first, then files, alphabetically
  const sortTree = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.isDir) sortTree(n.children);
  };
  sortTree(root);
  return root;
}

type ContentPart =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolName: string; args?: string; result?: string; done: boolean }
  | { kind: 'user_answer'; text: string }
  | { kind: 'text'; text: string };

type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  kind: 'image' | 'file';
};

type AgentUserRequestOption = {
  optionId: string;
  kind?: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

type AgentUserRequestQuestion = {
  id: string;
  header: string;
  question: string;
  message?: string;
  inputKind: 'options' | 'text';
  multiSelect?: boolean;
  allowFreeformInput?: boolean;
  options: AgentUserRequestOption[];
};

type AgentUserRequestAnswer = {
  selected: string[];
  freeText: string | null;
  skipped: boolean;
};

type AgentUserRequest = {
  id: string;
  method: string;
  agentId: string;
  title: string;
  prompt: string;
  inputKind: 'options' | 'text';
  options: AgentUserRequestOption[];
  questions?: AgentUserRequestQuestion[];
  createdAt: number;
};

type AgentUserRequestResponse = {
  optionId?: string;
  answer?: string;
  answers?: Record<string, AgentUserRequestAnswer>;
};

type AgentUserRequestSubmission = {
  pending: boolean;
  error?: string;
};

function getAgentUserRequestOptionLabel(option: AgentUserRequestOption): string {
  if (option.kind === 'allow_always' || option.optionId === 'allow_always') {
    return 'Always allow in current session';
  }
  return option.label;
}

function getAcpTurnProgressSignature(turn: {
  fullText?: string;
  done?: boolean;
  phase?: string;
  statusText?: string;
  error?: string;
  userRequest?: AgentUserRequest;
  events?: { type: string; toolName?: string; toolCallId?: string; toolArgs?: string; toolResult?: string; text?: string }[];
}): string {
  const events = Array.isArray(turn.events) ? turn.events : [];
  const lastEvent = events[events.length - 1];
  const lastEventSignature = lastEvent
    ? [
        lastEvent.type,
        lastEvent.toolCallId || '',
        lastEvent.toolName || '',
        lastEvent.toolArgs?.length || 0,
        lastEvent.toolResult?.length || 0,
        lastEvent.text?.length || 0,
      ].join(':')
    : '';
  return [
    turn.done ? 'done' : 'active',
    turn.phase || '',
    turn.statusText || '',
    turn.error || '',
    turn.userRequest?.id || '',
    turn.fullText?.length || 0,
    events.length,
    lastEventSignature,
  ].join('|');
}

type ChatMessage = {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  agentId?: string;
  ts: number;
  pending?: boolean;
  round?: number;
  relation?: string;
  summary?: boolean;
  statusText?: string;
  ptyPhase?: PtyPhase;
  parts?: ContentPart[];
  userRequest?: AgentUserRequest;
  attachments?: ChatAttachment[];
  sendStatus?: 'failed';
  sendError?: string;
  resendAgentIds?: string[];
  resendMessage?: string;
};

type ChatHistoryEntry = {
  id: string;
  name: string;
  ts: number;
  agentId?: string;
  agentSessions?: Record<string, string>;
};

type ShareDialog = {
  variant: 'link' | 'error';
  title: string;
  url?: string;
  detail?: string;
  copied?: boolean;
};

type OrchestrationMode = 'discussion' | 'pipeline' | 'auto';

const AUTO_MAX_STEPS = 5;
const SCHEDULER_AGENT_ID = 'scheduler';

function normalizeChatHistory(chats: ChatHistoryEntry[]): ChatHistoryEntry[] {
  const byId = new Map<string, ChatHistoryEntry>();
  for (const chat of chats) {
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return Array.from(byId.values());
}

type SessionRunContext = {
  agentId: string;
  pendingId: string;
  orchestrationId: string;
  kind: 'worker' | 'summary';
  currentText: string;
  chatId: string;
  commentId?: string;
  round?: number;
  relation?: string;
  ptyTurnId?: string;
  ptySendStarted?: boolean;
};

type DispatchToAgentOptions = {
  round?: number;
  relation?: string;
  summary?: boolean;
  chatId?: string;
  commentId?: string;
  attachments?: ChatAttachment[];
};

type OrchestrationState = {
  id: string;
  mode: OrchestrationMode;
  agentIds: string[];
  originalTask: string;
  results: Record<string, string>;
  nextIndex: number;
  summaryStarted: boolean;
  round: number;
  maxRounds: number;
  sourceUserMessageId?: string;
  sourceChatId?: string;
  sourceAgentIds?: string[];
  sourceMessage?: string;
  sourceAttachments?: ChatAttachment[];
};

class PromptSendFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptSendFailedError';
  }
}

/* ────────── Storage keys (UI prefs only — chat data is in SQLite) ────────── */

const STORAGE_CHAT_INPUT = 'acp_chat_input_v1';
const STORAGE_SIDEBAR_COLLAPSED = 'acp_chat_sidebar_collapsed_v1';
const STORAGE_INPUT_HISTORY = 'acp_input_history_v1';
const STORAGE_THEME = 'acp_chat_theme_v1';
const STORAGE_AGENT_FILTER = 'acp_agent_filter_v1';
const STORAGE_FILE_WORKSPACE = 'acp_file_workspace_v1';

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const THEMES = {
  aurora: {
    label: 'Aurora',
    emoji: '🌌',
    values: {
      '--bg': '#07111f',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(34,211,238,0.22), transparent 28%), radial-gradient(circle at top right, rgba(168,85,247,0.18), transparent 32%), linear-gradient(180deg, #09101d 0%, #07111f 100%)',
      '--header-bg': 'rgba(8, 14, 27, 0.88)',
      '--panel-bg': 'rgba(9, 15, 29, 0.78)',
      '--panel-strong': '#101a30',
      '--panel-soft': '#131f39',
      '--border': 'rgba(103, 232, 249, 0.16)',
      '--border-strong': 'rgba(103, 232, 249, 0.3)',
      '--text': '#e8f4ff',
      '--text-soft': '#9fb4d9',
      '--muted': '#7083a8',
      '--accent': '#45d7ff',
      '--accent-2': '#9b6bff',
      '--accent-soft': 'rgba(69, 215, 255, 0.12)',
      '--accent-strong': 'rgba(69, 215, 255, 0.22)',
      '--message-user': 'linear-gradient(135deg, rgba(69, 215, 255, 0.14), rgba(155, 107, 255, 0.14))',
      '--message-agent': 'rgba(9, 15, 29, 0.9)',
      '--summary-glow': 'rgba(168, 85, 247, 0.16)',
      '--input-bg': '#13203a',
      '--code-bg': '#0b1426',
      '--success': '#86efac',
      '--danger': '#ef4444',
      '--shadow': '0 20px 60px rgba(2, 8, 23, 0.45)',
      '--comment-agent-color': '#f0c040',
      '--comment-user-color': '#58a6ff',
    },
  },
  sunset: {
    label: 'Sunset',
    emoji: '🌇',
    values: {
      '--bg': '#160b12',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(251,146,60,0.25), transparent 32%), radial-gradient(circle at top right, rgba(244,114,182,0.18), transparent 30%), linear-gradient(180deg, #1a0d16 0%, #120911 100%)',
      '--header-bg': 'rgba(28, 12, 20, 0.88)',
      '--panel-bg': 'rgba(24, 11, 19, 0.82)',
      '--panel-strong': '#2b1220',
      '--panel-soft': '#341625',
      '--border': 'rgba(251,146,60,0.16)',
      '--border-strong': 'rgba(244,114,182,0.28)',
      '--text': '#fff2f2',
      '--text-soft': '#f0b6bb',
      '--muted': '#bf8c94',
      '--accent': '#fb923c',
      '--accent-2': '#f472b6',
      '--accent-soft': 'rgba(251, 146, 60, 0.12)',
      '--accent-strong': 'rgba(244, 114, 182, 0.2)',
      '--message-user': 'linear-gradient(135deg, rgba(251,146,60,0.14), rgba(244,114,182,0.14))',
      '--message-agent': 'rgba(29, 13, 22, 0.9)',
      '--summary-glow': 'rgba(251,146,60,0.16)',
      '--input-bg': '#321726',
      '--code-bg': '#210d18',
      '--success': '#a7f3d0',
      '--danger': '#f87171',
      '--shadow': '0 22px 60px rgba(18, 5, 10, 0.45)',
      '--comment-agent-color': '#f0c040',
      '--comment-user-color': '#58a6ff',
    },
  },
  vsCodeDark: {
    label: 'VS Code Dark',
    emoji: '▣',
    values: {
      '--bg': '#1e1e1e',
      '--bg-accent': 'linear-gradient(180deg, #1f1f1f 0%, #1e1e1e 52%, #181818 100%)',
      '--header-bg': 'rgba(37, 37, 38, 0.94)',
      '--panel-bg': 'rgba(37, 37, 38, 0.88)',
      '--panel-strong': '#252526',
      '--panel-soft': '#2d2d30',
      '--border': 'rgba(128, 128, 128, 0.18)',
      '--border-strong': 'rgba(0, 122, 204, 0.42)',
      '--text': '#cccccc',
      '--text-soft': '#b3b3b3',
      '--muted': '#858585',
      '--accent': '#3794ff',
      '--accent-2': '#007acc',
      '--accent-soft': 'rgba(55, 148, 255, 0.13)',
      '--accent-strong': 'rgba(0, 122, 204, 0.24)',
      '--message-user': 'linear-gradient(135deg, rgba(55,148,255,0.12), rgba(0,122,204,0.10))',
      '--message-agent': 'rgba(37, 37, 38, 0.94)',
      '--summary-glow': 'rgba(55,148,255,0.14)',
      '--input-bg': '#3c3c3c',
      '--code-bg': '#1e1e1e',
      '--success': '#89d185',
      '--danger': '#f48771',
      '--shadow': '0 22px 58px rgba(0, 0, 0, 0.42)',
      '--comment-agent-color': '#f0c040',
      '--comment-user-color': '#58a6ff',
    },
  },
  claude: {
    label: 'Claude',
    emoji: '✦',
    values: {
      '--bg': '#f7f2e8',
      '--bg-accent': 'radial-gradient(circle at top left, rgba(196, 95, 65, 0.14), transparent 30%), radial-gradient(circle at bottom right, rgba(83, 102, 121, 0.08), transparent 26%), linear-gradient(180deg, #fbf7ef 0%, #f1e8dc 100%)',
      '--header-bg': 'rgba(250, 246, 238, 0.9)',
      '--panel-bg': 'rgba(255, 251, 243, 0.78)',
      '--panel-strong': '#fffaf2',
      '--panel-soft': '#f1e8dc',
      '--border': 'rgba(88, 70, 60, 0.13)',
      '--border-strong': 'rgba(196, 95, 65, 0.28)',
      '--text': '#2f2722',
      '--text-soft': '#6f625a',
      '--muted': '#97897d',
      '--accent': '#c45f41',
      '--accent-2': '#536679',
      '--accent-soft': 'rgba(196, 95, 65, 0.12)',
      '--accent-strong': 'rgba(83, 102, 121, 0.14)',
      '--message-user': 'linear-gradient(135deg, rgba(196,95,65,0.11), rgba(83,102,121,0.09))',
      '--message-agent': 'rgba(255, 250, 242, 0.9)',
      '--summary-glow': 'rgba(196, 95, 65, 0.12)',
      '--input-bg': '#fffaf2',
      '--code-bg': '#eee3d6',
      '--success': '#218a54',
      '--danger': '#c2413b',
      '--shadow': '0 22px 58px rgba(75, 54, 43, 0.16)',
      '--comment-agent-color': '#a35d00',
      '--comment-user-color': '#2f6f9f',
      '--avatar-bg': 'linear-gradient(135deg, #d97757, #c45f41)',
      '--avatar-text': '#fff',
    },
  },
  chatgpt: {
    label: 'ChatGPT',
    emoji: '◉',
    values: {
      '--bg': '#ffffff',
      '--bg-accent': 'linear-gradient(180deg, #ffffff 0%, #fbfbfa 100%)',
      '--header-bg': 'rgba(255, 255, 255, 0.94)',
      '--panel-bg': 'rgba(249, 249, 248, 0.92)',
      '--panel-strong': '#ffffff',
      '--panel-soft': '#f4f4f3',
      '--border': 'rgba(13, 13, 13, 0.08)',
      '--border-strong': 'rgba(13, 13, 13, 0.16)',
      '--text': '#0d0d0d',
      '--text-soft': '#3f3f3f',
      '--muted': '#737373',
      '--accent': '#ff5e1a',
      '--accent-2': '#0d0d0d',
      '--accent-soft': 'rgba(255, 94, 26, 0.10)',
      '--accent-strong': 'rgba(255, 94, 26, 0.18)',
      '--message-user': 'linear-gradient(135deg, rgba(255,94,26,0.08), rgba(13,13,13,0.04))',
      '--message-agent': '#ffffff',
      '--summary-glow': 'rgba(255, 94, 26, 0.10)',
      '--input-bg': '#ffffff',
      '--code-bg': '#f4f4f3',
      '--success': '#16a34a',
      '--danger': '#dc2626',
      '--shadow': '0 18px 48px rgba(13, 13, 13, 0.08)',
      '--comment-agent-color': '#c2520a',
      '--comment-user-color': '#2f6f9f',
      '--avatar-bg': 'linear-gradient(135deg, #ff8a4a, #ff5e1a)',
      '--avatar-text': '#fff',
    },
  },
} as const;

type ThemeId = keyof typeof THEMES;
const DEFAULT_THEME_ID: ThemeId = 'aurora';
const LEGACY_THEME_ID_MAP: Record<string, ThemeId> = {
  oneDark: 'vsCodeDark',
  forest: DEFAULT_THEME_ID,
  velvet: DEFAULT_THEME_ID,
  pearl: 'chatgpt',
};

function normalizeThemeId(value: unknown): ThemeId {
  if (typeof value !== 'string') return DEFAULT_THEME_ID;
  if (value in THEMES) return value as ThemeId;
  return LEGACY_THEME_ID_MAP[value] || DEFAULT_THEME_ID;
}

/* ────────── Helpers ────────── */

function mapTurnPhase(phase: string): PtyPhase | undefined {
  switch (phase) {
    case 'booting': return 'loading-environment';
    case 'thinking': return 'thinking';
    case 'tool_exec': return 'thinking';
    case 'replying': return 'replying';
    case 'done': return 'idle-ready';
    default: return undefined;
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

function getAttachmentKind(mimeType: string): ChatAttachment['kind'] {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  bash: 'text/x-shellscript',
  bat: 'text/x-bat',
  c: 'text/x-c',
  cc: 'text/x-c++',
  cer: 'application/x-pem-file',
  cfg: 'text/plain',
  clj: 'text/x-clojure',
  cljs: 'text/x-clojure',
  cmake: 'text/x-cmake',
  cmd: 'text/x-bat',
  conf: 'text/plain',
  cpp: 'text/x-c++',
  crt: 'application/x-pem-file',
  cshtml: 'text/html',
  csproj: 'text/xml',
  cs: 'text/x-csharp',
  css: 'text/css',
  csv: 'text/csv',
  cjs: 'text/javascript',
  cts: 'text/typescript',
  cxx: 'text/x-c++',
  dart: 'text/x-dart',
  diff: 'text/x-diff',
  dockerfile: 'text/x-dockerfile',
  editorconfig: 'text/plain',
  env: 'text/plain',
  erl: 'text/x-erlang',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  fish: 'text/x-shellscript',
  fs: 'text/x-fsharp',
  fsproj: 'text/xml',
  fsi: 'text/x-fsharp',
  fsx: 'text/x-fsharp',
  gitignore: 'text/plain',
  go: 'text/x-go',
  gql: 'text/graphql',
  gradle: 'text/x-gradle',
  graphql: 'text/graphql',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  hrl: 'text/x-erlang',
  htm: 'text/html',
  html: 'text/html',
  hxx: 'text/x-c++',
  ini: 'text/plain',
  java: 'text/x-java-source',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  jsx: 'text/javascript',
  key: 'application/x-pem-file',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  less: 'text/css',
  lock: 'text/plain',
  log: 'text/plain',
  lua: 'text/x-lua',
  m: 'text/x-objective-c',
  md: 'text/markdown',
  mm: 'text/x-objective-c++',
  mjs: 'text/javascript',
  mts: 'text/typescript',
  patch: 'text/x-diff',
  pem: 'application/x-pem-file',
  php: 'text/x-php',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  pdf: 'application/pdf',
  png: 'image/png',
  props: 'text/xml',
  properties: 'text/plain',
  proto: 'text/x-protobuf',
  ps1: 'text/x-powershell',
  psd1: 'text/x-powershell',
  psm1: 'text/x-powershell',
  pub: 'application/x-pem-file',
  py: 'text/x-python',
  r: 'text/x-r',
  razor: 'text/html',
  rb: 'text/x-ruby',
  rs: 'text/x-rustsrc',
  sass: 'text/css',
  scala: 'text/x-scala',
  scss: 'text/css',
  sh: 'text/x-shellscript',
  sln: 'text/plain',
  sql: 'text/x-sql',
  svelte: 'text/html',
  svg: 'image/svg+xml',
  swift: 'text/x-swift',
  targets: 'text/xml',
  toml: 'text/toml',
  ts: 'text/typescript',
  tsbuildinfo: 'application/json',
  tsx: 'text/typescript',
  txt: 'text/plain',
  vb: 'text/x-vb',
  vbproj: 'text/xml',
  vue: 'text/html',
  xaml: 'text/xml',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  zsh: 'text/x-shellscript',
};

const ATTACHMENT_MIME_BY_BASENAME: Record<string, string> = {
  '.babelrc': 'application/json',
  '.dockerignore': 'text/plain',
  '.editorconfig': 'text/plain',
  '.env': 'text/plain',
  '.env.development': 'text/plain',
  '.env.example': 'text/plain',
  '.env.local': 'text/plain',
  '.env.production': 'text/plain',
  '.env.test': 'text/plain',
  '.eslintignore': 'text/plain',
  '.eslintrc': 'application/json',
  '.gitattributes': 'text/plain',
  '.gitignore': 'text/plain',
  '.npmrc': 'text/plain',
  '.prettierignore': 'text/plain',
  '.prettierrc': 'application/json',
  '.yarnrc': 'text/plain',
  dockerfile: 'text/x-dockerfile',
  gemfile: 'text/x-ruby',
  justfile: 'text/plain',
  makefile: 'text/x-makefile',
  procfile: 'text/plain',
  rakefile: 'text/x-ruby',
};

const ATTACHMENT_ACCEPT = [
  'image/*',
  ...Object.keys(ATTACHMENT_MIME_BY_EXTENSION).map((extension) => `.${extension}`),
  ...Object.keys(ATTACHMENT_MIME_BY_BASENAME),
].join(',');

function getAttachmentFileKey(name: string): string {
  return name.trim().split(/[\\/]/).pop()?.toLowerCase() || '';
}

function getAttachmentMimeType(name: string, providedMimeType: string): string {
  const normalized = providedMimeType.trim().toLowerCase();
  if (normalized && normalized !== 'application/octet-stream') return normalized;
  const fileKey = getAttachmentFileKey(name);
  const exact = ATTACHMENT_MIME_BY_BASENAME[fileKey] || ATTACHMENT_MIME_BY_EXTENSION[fileKey];
  if (exact) return exact;
  const extension = fileKey.includes('.') ? fileKey.split('.').pop()?.trim().toLowerCase() : '';
  return (extension && ATTACHMENT_MIME_BY_EXTENSION[extension]) || normalized || 'application/octet-stream';
}

function withAttachmentDataUrlMimeType(dataUrl: string, mimeType: string): string {
  return dataUrl.replace(/^data:[^;,]*;base64,/, `data:${mimeType};base64,`);
}

function getAttachmentTypeLabel(attachment: ChatAttachment): string {
  const mimeType = attachment.mimeType.trim().toLowerCase();
  if (attachment.kind === 'image') {
    const imageType = mimeType.startsWith('image/') ? mimeType.slice('image/'.length).split(/[;+]/)[0] : '';
    return imageType ? `${imageType.toUpperCase()} image` : 'Image';
  }

  const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()?.toUpperCase() : '';
  if (!mimeType || mimeType === 'application/octet-stream') return extension ? `${extension} file` : 'File';
  if (mimeType === 'application/pdf') return 'PDF';
  if (extension && Object.values(ATTACHMENT_MIME_BY_EXTENSION).includes(mimeType)) return `${extension} file`;
  if (mimeType === 'text/plain') return 'Text file';
  return mimeType;
}

function getAttachmentIconLabel(attachment: ChatAttachment): string {
  const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()?.trim().toLowerCase() : '';
  if (!extension) return 'FILE';
  const aliases: Record<string, string> = {
    jpeg: 'JPG',
    markdown: 'MD',
    typescript: 'TS',
    javascript: 'JS',
  };
  return (aliases[extension] || extension.toUpperCase()).slice(0, 3);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function filesToAttachments(files: File[], existing: ChatAttachment[]): Promise<{ attachments: ChatAttachment[]; error?: string }> {
  if (files.length === 0) return { attachments: [] };
  if (existing.length + files.length > MAX_ATTACHMENTS) return { attachments: [], error: `You can attach up to ${MAX_ATTACHMENTS} files.` };
  const existingTotal = existing.reduce((sum, attachment) => sum + attachment.size, 0);
  let newTotal = 0;
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) return { attachments: [], error: `${file.name || 'File'} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.` };
    newTotal += file.size;
  }
  if (existingTotal + newTotal > MAX_TOTAL_ATTACHMENT_BYTES) return { attachments: [], error: `Attachments can total up to ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}.` };

  const attachments = await Promise.all(files.map(async (file) => {
    const name = file.name || 'clipboard-file';
    const mimeType = getAttachmentMimeType(name, file.type || 'application/octet-stream');
    const dataUrl = withAttachmentDataUrlMimeType(await readFileAsDataUrl(file), mimeType);
    return {
      id: `attachment-${makeId()}`,
      name,
      mimeType,
      size: file.size,
      dataUrl,
      kind: getAttachmentKind(mimeType),
    } satisfies ChatAttachment;
  }));
  return { attachments };
}

function getAttachmentSummaryText(attachments: ChatAttachment[] = []): string {
  if (attachments.length === 0) return '';
  return `Attached file(s):\n${attachments.map((a) => `- ${a.name} (${a.mimeType}, ${formatBytes(a.size)})`).join('\n')}`;
}

function formatMessageTime(ts: number) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

function getMentionedAgentIds(text: string, agents: Agent[]) {
  const matches = [...text.matchAll(/@(\S+)/g)];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const match of matches) {
    const rawId = match[1];
    const agent = agents.find((a) => a.id.toLowerCase() === rawId.toLowerCase());
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      selected.push(agent.id);
    }
  }
  return selected;
}

function parseAgents(text: string, agents: Agent[], preferredAgentId?: string | null) {
  const agentIds = getMentionedAgentIds(text, agents);
  if (agentIds.length === 0) {
    // Use preferred agent (from chat's agentId) if available, otherwise fall back to first non-scheduler
    const preferred = preferredAgentId ? agents.find(a => a.id === preferredAgentId) : null;
    const fallback = preferred || agents.find((agent) => agent.id !== SCHEDULER_AGENT_ID) || agents[0] || { id: 'main', name: 'Main' };
    return { agentIds: [fallback.id], message: text };
  }
  const message = text.replace(/(?:^|\s)@(\S+)/g, '').trim();
  return { agentIds, message: message || text };
}

/* ────────── ACP API helper ────────── */

/** Extract the current (last) session ID — handles both string and string[] from SQLite. */
function lastSessionId(val: unknown): string | null {
  if (Array.isArray(val)) return val.length > 0 ? val[val.length - 1] : null;
  if (typeof val === 'string' && val) return val;
  return null;
}

async function acpApi(body: Record<string, unknown>) {
  const res = await fetch('/api/acp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* ────────── Page Component ────────── */

export default function Page() {
  const { data: session, status: authStatus } = useSession();
  const isAdmin = (session?.user as any)?.role === 'admin';
  // Derive a stable userId for multi-user session isolation
  const userId = (session?.user as any)?.email || (session?.user as any)?.name || 'anonymous';

  // Wrapper that injects userId into every ACP API call
  const acp = useCallback((body: Record<string, unknown>) => {
    return acpApi({ ...body, userId });
  }, [userId]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target one or more agents.', ts: 0 },
  ]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>('auto');
  const [discussionRounds, setDiscussionRounds] = useState(2);
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const [runVersion, setRunVersion] = useState(0);
  const [chatName, setChatName] = useState('New Chat');
  const [chatCounter, setChatCounter] = useState(1);
  const [currentChatId, setCurrentChatId] = useState<string>('');
  const [loadedChatIdForResume, setLoadedChatIdForResume] = useState<string | null>(null);
  const [activeSidebarChatId, setActiveSidebarChatId] = useState<string>('');
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [themeId, setThemeId] = useState<ThemeId>('aurora');
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const [showChatsPanel, setShowChatsPanel] = useState(false);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const chatMenuButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [chatAgentFilter, setChatAgentFilter] = useState<string | null>(null); // null = "All"
  function switchAgentFilter(agentId: string | null) {
    if (agentId === chatAgentFilter) return;
    // Save current chat before switching
    void saveCurrentChatToHistory();
    setChatAgentFilter(agentId);
    try { window.localStorage.setItem(STORAGE_AGENT_FILTER, agentId || ''); } catch { /* ignore */ }
    // Deselect active chat — show empty homepage
    currentChatIdRef.current = '';
    setCurrentChatId('');
    setActiveSidebarChatId('');
    setChatName('New Chat');
    clearChatMessages();
    currentAgentSessionsRef.current = {};
  }
  const [shareDialog, setShareDialog] = useState<ShareDialog | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [agentUserRequestSubmissions, setAgentUserRequestSubmissions] = useState<Record<string, AgentUserRequestSubmission>>({});

  // Add agent form
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showAgentAddMenu, setShowAgentAddMenu] = useState(false);
  const [showAddRemoteAgent, setShowAddRemoteAgent] = useState(false);
  const defaultCwd = 'Q:\\Repos\\workload-eventstream';
  const [newRemoteAgentForm, setNewRemoteAgentForm] = useState({ id: '', name: '', nodeName: '', cwd: defaultCwd });
  const [newAgentForm, setNewAgentForm] = useState({ id: '', name: '', command: '', args: '', cwd: defaultCwd, yolo: true });
  const [addAgentLoading, setAddAgentLoading] = useState(false);

  // Nodes panel
  const [showNodesPanel, setShowNodesPanel] = useState(false);
  const [nodesData, setNodesData] = useState<{ name: string; label: string; online: boolean; checkedAt: number; manual?: boolean; owner?: string; canModify?: boolean }[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [showAddNode, setShowAddNode] = useState(false);
  const [newNodeForm, setNewNodeForm] = useState({ name: '', label: '' });
  const [addNodeLoading, setAddNodeLoading] = useState(false);
  const [editingNodeName, setEditingNodeName] = useState<string | null>(null);
  const [editingNodeLabel, setEditingNodeLabel] = useState('');
  const [showNodeAddMenu, setShowNodeAddMenu] = useState(false);
  const [showSetupScript, setShowSetupScript] = useState(false);
  const [showAddRelayAgent, setShowAddRelayAgent] = useState(false);
  const [relayAgentNode, setRelayAgentNode] = useState('');
  const [newRelayAgentForm, setNewRelayAgentForm] = useState({ id: '', name: '', cwd: defaultCwd });

  // Markdown files panel
  const [leftSidebarTab, setLeftSidebarTab] = useState<LeftSidebarTab>('chats');
  const [mdFilesList, setMdFilesList] = useState<{ path: string; name: string; mtime: string }[]>([]);
  const [mdFilesLoading, setMdFilesLoading] = useState(false);
  const [mdSelectedAgentId, setMdSelectedAgentId] = useState<string | null>(null);
  const [mdSelectedFile, setMdSelectedFile] = useState<string | null>(null);
  const [mdFileContent, setMdFileContent] = useState('');
  const [mdEditContent, setMdEditContent] = useState('');
  const [mdFileMtime, setMdFileMtime] = useState<string | null>(null);
  const [mdSaving, setMdSaving] = useState(false);
  const [mdDirty, setMdDirty] = useState(false);
  const [mdEditorOpen, setMdEditorOpen] = useState(false);
  const [mdEditorMode, setMdEditorMode] = useState<MdEditorMode>('live');
  const [mdLiveHtml, setMdLiveHtml] = useState('');
  const [mdConflict, setMdConflict] = useState<MdConflictState | null>(null);
  const [mdConflictResolvedContent, setMdConflictResolvedContent] = useState('');
  const [mdExpandedDirs, setMdExpandedDirs] = useState<Set<string>>(new Set());
  const [mdDiffOnly, setMdDiffOnly] = useState(false);
  const mdLiveRef = useRef<HTMLDivElement>(null);
  const turndownRef = useRef<TurndownService | null>(null);
  if (!turndownRef.current) {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*' });
    td.use(gfm);
    turndownRef.current = td;
  }

  // Comment sidebar state
  const [commentSidebarOpen, setCommentSidebarOpen] = useState(false);
  const [fileComments, setFileComments] = useState<FileComment[]>([]);
  const fileCommentsRef = useRef<FileComment[]>([]);
  fileCommentsRef.current = fileComments;
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [commentFilter, setCommentFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [commentInput, setCommentInput] = useState('');
  const [commentAddRange, setCommentAddRange] = useState<CommentAddRange | null>(null);
  const [liveSelectionDraftAnchor, setLiveSelectionDraftAnchor] = useState<LiveSelectionDraftAnchor | null>(null);
  const [liveCommentMarkers, setLiveCommentMarkers] = useState<LiveCommentMarker[]>([]);
  const [showCommentInput, setShowCommentInput] = useState(false);
  const [replyingToCommentId, setReplyingToCommentId] = useState<string | null>(null);
  const [replyInput, setReplyInput] = useState('');
  const [expandedReplyIds, setExpandedReplyIds] = useState<Set<string>>(new Set());
  const commentSidebarRef = useRef<HTMLDivElement>(null);
  const commentAddFormRef = useRef<HTMLDivElement>(null);
  const fileContentRef = useRef<HTMLDivElement>(null);
  const mdLiveContainerRef = useRef<HTMLDivElement>(null);
  const [commentSourceScrollTop, setCommentSourceScrollTop] = useState(0);
  const liveEditCommentBtnRef = useRef<HTMLButtonElement>(null);
  const pendingLiveEditCommentRangeRef = useRef<CommentAddRange | null>(null);
  const pendingLiveEditCommentAnchorRef = useRef<LiveSelectionDraftAnchor | null>(null);
  const pendingLiveEditDomRangeRef = useRef<Range | null>(null);
  const pendingLiveEditSelectedTextRef = useRef<string | null>(null);
  const liveSelectionDraftRangeRef = useRef<Range | null>(null);
  const liveSelectionDraftTextRef = useRef<string | null>(null);
  const fileWorkspaceRestoreRef = useRef<FileWorkspaceState | null>(null);
  const fileWorkspaceRestoredRef = useRef(false);

  // Agent settings
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [settingsAgentConfig, setSettingsAgentConfig] = useState<Agent | null>(null);
  const [agentSettingsLoading, setAgentSettingsLoading] = useState(false);
  const [agentAccessList, setAgentAccessList] = useState<{ email: string; grantedBy: string; createdAt: string }[]>([]);
  const [newAccessEmail, setNewAccessEmail] = useState('');

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const agentUserRequestSubmissionsRef = useRef(agentUserRequestSubmissions);
  agentUserRequestSubmissionsRef.current = agentUserRequestSubmissions;
  const chatMessagesRef = useRef<Record<string, ChatMessage[]>>({});
  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;
  const chatNameRef = useRef(chatName);
  chatNameRef.current = chatName;
  const sessionRunsRef = useRef<Record<string, SessionRunContext>>({});
  const orchestrationsRef = useRef<Record<string, OrchestrationState>>({});
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const sidebarDragRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputHistoryRef = useRef<string[]>([]);
  const inputHistoryIndexRef = useRef(-1);
  const inputDraftRef = useRef('');
  const needsContextRestoreRef = useRef(false);
  const currentAgentSessionsRef = useRef<Record<string, string>>({});
  /* ── Derived ── */

  const filteredAgents = useMemo(() => {
    const match = input.match(/@(\S*)$/);
    if (!match) return [];
    const q = match[1].toLowerCase();
    return agents.filter((a) => a.id !== SCHEDULER_AGENT_ID && (a.id.toLowerCase().includes(q) || a.name?.toLowerCase().includes(q)));
  }, [input, agents]);

  const chatFilterAgents = useMemo(() => agents.filter((agent) => agent.id !== SCHEDULER_AGENT_ID), [agents]);

  const mentionedAgentIds = useMemo(() => getMentionedAgentIds(input, agents), [input, agents]);
  const orchestrationEnabled = mentionedAgentIds.length > 1;

  const agentSidebarItems = useMemo(() => {
    return agents.filter((a) => a.id !== SCHEDULER_AGENT_ID).map((agent) => {
      const running = messages.some((m) => m.agentId === agent.id && m.pending);
      return { ...agent, running };
    });
  }, [agents, messages]);

  const normalizedThemeId = normalizeThemeId(themeId);
  const activeTheme = THEMES[normalizedThemeId];
  const themeStyle = activeTheme.values as React.CSSProperties;
  const mobilePanelOpen = showChatsPanel || showAgentsPanel || showNodesPanel;
  const isCurrentChatSending = useMemo(() => isChatRunning(currentChatId), [currentChatId, runVersion]);

  const mdFileTree = useMemo(() => buildFileTree(mdFilesList), [mdFilesList]);

  function toggleMdDir(dirPath: string) {
    setMdExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }

  function getStatusDisplayText(label: string | undefined, fallback: string): string {
    const trimmed = label?.trim() || '';
    return /[A-Za-z0-9]/.test(trimmed) ? trimmed : fallback;
  }

  function getSidebarStatusDisplayLabel(label: string): string {
    return getStatusDisplayText(label, 'Running').match(/[A-Za-z0-9]+/)?.[0] || 'Running';
  }

  function getAgentLocationLabel(agent: Agent): string {
    if (!agent.relay) return `@${agent.id}`;
    const nodeId = agent.relayConnectionName || agent.id;
    return `🌐 ${agent.relayConnectionLabel?.trim() || nodeId}`;
  }

  function getAgentLocationTitle(agent: Agent): string | undefined {
    if (!agent.relay) return undefined;
    return agent.relayConnectionName || agent.id;
  }

  const getChatSidebarStatus= useCallback((chatId: string): { label: string; kind: 'running' | 'done' | 'error' } | null => {
    const hasActiveRun = isChatRunning(chatId);
    const chatMessages = chatMessagesRef.current[chatId] || (chatId === currentChatId ? messages : []);
    const pendingAgent = [...chatMessages].reverse().find((m) => m.type === 'agent' && m.pending);
    if (hasActiveRun || pendingAgent) {
      return { label: pendingAgent?.statusText || 'Running', kind: 'running' };
    }
    if ([...chatMessages].reverse().some((m) => m.type === 'user' && m.sendStatus === 'failed')) {
      return { label: 'Error', kind: 'error' };
    }
    const lastAgent = [...chatMessages].reverse().find((m) => m.type === 'agent');
    if (!lastAgent) return null;
    if ((lastAgent.content || '').trim().startsWith('⚠️')) return { label: 'Error', kind: 'error' };
    return { label: 'Done', kind: 'done' };
  }, [currentChatId, messages, runVersion]);

  const visibleMessages = useMemo(() => {
    if (!selectedAgentFilter) return messages;
    return messages.filter((m) => m.type !== 'agent' || m.agentId === selectedAgentFilter);
  }, [messages, selectedAgentFilter]);

  /* ── Effects ── */

  useEffect(() => { setMentionSelectedIndex(0); }, [input, agents]);

  // Close any open modal on ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightboxImage) { setLightboxImage(null); return; }
      if (showAgentSettings) { setShowAgentSettings(false); return; }
      if (showAddAgent) { setShowAddAgent(false); return; }
      if (showAddRelayAgent) { setShowAddRelayAgent(false); return; }
      if (showAddRemoteAgent) { setShowAddRemoteAgent(false); return; }
      if (showSetupScript) { setShowSetupScript(false); return; }
      if (shareDialog) { setShareDialog(null); return; }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [lightboxImage, showAgentSettings, showAddAgent, showAddRelayAgent, showAddRemoteAgent, showSetupScript, shareDialog]);

  // Sidebar resize drag handler
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      const newWidth = Math.max(260, Math.min(600, e.clientX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      if (sidebarDragRef.current) {
        sidebarDragRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  useEffect(() => {
    if (chatFilterAgents.length === 0) return; // agents not loaded yet — don't clobber saved filter
    if (chatAgentFilter && !chatFilterAgents.some((agent) => agent.id === chatAgentFilter)) {
      setChatAgentFilter(null);
      try { window.localStorage.removeItem(STORAGE_AGENT_FILTER); } catch { /* ignore */ }
    }
  }, [chatAgentFilter, chatFilterAgents]);

  useEffect(() => {
    const activeRequestIds = new Set<string>();
    for (const chatMessages of Object.values(chatMessagesRef.current)) {
      for (const message of chatMessages) {
        if (message.userRequest?.id) activeRequestIds.add(message.userRequest.id);
      }
    }

    const currentSubmissions = agentUserRequestSubmissionsRef.current;
    const staleRequestIds = Object.keys(currentSubmissions).filter((requestId) => !activeRequestIds.has(requestId));
    if (staleRequestIds.length === 0) return;

    const next = { ...currentSubmissions };
    for (const requestId of staleRequestIds) delete next[requestId];
    agentUserRequestSubmissionsRef.current = next;
    setAgentUserRequestSubmissions(next);
  }, [messages, currentChatId, runVersion]);

  useEffect(() => {
    setMounted(true);
    const savedInput = window.localStorage.getItem(STORAGE_CHAT_INPUT);
    const savedCollapsed = window.localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED);

    if (savedInput) setInput(savedInput);
    if (savedCollapsed != null) setSidebarCollapsed(savedCollapsed === '1');
    const savedCommentSidebar = window.localStorage.getItem('commentSidebarOpen');
    if (savedCommentSidebar != null) setCommentSidebarOpen(savedCommentSidebar === 'true');
    const savedFileWorkspace = parseFileWorkspaceState(window.localStorage.getItem(STORAGE_FILE_WORKSPACE));
    if (savedFileWorkspace) {
      fileWorkspaceRestoreRef.current = savedFileWorkspace;
      setLeftSidebarTab(savedFileWorkspace.tab);
      setMdDiffOnly(savedFileWorkspace.diffOnly);
      setMdEditorMode(savedFileWorkspace.editorMode);
    }

    // Restore agent filter tab
    try {
      const savedFilter = window.localStorage.getItem(STORAGE_AGENT_FILTER);
      if (savedFilter) setChatAgentFilter(savedFilter);
    } catch { /* ignore */ }

    // Load chat history + last active chat from server (SQLite is source of truth)
    fetch('/api/chats').then(r => r.json()).then(data => {
      if (data.ok && Array.isArray(data.chats)) setChatHistory(normalizeChatHistory(data.chats));
      const lastChatId = (data.lastChatId as string | null) || (data.chats?.[0]?.id as string | null);
      if (lastChatId) {
        currentChatIdRef.current = lastChatId;
        setCurrentChatId(lastChatId);
        setActiveSidebarChatId(lastChatId);
        // Load that chat's messages from server
        fetch(`/api/chats?id=${encodeURIComponent(lastChatId)}`)
          .then(r => r.json())
          .then(chatData => {
            if (chatData.ok && chatData.chat) {
              const agentSessions = chatData.chat.agentSessions || {};
              const isReviewChat = typeof lastChatId === 'string' && lastChatId.startsWith('comment-review:');
              const migration = migrateFailedSendWarnings(chatData.chat.messages || [], agentSessions, {
                inferLatestUserFailure: !isReviewChat,
              });
              const msgs = migration.messages;
              currentAgentSessionsRef.current = agentSessions;
              setMessagesForChat(lastChatId, msgs.length > 0 ? msgs : [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }]);
              setChatName(chatData.chat.name || lastChatId);
              needsContextRestoreRef.current = true;
              setLoadedChatIdForResume(lastChatId);
              if (migration.changed) {
                void persistLoadedChatMigration(lastChatId, chatData.chat.name || lastChatId, chatData.chat.ts || Date.now(), msgs, agentSessions);
              }
            }
          })
          .catch(() => { /* ignore */ });
      }
    }).catch(() => { /* ignore */ });

    try {
      const savedInputHistory = window.localStorage.getItem(STORAGE_INPUT_HISTORY);
      if (savedInputHistory) inputHistoryRef.current = JSON.parse(savedInputHistory) || [];
    } catch { /* ignore */ }
    try {
      const savedTheme = window.localStorage.getItem(STORAGE_THEME);
      if (savedTheme) {
        const nextThemeId = normalizeThemeId(savedTheme);
        setThemeId(nextThemeId);
        if (nextThemeId !== savedTheme) window.localStorage.setItem(STORAGE_THEME, nextThemeId);
      }
    } catch { /* ignore */ }
    void loadAgents();
  }, []);

  useEffect(() => {
    if (mounted) window.localStorage.setItem('commentSidebarOpen', String(commentSidebarOpen));
  }, [commentSidebarOpen, mounted]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_FILE_WORKSPACE, JSON.stringify({
      tab: leftSidebarTab,
      agentId: mdSelectedAgentId,
      filePath: mdSelectedFile,
      diffOnly: mdDiffOnly,
      editorMode: mdEditorMode,
    } satisfies FileWorkspaceState));
  }, [leftSidebarTab, mdSelectedAgentId, mdSelectedFile, mdDiffOnly, mdEditorMode, mounted]);

  useEffect(() => {
    const el = chatContainerRef.current;
    if (el && shouldStickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const container = el;
    function handleScroll() {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      shouldStickToBottomRef.current = distanceFromBottom < 80;
    }
    handleScroll();
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const singleLineHeight = 28;
    const maxHeight = 180;

    el.style.height = `${singleLineHeight}px`;
    const nextHeight = Math.min(Math.max(el.scrollHeight, singleLineHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [input]);

  // Resume agent sessions once after auth state is determined
  const sessionResumedChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mounted || authStatus === 'loading') return;
    const activeChatId = currentChatIdRef.current;
    if (!activeChatId) return;
    if (loadedChatIdForResume !== activeChatId) return;
    if (sessionResumedChatIdRef.current === activeChatId) return;
    sessionResumedChatIdRef.current = activeChatId;
    needsContextRestoreRef.current = true;
    const sessions = currentAgentSessionsRef.current;
    const entries = Object.entries(sessions)
      .map(([agentId, raw]) => [agentId, lastSessionId(raw)] as [string, string | null])
      .filter(([, sid]) => !!sid) as [string, string][];
    if (entries.length === 0) return;
    void (async () => {
      try {
        const results = await Promise.allSettled(
          entries.map(([agentId, sessionId]) =>
            acp({ action: 'resume-session', agentId, sessionId, chatId: activeChatId })
          )
        );
        const allLoaded = results.every(
          r => r.status === 'fulfilled' && (r as any).value?.loaded === true
        );
        if (allLoaded) {
          needsContextRestoreRef.current = false;
        }
        // Handle recovered messages and pending user messages from session/load replay
        for (const [index, r] of results.entries()) {
          if (r.status !== 'fulfilled') continue;
          const agentId = entries[index]?.[0];
          const val = (r as any).value;
          if (agentId && val?.sessionId) {
            currentAgentSessionsRef.current = { ...currentAgentSessionsRef.current, [agentId]: val.sessionId };
          }
          if (agentId && val?.activeTurn && !val.activeTurn.done) {
            resumeActiveTurn(agentId, val.activeTurn);
          }
          // Append recovered agent messages that were in ACP but missing from our DB
          if (val?.recoveredMessages?.length > 0) {
            for (const rm of val.recoveredMessages) {
              addMessage({ type: 'agent', content: rm.content, agentId: rm.agentId, ts: rm.ts });
            }
            addMessage({ type: 'system', content: `✅ Recovered ${val.recoveredMessages.length} message(s) from previous session.` });
          }
        }
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, authStatus, loadedChatIdForResume, acp]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_CHAT_INPUT, input);
  }, [input, mounted]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const nextThemeId = normalizeThemeId(themeId);
    if (nextThemeId !== themeId) {
      setThemeId(nextThemeId);
      return;
    }
    window.localStorage.setItem(STORAGE_THEME, nextThemeId);
  }, [themeId, mounted]);

  useEffect(() => {
    if (!showThemeMenu) return;
    function handlePointerDown(event: MouseEvent) {
      if (!themeMenuRef.current?.contains(event.target as Node)) {
        setShowThemeMenu(false);
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showThemeMenu]);

  useEffect(() => {
    if (!openChatMenuId) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.chatActionsWrap') && !target?.closest('.chatActionsMenu')) {
        setOpenChatMenuId(null);
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [openChatMenuId]);

  /* ── Core functions ── */

  function setMessagesForChat(chatId: string, nextMessages: ChatMessage[]) {
    chatMessagesRef.current[chatId] = nextMessages;
    if (currentChatIdRef.current === chatId) {
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    } else {
      notifyRunStateChanged();
    }
  }

  function addMessage(msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }, chatId = currentChatIdRef.current) {
    const next: ChatMessage = { id: msg.id || makeId(), ts: msg.ts || Date.now(), ...msg };
    const base = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    setMessagesForChat(chatId, [...base, next]);
    return next.id;
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>, chatId = currentChatIdRef.current) {
    const base = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    setMessagesForChat(chatId, base.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function removeMessage(id: string, chatId = currentChatIdRef.current) {
    const base = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    setMessagesForChat(chatId, base.filter((m) => m.id !== id));
  }

  function getSendFailureError(message: ChatMessage): string {
    const text = message.content.trim();
    return text.replace(/^⚠️\s*/, '').replace(/^Send failed:\s*/i, '') || 'Failed to send prompt to agent';
  }

  function shouldInferFailedTargetFromWarning(userMessage: ChatMessage): boolean {
    return !/(?:^|\s)@\S+/.test(userMessage.content);
  }

  function hasPersistedAgentSession(agentSessions?: Record<string, string>): boolean {
    return Object.values(agentSessions || {}).some((session) => !!lastSessionId(session));
  }

  function hasVisibleMessageText(message: ChatMessage): boolean {
    return Boolean(
      message.content.trim() ||
      message.parts?.some((part) => part.kind === 'text' && part.text.trim())
    );
  }

  function getLatestUserWithoutSavedResponseIndex(chatMessages: ChatMessage[]): number {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const message = chatMessages[i];
      if (message.type === 'system') continue;
      if (message.type === 'user') return i;
      if (hasVisibleMessageText(message)) return -1;
    }
    return -1;
  }

  function migrateFailedSendWarnings(
    chatMessages: ChatMessage[],
    agentSessions?: Record<string, string>,
    options?: { inferLatestUserFailure?: boolean },
  ): { messages: ChatMessage[]; changed: boolean } {
    const inferLatestUserFailure = options?.inferLatestUserFailure !== false;
    const migrated: ChatMessage[] = [];
    let changed = false;
    for (const message of chatMessages) {
      if (isSendFailureMessage(message)) {
        const previous = migrated[migrated.length - 1];
        if (previous?.type === 'user') {
          const shouldInferTarget = shouldInferFailedTargetFromWarning(previous);
          const resendAgentIds = shouldInferTarget && message.agentId ? [message.agentId] : previous.resendAgentIds;
          migrated[migrated.length - 1] = {
            ...previous,
            sendStatus: 'failed',
            sendError: getSendFailureError(message),
            resendAgentIds,
            resendMessage: shouldInferTarget ? (previous.resendMessage || previous.content) : previous.resendMessage,
          };
          changed = true;
          continue;
        }
      }
      migrated.push(message);
    }
    if (inferLatestUserFailure && !hasPersistedAgentSession(agentSessions)) {
      const userIndex = getLatestUserWithoutSavedResponseIndex(migrated);
      const userMessage = userIndex >= 0 ? migrated[userIndex] : null;
      if (userMessage?.type === 'user' && userMessage.sendStatus !== 'failed') {
        migrated[userIndex] = {
          ...userMessage,
          sendStatus: 'failed',
          sendError: userMessage.sendError || 'Failed to send prompt to agent',
        };
        changed = true;
      }
    }
    return { messages: migrated, changed };
  }

  function getPersistableMessages(chatMessages: ChatMessage[]): ChatMessage[] {
    return chatMessages.filter(m => !(m.type === 'system' && m.ts !== 0));
  }

  async function persistLoadedChatMigration(
    chatId: string,
    name: string,
    ts: number,
    chatMessages: ChatMessage[],
    agentSessions: Record<string, string>,
  ) {
    const chatData = {
      id: chatId,
      name: name || chatId,
      ts: ts || Date.now(),
      messages: getPersistableMessages(chatMessages),
      agentSessions,
    };
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatData }),
      });
    } catch { /* ignore */ }
  }

  async function loadChatIntoCache(chatId: string) {
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (data.ok && data.chat) {
        const agentSessions = data.chat.agentSessions || {};
        // Comment-review chats dispatch the agent immediately after approval; the
        // "no agent response yet" state is expected and should not be inferred
        // as a send failure.
        const isReviewChat = typeof chatId === 'string' && chatId.startsWith('comment-review:');
        const migration = migrateFailedSendWarnings(data.chat.messages || [], agentSessions, {
          inferLatestUserFailure: !isReviewChat,
        });
        setMessagesForChat(chatId, migration.messages);
        if (migration.changed) {
          void persistLoadedChatMigration(chatId, data.chat.name || chatId, data.chat.ts || Date.now(), migration.messages, agentSessions);
        }
        setChatHistory(prev => {
          const entry = {
            id: data.chat.id,
            name: data.chat.name || chatId,
            ts: data.chat.ts || Date.now(),
            agentSessions,
          };
          if (prev.some(c => c.id === chatId)) return prev.map(c => c.id === chatId ? entry : c);
          return normalizeChatHistory([entry, ...prev]);
        });
      }
    } catch (err) {
      console.error('Failed to load review chat', err);
    }
  }

  function notifyRunStateChanged() {
    setRunVersion((version) => version + 1);
  }

  async function copyShareDialogLink() {
    if (!shareDialog?.url) return;
    try {
      await navigator.clipboard.writeText(shareDialog.url);
      setShareDialog((prev) => prev ? { ...prev, copied: true, detail: 'Copied to clipboard.' } : prev);
    } catch {
      setShareDialog((prev) => prev ? { ...prev, copied: false, detail: 'Could not copy automatically. Select the link and copy it manually.' } : prev);
    }
  }

  function getMessageCopyText(message: ChatMessage): string {
    if (message.parts && message.parts.length > 0) {
      return message.parts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join('') || message.content || '';
    }
    return message.content || '';
  }

  async function copyMessageToClipboard(message: ChatMessage) {
    const text = getMessageCopyText(message);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === message.id ? null : current);
      }, 1500);
    } catch (err) {
      console.error('Failed to copy message', err);
    }
  }

  function renderAttachmentsList(list?: ChatAttachment[], mode: 'composer' | 'message' = 'message') {
    if (!list?.length) return null;
    return (
      <div className={mode === 'composer' ? 'attachmentTray' : 'messageAttachments'}>
        {list.map((attachment) => (
          <div
            key={attachment.id}
            className={mode === 'composer' ? 'attachmentChip' : 'messageAttachment'}
            title={mode === 'composer' ? `${attachment.name} · ${getAttachmentTypeLabel(attachment)} · ${formatBytes(attachment.size)}` : undefined}
          >
            {attachment.kind === 'image' && mode === 'message' ? (
              <span className="messageAttachmentImageWrap" tabIndex={0} aria-label={`Preview ${attachment.name}`}
                onClick={() => { setLightboxImage(attachment.dataUrl); }}
                style={{ cursor: 'pointer' }}
              >
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="messageAttachmentImage"
                />
                <span className="messageAttachmentPreview" aria-hidden="true">
                  <img src={attachment.dataUrl} alt="" className="messageAttachmentPreviewImage" />
                </span>
              </span>
            ) : attachment.kind === 'image' ? (
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className={mode === 'composer' ? 'attachmentThumb' : 'messageAttachmentImage'}
              />
            ) : (
              <div className={mode === 'composer' ? 'attachmentFileIcon' : 'messageAttachmentFileIcon'} aria-hidden="true">
                <span className="attachmentFileIconLabel">{getAttachmentIconLabel(attachment)}</span>
              </div>
            )}
            <div className="attachmentMeta">
              <span className="attachmentName" title={attachment.name}>{attachment.name}</span>
              {mode === 'composer' ? null : <span className="attachmentDetails">{getAttachmentTypeLabel(attachment)} · {formatBytes(attachment.size)}</span>}
            </div>
            {mode === 'composer' ? (
              <button
                type="button"
                className="attachmentRemoveButton"
                aria-label={`Remove ${attachment.name}`}
                title={`Remove ${attachment.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  function renderAgentUserRequest(message: ChatMessage) {
    const request = message.userRequest;
    if (!request || !message.agentId) return null;
    const submission = agentUserRequestSubmissions[request.id];
    const isSubmitting = submission?.pending === true;
    const submissionError = submission?.error;
    const structuredQuestions = Array.isArray(request.questions) ? request.questions : [];

    return (
      <div className="agentUserRequestCard">
        <div className="agentUserRequestHeader">{request.title}</div>
        <div className="agentUserRequestPrompt">{request.prompt}</div>
        {structuredQuestions.length > 0 ? (
          <form
            key={request.id}
            className="agentUserRequestForm structured"
            onSubmit={(e) => {
              e.preventDefault();
              if (isSubmitting) return;
              const form = e.currentTarget;
              const answers: Record<string, AgentUserRequestAnswer> = {};
              let hasAnswer = false;
              structuredQuestions.forEach((question, index) => {
                const fieldName = `question-${index}`;
                const questionOptions = Array.isArray(question.options) ? question.options : [];
                if (questionOptions.length > 0) {
                  const select = form.elements.namedItem(fieldName) as HTMLSelectElement | null;
                  const selected = select ? Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean) : [];
                  const freeformInput = form.elements.namedItem(`${fieldName}-freeform`) as HTMLInputElement | null;
                  const freeText = freeformInput?.value.trim() || null;
                  const skipped = selected.length === 0 && !freeText;
                  if (!skipped) hasAnswer = true;
                  answers[question.header] = { selected, freeText, skipped };
                  return;
                }
                const input = form.elements.namedItem(fieldName) as HTMLInputElement | null;
                const freeText = input?.value.trim() || null;
                const skipped = !freeText;
                if (!skipped) hasAnswer = true;
                answers[question.header] = { selected: [], freeText, skipped };
              });
              if (hasAnswer) void submitAgentUserRequest(message, { answers });
            }}
          >
            <div className="agentUserRequestQuestions">
              {structuredQuestions.map((question, index) => {
                const fieldName = `question-${index}`;
                const fieldId = `${request.id}-question-${index}`;
                const questionOptions = Array.isArray(question.options) ? question.options : [];
                return (
                  <div key={`${request.id}-${question.header}-${index}`} className="agentUserRequestQuestion">
                    <label className="agentUserRequestQuestionLabel" htmlFor={fieldId}>{question.question || question.header}</label>
                    {question.message ? <div className="agentUserRequestQuestionMessage">{question.message}</div> : null}
                    {questionOptions.length > 0 ? (
                      <>
                        <select
                          id={fieldId}
                          name={fieldName}
                          className="agentUserRequestSelect"
                          aria-label={question.header}
                          multiple={question.multiSelect === true}
                          disabled={isSubmitting}
                        >
                          {question.multiSelect === true ? null : <option value="">Select an answer</option>}
                          {questionOptions.map((option) => (
                            <option key={option.optionId} value={option.label}>
                              {option.recommended ? `${option.label} (Recommended)` : option.label}
                            </option>
                          ))}
                        </select>
                        {question.allowFreeformInput !== false ? (
                          <input
                            name={`${fieldName}-freeform`}
                            className="agentUserRequestInput"
                            placeholder="Or type your answer"
                            aria-label={`${question.header} freeform answer`}
                            disabled={isSubmitting}
                          />
                        ) : null}
                      </>
                    ) : (
                      <input
                        id={fieldId}
                        name={fieldName}
                        className="agentUserRequestInput"
                        placeholder="Type your answer"
                        aria-label={question.header}
                        disabled={isSubmitting}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <button type="submit" className="agentUserRequestButton" disabled={isSubmitting}>Send</button>
          </form>
        ) : request.inputKind === 'options' ? (
          <div className="agentUserRequestActions">
            {request.options.map((option) => (
              <button
                key={option.optionId}
                type="button"
                className="agentUserRequestButton"
                disabled={isSubmitting}
                onClick={() => void submitAgentUserRequest(message, { optionId: option.optionId })}
              >
                {getAgentUserRequestOptionLabel(option)}
              </button>
            ))}
          </div>
        ) : (
          <form
            key={request.id}
            className="agentUserRequestForm"
            onSubmit={(e) => {
              e.preventDefault();
              if (isSubmitting) return;
              const form = e.currentTarget;
              const input = form.elements.namedItem('answer') as HTMLInputElement | null;
              const answer = input?.value.trim() || '';
              if (answer) void submitAgentUserRequest(message, { answer });
            }}
          >
            <input
              name="answer"
              className="agentUserRequestInput"
              placeholder="Type your answer"
              aria-label={`Response to ${request.title}`}
              disabled={isSubmitting}
            />
            <button type="submit" className="agentUserRequestButton" disabled={isSubmitting}>Send</button>
          </form>
        )}
        {submissionError ? <div className="agentUserRequestError" role="alert">{submissionError}</div> : null}
      </div>
    );
  }

  function renderUserSendFailure(message: ChatMessage) {
    if (message.type !== 'user' || message.sendStatus !== 'failed') return null;
    const chatId = currentChatIdRef.current;
    const waitingForAgents = !message.resendAgentIds?.length && (agentsLoading || agents.length === 0);
    const resendDisabled = isChatRunning(chatId) || waitingForAgents;
    const error = message.sendError || 'Failed to send prompt to agent';
    return (
      <div className="userSendFailure">
        <span className="userSendFailurePill">
          <span className="userSendFailureStatus" title={error} aria-label={`Failed: ${error}`}>
            Failed
          </span>
          <button
            type="button"
            className="userSendFailureButton"
            disabled={resendDisabled}
            title={waitingForAgents ? 'Waiting for agents to load' : 'Retry sending this message'}
            onClick={() => void resendFailedUserMessage(message)}
          >
            Resend
          </button>
        </span>
      </div>
    );
  }

  async function loadAgents() {
    setAgentsLoading(true);
    try {
      const data = await acp({ action: 'list-agents' });
      if (data.ok && Array.isArray(data.agents)) {
        setAgents(data.agents);
      }
    } catch (err) {
      console.error('Failed to load agents', err);
    } finally {
      setAgentsLoading(false);
    }
  }

  async function nodesApi(body: Record<string, unknown>) {
    const res = await fetch('/api/nodes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  async function loadNodes() {
    setNodesLoading(true);
    try {
      const data = await nodesApi({ action: 'list-nodes' });
      if (data.ok && Array.isArray(data.nodes)) {
        setNodesData(data.nodes);
      }
    } catch (err) {
      console.error('Failed to load nodes', err);
    } finally {
      setNodesLoading(false);
    }
  }

  /* ── Markdown Files helpers ── */

  const [mdFilesError, setMdFilesError] = useState<string | null>(null);

  async function loadMdFiles(agentId: string, diff = false) {
    setMdFilesLoading(true);
    setMdFilesList([]);
    setMdFilesError(null);
    setMdExpandedDirs(new Set());
    try {
      const url = `/api/markdown?agentId=${encodeURIComponent(agentId)}${diff ? '&diff=true' : ''}`;
      const res = await fetch(url);
      if (res.status === 403) {
        setMdFilesError('unauthorized');
        return;
      }
      const data = await res.json();
      if (data.files) setMdFilesList(data.files);
    } catch (err) {
      console.error('Failed to load files', err);
    } finally {
      setMdFilesLoading(false);
    }
  }

  async function loadFileComments(agentId: string, filePath: string) {
    try {
      const res = await fetch(`/api/comments?agentId=${encodeURIComponent(agentId)}&filePath=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.ok) setFileComments(data.comments);
    } catch { /* ignore */ }
  }

  async function openMdFileForAgent(agentId: string, filePath: string, options?: { skipDirtyConfirm?: boolean; editorMode?: MdEditorMode }) {
    if (!options?.skipDirtyConfirm && mdDirty) {
      if (!confirm('You have unsaved changes. Discard?')) return;
    }
    try {
      const res = await fetch(`/api/markdown?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.content !== undefined) {
        setMdSelectedFile(filePath);
        setMdFileContent(data.content);
        setMdEditContent(data.content);
        setMdFileMtime(data.mtime || null);
        setMdDirty(false);
        setMdLiveHtml(isMarkdownFile(filePath) ? markdownToHtml(data.content) : '');
        setMdEditorMode(current => normalizeFileEditorMode(options?.editorMode ?? current, filePath));
        setCommentSourceScrollTop(0);
        window.requestAnimationFrame(() => {
          mdLiveContainerRef.current?.scrollTo({ top: 0 });
          fileContentRef.current?.scrollTo({ top: 0 });
        });
        setMdEditorOpen(true);
        setFileComments([]);
        setSelectedCommentId(null);
        setShowCommentInput(false);
        setCommentAddRange(null);
        clearLiveSelectionDraft();
        void loadFileComments(agentId, filePath);
      }
    } catch (err) {
      console.error('Failed to read markdown file', err);
    }
  }

  async function openMdFile(filePath: string) {
    if (!mdSelectedAgentId) return;
    await openMdFileForAgent(mdSelectedAgentId, filePath);
  }

  useEffect(() => {
    if (!mounted || agentsLoading || fileWorkspaceRestoredRef.current) return;

    const workspace = fileWorkspaceRestoreRef.current;
    if (!workspace) {
      fileWorkspaceRestoredRef.current = true;
      return;
    }

    setLeftSidebarTab(workspace.tab);
    setMdDiffOnly(workspace.diffOnly);
    setMdEditorMode(normalizeFileEditorMode(workspace.editorMode, workspace.filePath));
    fileWorkspaceRestoredRef.current = true;

    if (workspace.tab !== 'files' || !workspace.agentId) return;

    const agentCanShowFiles = agents.some(a => a.id === workspace.agentId && a.cwd && !a.relay && a.id !== SCHEDULER_AGENT_ID);
    if (!agentCanShowFiles) return;

    const agentId = workspace.agentId;
    setMdSelectedAgentId(agentId);
    void (async () => {
      await loadMdFiles(agentId, workspace.diffOnly);
      if (workspace.filePath) {
        await openMdFileForAgent(agentId, workspace.filePath, {
          skipDirtyConfirm: true,
          editorMode: workspace.editorMode,
        });
      }
    })();
  }, [mounted, agentsLoading, agents]);

  async function handleCreateComment() {
    if (!mdSelectedAgentId || !mdSelectedFile || !commentInput.trim() || !commentAddRange) return;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          agentId: mdSelectedAgentId,
          filePath: mdSelectedFile,
          rangeStartLine: commentAddRange.startLine,
          rangeEndLine: commentAddRange.endLine,
          rangeStartChar: commentAddRange.startChar,
          rangeEndChar: commentAddRange.endChar,
          content: commentInput.trim(),
          authorType: 'user',
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setCommentInput('');
        setShowCommentInput(false);
        setCommentAddRange(null);
        clearLiveSelectionDraft();
        void loadFileComments(mdSelectedAgentId, mdSelectedFile);
        if (!commentSidebarOpen) setCommentSidebarOpen(true);
      }
    } catch { /* ignore */ }
  }

  async function handleRejectComment(commentId: string) {
    try {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reject', commentId }),
      });
      if (mdSelectedAgentId && mdSelectedFile) void loadFileComments(mdSelectedAgentId, mdSelectedFile);
    } catch { /* ignore */ }
  }

  async function handleDeleteComment(commentId: string) {
    try {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', commentId }),
      });
      if (selectedCommentId === commentId) setSelectedCommentId(null);
      if (mdSelectedAgentId && mdSelectedFile) void loadFileComments(mdSelectedAgentId, mdSelectedFile);
    } catch { /* ignore */ }
  }

  async function handleReplyComment(commentId: string) {
    if (!replyInput.trim()) return;
    try {
      await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply',
          commentId,
          content: replyInput.trim(),
          authorType: 'user',
        }),
      });
      setReplyInput('');
      setReplyingToCommentId(null);
      if (mdSelectedAgentId && mdSelectedFile) void loadFileComments(mdSelectedAgentId, mdSelectedFile);
    } catch { /* ignore */ }
  }

  function openCommentReviewChat(chatId: string) {
    setLeftSidebarTab('chats');
    void loadChat(chatId);
  }

  function getContextForComment(comment: FileComment) {
    const lines = mdFileContent.split('\n');
    const startLine = Math.max(0, (comment.rangeStartLine ?? 1) - 3);
    const endLine = Math.min(lines.length, (comment.rangeEndLine ?? comment.rangeStartLine ?? 1) + 3);
    return lines.slice(startLine, endLine).join('\n');
  }

  async function startNextQueuedComment(chatId: string) {
    const queuedComment = fileCommentsRef.current.find(c => c.linkedChatId === chatId && c.status === 'queued');
    const fileContent = queuedComment ? getContextForComment(queuedComment) : mdFileContent;
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start-next-queued', chatId, fileContent }),
      });
      const data = await res.json();
      if (!data.ok || !data.started) return;
      setFileComments(prev => prev.map(c =>
        c.id === data.commentId ? { ...c, status: 'processing' as const, linkedChatId: data.chatId } : c
      ));
      await loadChatIntoCache(data.chatId);
      if (data.agentId && data.prompt) {
        await dispatchReviewCommentToAgent(data.agentId, data.prompt, data.commentId, data.chatId);
      }
    } catch (err) {
      console.error('Failed to start queued comment', err);
    }
  }

  async function resolveProcessingCommentForChat(chatId: string, commentId: string) {
    const commentToResolve = fileCommentsRef.current.find(c => c.id === commentId && c.linkedChatId === chatId && c.status === 'processing');
    if (!commentToResolve) return;
    setFileComments(prev => prev.map(c =>
      c.id === commentToResolve.id ? { ...c, status: 'resolved' as const } : c
    ));
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
  }

  async function resetProcessingCommentForRetry(commentId: string) {
    setFileComments(prev => prev.map(c =>
      c.id === commentId ? { ...c, status: 'active' as const, linkedChatId: null } : c
    ));
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
  }

  async function handleStopProcessingComment(comment: FileComment) {
    if (comment.status !== 'processing' || !comment.linkedChatId) return;

    const reviewChatId = comment.linkedChatId;
    const activeRun = Object.entries(sessionRunsRef.current).find(([, run]) =>
      run.chatId === reviewChatId && run.commentId === comment.id
    );
    const agentId = activeRun?.[1].agentId || comment.agentId;

    try {
      await acp({ action: 'interrupt', agentId, chatId: reviewChatId });
    } catch (err) {
      console.error('Failed to stop processing comment', err);
      return;
    }

    if (activeRun) {
      const [runKey, run] = activeRun;
      clearAgentUserRequestSubmissionForMessage(run.pendingId, run.chatId);
      updateMessage(run.pendingId, {
        content: run.currentText || '⏹ Stopped',
        pending: false,
        statusText: undefined,
        ptyPhase: undefined,
        userRequest: undefined,
      }, run.chatId);
      delete sessionRunsRef.current[runKey];
      notifyRunStateChanged();
    }

    await resetProcessingCommentForRetry(comment.id);
    setSelectedCommentId(comment.id);
    await startNextQueuedComment(reviewChatId);
  }

  async function dispatchReviewCommentToAgent(agentId: string, prompt: string, commentId: string, chatId: string) {
    try {
      await dispatchToAgent(agentId, prompt, `comment-${commentId}`, 'worker', { chatId, commentId });
      return true;
    } catch (err) {
      console.error('Failed to dispatch approved comment', err);
      await resetProcessingCommentForRetry(commentId);
      return false;
    }
  }

  async function handleApproveComment(commentId: string) {
    const comment = fileComments.find(c => c.id === commentId);
    if (!comment) return;

    const contextContent = getContextForComment(comment);

    try {
      const res = await fetch('/api/comments/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, fileContent: contextContent }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Failed to approve comment', data.error || 'unknown error');
        return;
      }

      const nextStatus: FileComment['status'] = data.status === 'queued' ? 'queued' : 'processing';
      setFileComments(prev => prev.map(c =>
        c.id === commentId ? { ...c, status: nextStatus, linkedChatId: data.chatId } : c
      ));
      await loadChatIntoCache(data.chatId);

      if (nextStatus === 'processing' && data.agentId && data.prompt) {
        await dispatchReviewCommentToAgent(data.agentId, data.prompt, commentId, data.chatId);
      }
    } catch (err) {
      console.error('Failed to approve comment', err);
    }
  }

  function getCommentsByLine(): Map<number, FileComment[]> {
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
  }

  function getCommentLineTop(comment: FileComment): number {
    return Math.max(0, ((comment.rangeStartLine ?? 1) - 1) * FILE_REVIEW_LINE_HEIGHT);
  }

  function getCommentDisplayTop(comment: FileComment): number {
    if (mdEditorMode === 'live' && mdSelectedFile && isMarkdownFile(mdSelectedFile)) {
      const marker = liveCommentMarkers.find(m => m.commentIds.includes(comment.id));
      if (marker) return marker.top;
    }
    return getCommentLineTop(comment);
  }

  function getVisibleSidebarComments(): FileComment[] {
    return fileComments
      .filter(c => commentFilter === 'all' || (commentFilter === 'active' ? c.status !== 'resolved' : c.status === 'resolved'))
      .slice()
      .sort((a, b) => {
        const lineDiff = (a.rangeStartLine ?? Number.MAX_SAFE_INTEGER) - (b.rangeStartLine ?? Number.MAX_SAFE_INTEGER);
        if (lineDiff !== 0) return lineDiff;
        return a.createdAt.localeCompare(b.createdAt);
      });
  }

  function getEstimatedCommentCardHeight(comment: FileComment): number {
    const expanded = selectedCommentId === comment.id || comment.status === 'processing' || comment.status === 'queued';
    const replyHeight = expanded ? Math.min(comment.replies.length, 2) * 24 : 0;
    const replyInputHeight = replyingToCommentId === comment.id ? 40 : 0;
    return (expanded ? COMMENT_SIDEBAR_EXPANDED_CARD_HEIGHT : COMMENT_SIDEBAR_COLLAPSED_CARD_HEIGHT) + replyHeight + replyInputHeight;
  }

  function getCommentStatusLabel(status: FileComment['status']): string {
    if (status === 'processing') return 'Processing';
    if (status === 'queued') return 'Queued';
    if (status === 'resolved') return 'Resolved';
    return 'Active';
  }

  function getCommentSidebarDesiredTop(comment: FileComment): number {
    return getCommentDisplayTop(comment) - commentSourceScrollTop;
  }

  function compareCommentsBySidebarTop(a: FileComment, b: FileComment): number {
    const topDiff = getCommentDisplayTop(a) - getCommentDisplayTop(b);
    if (Math.abs(topDiff) > 0.5) return topDiff;

    const lineDiff = (a.rangeStartLine ?? Number.MAX_SAFE_INTEGER) - (b.rangeStartLine ?? Number.MAX_SAFE_INTEGER);
    if (lineDiff !== 0) return lineDiff;

    return a.createdAt.localeCompare(b.createdAt);
  }

  function getCommentSidebarLayout(comments: FileComment[]): Map<string, number> {
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
    if (selectedComment && mdEditorMode === 'live' && mdSelectedFile && isMarkdownFile(mdSelectedFile)) {
      const selectedTop = getCommentSidebarDesiredTop(selectedComment);
      const commentsBeforeSelected: FileComment[] = [];
      const commentsAfterSelected: FileComment[] = [];

      for (const comment of sortedComments) {
        if (comment.id === selectedComment.id) continue;
        const desiredTop = getCommentSidebarDesiredTop(comment);
        const bottom = desiredTop + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP;
        if (bottom <= selectedTop) {
          commentsBeforeSelected.push(comment);
        } else {
          commentsAfterSelected.push(comment);
        }
      }

      const beforeBottom = placeComments(commentsBeforeSelected, -commentSourceScrollTop);
      layout.set(selectedComment.id, selectedTop);
      placeComments(
        commentsAfterSelected,
        Math.max(beforeBottom, selectedTop + getEstimatedCommentCardHeight(selectedComment) + COMMENT_SIDEBAR_CARD_GAP)
      );
      return layout;
    }

    let nextAvailableTop = -commentSourceScrollTop;
    for (const comment of sortedComments) {
      const top = Math.max(getCommentSidebarDesiredTop(comment), nextAvailableTop);
      layout.set(comment.id, top);
      nextAvailableTop = top + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP;
    }
    return layout;
  }

  function getCommentSidebarHeight(comments: FileComment[], layout: Map<string, number>): number {
    const commentBottom = comments.reduce((height, comment) => {
      const top = layout.get(comment.id) ?? getCommentLineTop(comment);
      return Math.max(height, top + getEstimatedCommentCardHeight(comment) + COMMENT_SIDEBAR_CARD_GAP);
    }, 0);
    const draftBottom = commentAddRange ? ((commentAddRange.startLine - 1) * FILE_REVIEW_LINE_HEIGHT) + COMMENT_SIDEBAR_CARD_PADDING : 0;
    const fileBottom = Math.max(1, mdEditContent.split('\n').length) * FILE_REVIEW_LINE_HEIGHT + COMMENT_SIDEBAR_CARD_PADDING;
    return Math.max(commentBottom, draftBottom, fileBottom);
  }

  function openLineComment(commentsForLine: FileComment[]) {
    const nextComment = commentsForLine.find(c => c.id === selectedCommentId) || commentsForLine[0];
    if (!nextComment) return;
    setSelectedCommentId(nextComment.id);
    if (!commentSidebarOpen) setCommentSidebarOpen(true);
  }

  function openCommentIds(commentIds: string[]) {
    const comments = commentIds
      .map(id => fileComments.find(c => c.id === id))
      .filter((comment): comment is FileComment => Boolean(comment));
    openLineComment(comments);
  }

  function renderLineCommentMarker(lineNum: number, commentsForLine: FileComment[]) {
    if (commentsForLine.length === 0) return null;
    const selectedOnLine = commentsForLine.some(c => c.id === selectedCommentId);
    const markerComment = commentsForLine.find(c => c.authorType === 'agent') || commentsForLine[0];
    const markerColor = markerComment.authorType === 'agent' ? 'var(--comment-agent-color)' : 'var(--comment-user-color)';
    const label = `${commentsForLine.length} comment${commentsForLine.length === 1 ? '' : 's'} on line ${lineNum}`;
    return (
      <button
        type="button"
        className={`lineCommentMarker ${selectedOnLine ? 'selected' : ''}`}
        style={{ borderColor: markerColor, color: markerColor }}
        onClick={(e) => { e.stopPropagation(); openLineComment(commentsForLine); }}
        title={commentsForLine.map(c => c.content).join('\n')}
        aria-label={label}
      >
        💬{commentsForLine.length > 1 ? <span className="lineCommentCount">{commentsForLine.length}</span> : null}
      </button>
    );
  }

  function renderReviewFileLineText(line: string, lineNum: number, selectedComment: FileComment | undefined) {
    if (!selectedComment || selectedComment.rangeStartLine == null) return line || ' ';

    const startLine = selectedComment.rangeStartLine;
    const endLine = selectedComment.rangeEndLine ?? startLine;
    if (lineNum < startLine || lineNum > endLine) return line || ' ';

    const startChar = lineNum === startLine ? (selectedComment.rangeStartChar ?? 0) : 0;
    const endChar = lineNum === endLine ? (selectedComment.rangeEndChar ?? line.length) : line.length;
    const boundedStart = Math.max(0, Math.min(startChar, line.length));
    const boundedEnd = Math.max(boundedStart, Math.min(endChar, line.length));
    const before = line.slice(0, boundedStart);
    const selected = line.slice(boundedStart, boundedEnd) || ' ';
    const after = line.slice(boundedEnd);

    return (
      <>
        {before}
        <span className="fileLineSelectedText">{selected}</span>
        {after}
      </>
    );
  }

  function renderReviewFileLine(line: string, idx: number, commentsByLine: Map<number, FileComment[]>) {
    const lineNum = idx + 1;
    const commentsForLine = commentsByLine.get(lineNum) || [];
    const isHighlighted = commentsForLine.some(c => c.id === selectedCommentId);
    const selectedComment = commentsForLine.find(c => c.id === selectedCommentId);
    return (
      <div
        key={idx}
        className={`fileLine ${isHighlighted ? 'highlighted' : ''} ${commentsForLine.length > 0 && !isHighlighted ? 'has-comment' : ''}`}
        data-line-num={lineNum}
      >
        <span className="fileLineGutter">
          <span className="fileLineNum">{lineNum}</span>
        </span>
        <span className="fileLineText">{renderReviewFileLineText(line, lineNum, selectedComment)}</span>
        <span className="fileLineCommentSlot">
          {renderLineCommentMarker(lineNum, commentsForLine)}
        </span>
      </div>
    );
  }

  function handleCommentSourceScroll(source: HTMLDivElement | null) {
    if (!source) return;
    setCommentSourceScrollTop(source.scrollTop);
  }

  function handleFileContentScroll() {
    handleCommentSourceScroll(fileContentRef.current);
  }

  function handleLiveEditorScroll() {
    handleCommentSourceScroll(mdLiveContainerRef.current);
  }

  function handleTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !fileContentRef.current) return;

    const range = sel.getRangeAt(0);
    const container = fileContentRef.current;
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;

    const startLineEl = range.startContainer.parentElement?.closest('[data-line-num]');
    const endLineEl = range.endContainer.parentElement?.closest('[data-line-num]');
    if (!startLineEl || !endLineEl) return;

    const startLine = parseInt(startLineEl.getAttribute('data-line-num') || '0', 10);
    const endLine = parseInt(endLineEl.getAttribute('data-line-num') || '0', 10);
    if (startLine > 0 && endLine > 0) {
      setCommentAddRange({ startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) });
    }
  }

  function clearLiveSelectionDraft() {
    liveSelectionDraftRangeRef.current = null;
    liveSelectionDraftTextRef.current = null;
    setLiveSelectionDraftAnchor(null);
  }

  function hideLiveEditCommentButton() {
    pendingLiveEditCommentRangeRef.current = null;
    pendingLiveEditCommentAnchorRef.current = null;
    pendingLiveEditDomRangeRef.current = null;
    pendingLiveEditSelectedTextRef.current = null;
    const button = liveEditCommentBtnRef.current;
    if (!button) return;
    button.style.display = 'none';
  }

  function findLiveEditTextRange(selectedText: string): Range | null {
    if (!mdLiveRef.current) return null;
    const searchText = selectedText.trim();
    if (!searchText) return null;

    const walker = document.createTreeWalker(mdLiveRef.current, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      const index = text.indexOf(searchText);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + searchText.length);
        return range;
      }
    }
    return null;
  }

  function getCommentSourceText(comment: FileComment): string | null {
    if (comment.rangeStartLine == null) return null;

    const lines = mdEditContent.split('\n');
    const startIdx = comment.rangeStartLine - 1;
    const endIdx = (comment.rangeEndLine ?? comment.rangeStartLine) - 1;
    if (startIdx < 0 || endIdx < startIdx || startIdx >= lines.length) return null;

    if (comment.rangeStartChar != null && comment.rangeEndChar != null) {
      if (startIdx === endIdx) {
        return (lines[startIdx] || '').slice(comment.rangeStartChar, comment.rangeEndChar);
      }

      const selectedLines = lines.slice(startIdx, Math.min(endIdx + 1, lines.length));
      if (selectedLines.length === 0) return null;
      selectedLines[0] = selectedLines[0].slice(comment.rangeStartChar);
      selectedLines[selectedLines.length - 1] = selectedLines[selectedLines.length - 1].slice(0, comment.rangeEndChar);
      return selectedLines.join('\n');
    }

    return lines.slice(startIdx, Math.min(endIdx + 1, lines.length)).join('\n');
  }

  function getLiveEditRangeForComment(comment: FileComment): Range | null {
    const selectedText = getCommentSourceText(comment);
    if (!selectedText) return null;
    const renderedText = selectedText
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    const candidates = Array.from(new Set([selectedText.trim(), renderedText].filter(Boolean)));
    for (const candidate of candidates) {
      const range = findLiveEditTextRange(candidate);
      if (range) return range;
    }
    return null;
  }

  function getLiveSelectionDraftAnchor(range: Range): LiveSelectionDraftAnchor | null {
    const editor = mdLiveRef.current?.closest('.mdEditorLive');
    if (!(editor instanceof HTMLElement)) return null;

    const editorRect = editor.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => ({
        left: rect.left - editorRect.left + editor.scrollLeft,
        top: rect.top - editorRect.top + editor.scrollTop,
        width: rect.width,
        height: rect.height,
      }));

    return rects.length > 0 ? { rects } : null;
  }

  function getLiveCommentMarkersForEditor(): LiveCommentMarker[] {
    const editor = mdLiveRef.current?.closest('.mdEditorLive');
    if (!(editor instanceof HTMLElement)) return [];

    const editorRect = editor.getBoundingClientRect();
    const commentsByLine = getCommentsByLine();
    const markers: LiveCommentMarker[] = [];

    for (const [lineNum, commentsForLine] of commentsByLine) {
      const markerComment = commentsForLine.find(c => c.id === selectedCommentId) || commentsForLine[0];
      if (!markerComment) continue;

      const range = getLiveEditRangeForComment(markerComment);
      let top = getCommentLineTop(markerComment) + 1;
      if (range) {
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
        const rect = rects[0] || range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          top = Math.max(8, rect.top - editorRect.top + editor.scrollTop + rect.height / 2 - 9);
        }
      }

      const markerColor = (commentsForLine.find(c => c.authorType === 'agent') || markerComment).authorType === 'agent'
        ? 'var(--comment-agent-color)'
        : 'var(--comment-user-color)';
      markers.push({
        lineNum,
        commentIds: commentsForLine.map(c => c.id),
        top,
        left: Math.max(8, editor.scrollLeft + editor.clientWidth - 44),
        color: markerColor,
        selected: commentsForLine.some(c => c.id === selectedCommentId),
        label: `${commentsForLine.length} comment${commentsForLine.length === 1 ? '' : 's'} on line ${lineNum}`,
        title: commentsForLine.map(c => c.content).join('\n'),
        count: commentsForLine.length,
      });
    }

    return markers;
  }

  function positionLiveEditCommentButton(range: Range) {
    const button = liveEditCommentBtnRef.current;
    const editor = mdLiveRef.current?.closest('.mdEditorLive');
    if (!button || !(editor instanceof HTMLElement)) return;

    const rectList = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    const rect = rectList[rectList.length - 1] || range.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const top = Math.max(8, rect.bottom - editorRect.top + editor.scrollTop + 6);
    const left = Math.max(
      8,
      Math.min(rect.right - editorRect.left + editor.scrollLeft + 8, editor.clientWidth - button.offsetWidth - 8)
    );

    button.style.display = 'inline-flex';
    button.style.top = `${top}px`;
    button.style.left = `${left}px`;
    button.style.right = 'auto';
  }

  function handleLiveEditSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !mdLiveRef.current) {
      hideLiveEditCommentButton();
      return;
    }

    const range = sel.getRangeAt(0);
    if (!mdLiveRef.current.contains(range.startContainer) || !mdLiveRef.current.contains(range.endContainer)) {
      hideLiveEditCommentButton();
      return;
    }

    const selectedText = sel.toString().trim();
    if (!selectedText) {
      hideLiveEditCommentButton();
      return;
    }

    // Find the selected text in source markdown to determine line range
    const lines = mdEditContent.split('\n');
    const normalizeSelectionText = (text: string) => text.replace(/\s+/g, ' ').toLowerCase();
    const searchNorm = normalizeSelectionText(selectedText);
    let startLine = -1;
    let endLine = -1;
    let startChar: number | undefined;
    let endChar: number | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;

    for (let i = 0; i < lines.length; i++) {
      for (let j = i; j < lines.length; j++) {
        const chunk = normalizeSelectionText(lines.slice(i, j + 1).join(' '));
        if (chunk.includes(searchNorm)) {
          const span = j - i;
          const rawIndex = i === j ? lines[i].toLowerCase().indexOf(selectedText.toLowerCase()) : -1;
          if (span < bestSpan) {
            startLine = i + 1;
            endLine = j + 1;
            startChar = rawIndex >= 0 ? rawIndex : undefined;
            endChar = rawIndex >= 0 ? rawIndex + selectedText.length : undefined;
            bestSpan = span;
          }
          break;
        }
      }
    }

    if (startLine > 0 && endLine > 0) {
      pendingLiveEditCommentRangeRef.current = { startLine, endLine, startChar, endChar };
      pendingLiveEditCommentAnchorRef.current = getLiveSelectionDraftAnchor(range);
      pendingLiveEditDomRangeRef.current = range.cloneRange();
      pendingLiveEditSelectedTextRef.current = selectedText;
      positionLiveEditCommentButton(range);
    } else {
      hideLiveEditCommentButton();
    }
  }

  const liveEditSelectionRef = useRef(handleLiveEditSelection);
  liveEditSelectionRef.current = handleLiveEditSelection;

  // Debounced selectionchange listener — avoids re-renders during double/triple-click
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => liveEditSelectionRef.current(), 150);
    };
    document.addEventListener('selectionchange', handler);
    return () => {
      document.removeEventListener('selectionchange', handler);
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  useEffect(() => {
    if (mdEditorMode !== 'live' || !mdSelectedFile || !isMarkdownFile(mdSelectedFile)) {
      setLiveCommentMarkers([]);
      return;
    }

    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      setLiveCommentMarkers(getLiveCommentMarkersForEditor());
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [fileComments, mdEditorMode, mdSelectedFile, mdEditContent, mdLiveHtml, selectedCommentId, commentSidebarOpen]);

  useEffect(() => {
    if (!showCommentInput || !liveSelectionDraftRangeRef.current) return;

    let outerFrameId = 0;
    let innerFrameId = 0;
    outerFrameId = window.requestAnimationFrame(() => {
      innerFrameId = window.requestAnimationFrame(() => {
        const range = liveSelectionDraftRangeRef.current;
        const rebuiltRange = liveSelectionDraftTextRef.current ? findLiveEditTextRange(liveSelectionDraftTextRef.current) : null;
        const activeRange = rebuiltRange || range;
        if (!activeRange || !mdLiveRef.current) return;
        if (!mdLiveRef.current.contains(activeRange.startContainer) || !mdLiveRef.current.contains(activeRange.endContainer)) return;

        liveSelectionDraftRangeRef.current = activeRange.cloneRange();
        const anchor = getLiveSelectionDraftAnchor(activeRange);
        if (anchor) setLiveSelectionDraftAnchor(anchor);
      });
    });

    return () => {
      window.cancelAnimationFrame(outerFrameId);
      window.cancelAnimationFrame(innerFrameId);
    };
  }, [showCommentInput, commentSidebarOpen]);

  useEffect(() => {
    if (showCommentInput) return;

    if (!selectedCommentId || mdEditorMode !== 'live' || !mdSelectedFile || !isMarkdownFile(mdSelectedFile)) {
      clearLiveSelectionDraft();
      return;
    }

    const comment = fileComments.find(c => c.id === selectedCommentId);
    if (!comment) {
      clearLiveSelectionDraft();
      return;
    }

    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      const range = getLiveEditRangeForComment(comment);
      if (!range) {
        clearLiveSelectionDraft();
        return;
      }

      liveSelectionDraftRangeRef.current = range.cloneRange();
      liveSelectionDraftTextRef.current = range.toString();
      const anchor = getLiveSelectionDraftAnchor(range);
      if (anchor) setLiveSelectionDraftAnchor(anchor);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [selectedCommentId, fileComments, mdEditorMode, mdSelectedFile, mdEditContent, showCommentInput]);

  function extractFileComments(text: string, agentId: string): { cleanText: string; comments: { filePath: string; rangeStartLine?: number; rangeEndLine?: number; content: string }[] } {
    const commentBlockRegex = /```json:file-comments\s*\n([\s\S]*?)```/g;
    const comments: { filePath: string; rangeStartLine?: number; rangeEndLine?: number; content: string }[] = [];
    let cleanText = text;

    let match;
    while ((match = commentBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.filePath && item.content) {
              comments.push({
                filePath: item.filePath,
                rangeStartLine: item.rangeStartLine,
                rangeEndLine: item.rangeEndLine,
                content: item.content,
              });
            }
          }
        }
      } catch { /* invalid JSON, skip */ }
      cleanText = cleanText.replace(match[0], '').trim();
    }

    return { cleanText, comments };
  }

  async function saveAgentComments(agentId: string, comments: { filePath: string; rangeStartLine?: number; rangeEndLine?: number; content: string }[], agentName?: string) {
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
  }

  // Sync live editor HTML back to markdown
  function syncLiveToMarkdown(): string {
    if (mdEditorMode === 'live' && mdLiveRef.current) {
      const html = mdLiveRef.current.innerHTML;
      const md = turndownRef.current!.turndown(html);
      setMdLiveHtml(html);
      setMdEditContent(md);
      setMdDirty(md !== mdFileContent);
      return md;
    }
    return mdEditContent;
  }

  function switchLeftSidebarTab(tab: LeftSidebarTab) {
    if (tab !== 'files') syncLiveToMarkdown();
    setLeftSidebarTab(tab);
  }

  async function saveMdFile(contentOverride?: string, mtimeOverride?: string | null) {
    if (!mdSelectedAgentId || !mdSelectedFile) return;
    const content = contentOverride ?? syncLiveToMarkdown();
    const mtimeToSave = mtimeOverride !== undefined ? mtimeOverride : mdFileMtime;
    setMdSaving(true);
    try {
      const res = await fetch('/api/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: mdSelectedAgentId,
          path: mdSelectedFile,
          content,
          mtime: mtimeToSave,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setMdFileContent(content);
        setMdEditContent(content);
        setMdFileMtime(data.mtime || null);
        setMdDirty(false);
        setMdConflict(null);
        setMdConflictResolvedContent('');
        if (mdSelectedFile && isMarkdownFile(mdSelectedFile)) setMdLiveHtml(markdownToHtml(content));
        else setMdLiveHtml('');
        // Refresh file list to update mtimes
        loadMdFiles(mdSelectedAgentId, mdDiffOnly);
      } else if (data.error === 'conflict') {
        const serverContent = typeof data.serverContent === 'string' ? data.serverContent : mdFileContent;
        const serverMtime = typeof data.serverMtime === 'string' ? data.serverMtime : null;
        setMdConflict({
          path: mdSelectedFile,
          baseContent: mdFileContent,
          mineContent: content,
          serverContent,
          serverMtime,
          mode: 'choice',
        });
        setMdConflictResolvedContent(content);
      } else {
        alert(`Save failed: ${data.error || 'unknown error'}`);
      }
    } catch (err) {
      console.error('Failed to save markdown file', err);
      alert('Save failed — see console for details.');
    } finally {
      setMdSaving(false);
    }
  }

  function applyMdContent(content: string, mtime: string | null, dirty: boolean) {
    setMdFileContent(content);
    setMdEditContent(content);
    setMdFileMtime(mtime);
    setMdDirty(dirty);
    if (mdSelectedFile && isMarkdownFile(mdSelectedFile)) setMdLiveHtml(markdownToHtml(content));
    else setMdLiveHtml('');
  }

  function resolveMdConflictByReload() {
    if (!mdConflict) return;
    applyMdContent(mdConflict.serverContent, mdConflict.serverMtime, false);
    setMdConflict(null);
    setMdConflictResolvedContent('');
    if (mdSelectedAgentId) loadMdFiles(mdSelectedAgentId, mdDiffOnly);
  }

  function beginManualMdConflictResolution() {
    if (!mdConflict) return;
    setMdConflictResolvedContent(mdConflict.mineContent);
    setMdConflict({ ...mdConflict, mode: 'manual' });
  }

  function keepServerVersion() {
    if (!mdConflict) return;
    setMdConflictResolvedContent(mdConflict.serverContent);
  }

  function keepMineVersion() {
    if (!mdConflict) return;
    setMdConflictResolvedContent(mdConflict.mineContent);
  }

  async function handleSaveManualMdConflict() {
    if (!mdConflict) return;
    setMdEditContent(mdConflictResolvedContent);
    setMdDirty(mdConflictResolvedContent !== mdFileContent);
    await saveMdFile(mdConflictResolvedContent, mdConflict.serverMtime);
  }

  function closeMdEditor() {
    setMdEditorOpen(false);
    setMdSelectedFile(null);
    setMdFileContent('');
    setMdEditContent('');
    setMdFileMtime(null);
    setMdDirty(false);
    setMdLiveHtml('');
    setMdConflict(null);
    setMdConflictResolvedContent('');
    clearLiveSelectionDraft();
  }

  async function handleAddNode() {
    if (!newNodeForm.name.trim()) return;
    setAddNodeLoading(true);
    try {
      const res = await nodesApi({ action: 'add-node', name: newNodeForm.name.trim(), label: newNodeForm.label.trim() || newNodeForm.name.trim() });
      if (res.ok) {
        setShowAddNode(false);
        setNewNodeForm({ name: '', label: '' });
        loadNodes();
      }
    } catch (err) {
      console.error('Failed to add node', err);
    } finally {
      setAddNodeLoading(false);
    }
  }

  async function handleRemoveNode(name: string) {
    try {
      const res = await nodesApi({ action: 'remove-node', name });
      if (res.ok) loadNodes();
    } catch (err) {
      console.error('Failed to remove node', err);
    }
  }

  async function handleRefreshNode(name: string) {
    try {
      const res = await nodesApi({ action: 'check-node', name });
      if (res.ok) {
        setNodesData(prev => prev.map(n => n.name === name ? { ...n, online: res.online, checkedAt: res.checkedAt } : n));
      }
    } catch (err) {
      console.error('Failed to check node', err);
    }
  }

  async function handleRenameNode(name: string, newLabel: string) {
    try {
      const res = await nodesApi({ action: 'update-node', name, label: newLabel });
      if (res.ok) {
        setNodesData(prev => prev.map(n => n.name === name ? { ...n, label: newLabel } : n));
      }
    } catch (err) {
      console.error('Failed to rename node', err);
    }
  }

  function downloadSetupZip() {
    const a = document.createElement('a');
    a.href = '/api/nodes/setup';
    a.download = 'copilot-node-setup.zip';
    a.click();
  }

  /* ── ACP Send & Poll ── */

  async function respondToAgentUserRequest(agentId: string, request: AgentUserRequest, response: AgentUserRequestResponse) {
    const res = await acp({
      action: 'respond-user-request',
      agentId,
      chatId: currentChatIdRef.current,
      requestId: request.id,
      ...response,
    });
    if (!res?.ok) {
      throw new Error(res?.error || 'Failed to answer agent request');
    }
  }

  function setAgentUserRequestSubmission(requestId: string, submission: AgentUserRequestSubmission | null) {
    const next = { ...agentUserRequestSubmissionsRef.current };
    if (submission) {
      next[requestId] = submission;
    } else {
      delete next[requestId];
    }
    agentUserRequestSubmissionsRef.current = next;
    setAgentUserRequestSubmissions(next);
  }

  function clearAgentUserRequestSubmissionForMessage(messageId: string, chatId = currentChatIdRef.current) {
    const chatMessages = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    const requestId = chatMessages.find((message) => message.id === messageId)?.userRequest?.id;
    if (requestId) setAgentUserRequestSubmission(requestId, null);
  }

  function isChatRunning(chatId: string) {
    return Object.values(sessionRunsRef.current).some((run) => run.chatId === chatId);
  }

  async function submitAgentUserRequest(message: ChatMessage, response: AgentUserRequestResponse) {
    const request = message.userRequest;
    const agentId = message.agentId;
    if (!request || !agentId) return;
    if (agentUserRequestSubmissionsRef.current[request.id]?.pending) return;

    setAgentUserRequestSubmission(request.id, { pending: true });
    try {
      await respondToAgentUserRequest(agentId, request, response);
    } catch (err) {
      console.error('Failed to answer agent request', err);
      setAgentUserRequestSubmission(request.id, { pending: false, error: err instanceof Error ? err.message : 'Failed to answer agent request' });
    }
  }

  async function sendAcpPrompt(runKey: string, agentId: string, pendingId: string, content: string, promptAttachments: ChatAttachment[] = []) {
    const run = sessionRunsRef.current[runKey];
    if (!run || run.ptySendStarted) return false;

    run.ptySendStarted = true;
    updateMessage(pendingId, { statusText: 'Connecting', pending: true, ptyPhase: 'loading-environment' }, run.chatId);

    // Capture the chat that owns this run. Polling and send failures must keep
    // using this chat even if the user switches chats while the turn is active.
    const sendChatId = run.chatId;
    const sendBody: Record<string, unknown> = { action: 'send', agentId, text: content, chatId: sendChatId, messageId: pendingId };
    if (promptAttachments.length > 0) sendBody.attachments = promptAttachments;
    if (needsContextRestoreRef.current) {
      const historyMessages = chatMessagesRef.current[sendChatId] || (sendChatId === currentChatIdRef.current ? messagesRef.current : []);
      sendBody.chatHistory = historyMessages
        .filter(m => m.type === 'user' || m.type === 'agent')
        .slice(-20)
        .map(m => ({ type: m.type, content: m.content, agentId: (m as any).agentId }));
      needsContextRestoreRef.current = false;
    }
    const sendResult = await acp(sendBody);
    const current = sessionRunsRef.current[runKey];
    if (!current) return false;

    // Handle send failures (e.g. turn_in_progress, session errors)
    if (sendResult && !sendResult.ok) {
      throw new PromptSendFailedError(sendResult.error || 'Failed to send prompt to agent');
    }

    if (sendResult?.sessionId) {
      currentAgentSessionsRef.current = { ...currentAgentSessionsRef.current, [agentId]: sendResult.sessionId };
    }

    current.ptyTurnId = sendResult?.turn?.id;

    if (sendResult?.phase === 'booting') {
      updateMessage(pendingId, { statusText: 'Starting environment', ptyPhase: 'loading-environment', pending: true }, sendChatId);
    }

    void pollAcpAgent(agentId, sendChatId);
    return true;
  }

  async function dispatchToAgent(
    agentId: string,
    content: string,
    orchestrationId: string,
    kind: 'worker' | 'summary' = 'worker',
    options?: DispatchToAgentOptions,
  ) {
    const dispatchChatId = options?.chatId || currentChatIdRef.current;
    const pendingId = `pending-${makeId()}`;
    const runKey = `acp:${agentId}:${dispatchChatId}`;
    if (sessionRunsRef.current[runKey]) {
      throw new PromptSendFailedError('Agent is already running in this chat');
    }

    addMessage({
      id: pendingId,
      type: 'agent',
      content: '',
      agentId,
      pending: true,
      round: options?.round,
      relation: options?.relation,
      summary: options?.summary,
    }, dispatchChatId);

    sessionRunsRef.current[runKey] = {
      agentId, pendingId, orchestrationId, kind,
      currentText: '',
      chatId: dispatchChatId,
      commentId: options?.commentId,
      round: options?.round,
      relation: options?.relation,
    };
    notifyRunStateChanged();

    try {
      const sent = await sendAcpPrompt(runKey, agentId, pendingId, content, options?.attachments || []);
      if (!sent) throw new Error('Failed to send prompt to agent');
      return runKey;
    } catch (err) {
      removeMessage(pendingId, dispatchChatId);
      delete sessionRunsRef.current[runKey];
      notifyRunStateChanged();
      throw err;
    }
  }

  function isSendFailureMessage(message: ChatMessage): boolean {
    if (message.type !== 'agent' && message.type !== 'system') return false;
    const text = message.content.trim();
    if (message.type === 'system') {
      return /^(?:⚠️\s*)?Send failed:/i.test(text);
    }
    return text.startsWith('⚠️') && (
      text.includes('Failed to send prompt to agent') ||
      text.includes('Send failed')
    );
  }

  function markUserMessageSendFailed(
    chatId: string,
    userMessageId: string,
    error: string,
    resendAgentIds: string[],
    resendMessage: string,
    resendAttachments?: ChatAttachment[],
  ) {
    updateMessage(userMessageId, {
      sendStatus: 'failed',
      sendError: error || 'Failed to send prompt to agent',
      resendAgentIds,
      resendMessage,
      attachments: resendAttachments,
    }, chatId);
    void saveChatToHistory(chatId);
  }

  function clearUserMessageSendFailure(chatId: string, userMessageId: string) {
    updateMessage(userMessageId, {
      sendStatus: undefined,
      sendError: undefined,
      resendAgentIds: undefined,
      resendMessage: undefined,
    }, chatId);
    void saveChatToHistory(chatId);
  }

  function resumeActiveTurn(agentId: string, turn: { messageId?: string; fullText?: string; phase?: string; statusText?: string; userRequest?: AgentUserRequest }) {
    const resumeChatId = currentChatIdRef.current;
    const pendingId = turn.messageId || `pending-${makeId()}`;
    const existing = (chatMessagesRef.current[resumeChatId] || messagesRef.current).find(m => m.id === pendingId);
    const statusText = turn.statusText || existing?.statusText || 'Thinking';
    const ptyPhase = mapTurnPhase(turn.phase || existing?.ptyPhase || 'thinking');
    const userRequest = turn.userRequest || existing?.userRequest;
    if (existing) {
      updateMessage(pendingId, { pending: true, agentId, content: turn.fullText || existing.content || '', statusText, ptyPhase, userRequest }, resumeChatId);
    } else {
      addMessage({ id: pendingId, type: 'agent', content: turn.fullText || '', agentId, pending: true, statusText, ptyPhase, userRequest }, resumeChatId);
    }

    const runKey = `acp:${agentId}:${resumeChatId}`;
    if (!sessionRunsRef.current[runKey]) {
      sessionRunsRef.current[runKey] = {
        agentId,
        pendingId,
        orchestrationId: `orch-${makeId()}`,
        kind: 'worker',
        currentText: turn.fullText || '',
        chatId: resumeChatId,
      };
      notifyRunStateChanged();
      void pollAcpAgent(agentId, resumeChatId);
    }
  }

  function finalizeRun(runKey: string) {
    const run = sessionRunsRef.current[runKey];
    if (!run) return;

    updateMessage(run.pendingId, { pending: false, statusText: undefined, ptyPhase: undefined }, run.chatId);
    const orchestration = orchestrationsRef.current[run.orchestrationId];
    if (orchestration && run.kind === 'worker') {
      orchestration.results[run.agentId] = run.currentText || '';
    }
    delete sessionRunsRef.current[runKey];
    notifyRunStateChanged();
    if (orchestration && run.kind === 'worker') {
      void maybeAdvanceOrchestration(run.orchestrationId);
    }
  }

  async function pollAcpAgent(agentId: string, chatId?: string) {
    const effectiveChatId = chatId || currentChatIdRef.current;
    const runKey = `acp:${agentId}:${effectiveChatId}`;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 10;
    const POLL_TIMEOUT = 10 * 60_000; // 10 min safety timeout
    let lastProgressAt = Date.now();
    let lastProgressSignature = '';

    while (sessionRunsRef.current[runKey]) {
      const current = sessionRunsRef.current[runKey];
      if (!current) break;

      // Safety timeout — don't poll forever when successful polls make no progress.
      if (Date.now() - lastProgressAt > POLL_TIMEOUT) {
        clearAgentUserRequestSubmissionForMessage(current.pendingId, effectiveChatId);
        updateMessage(current.pendingId, {
          content: current.currentText || '⚠️ Response timed out',
          pending: false,
          userRequest: undefined,
        }, effectiveChatId);
        finalizeRun(runKey);
        return;
      }

      let result: any;
      try {
        result = await acp({ action: 'poll', agentId, chatId: effectiveChatId });
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          clearAgentUserRequestSubmissionForMessage(current.pendingId, effectiveChatId);
          updateMessage(current.pendingId, {
            content: current.currentText || `⚠️ Lost connection to agent (${err instanceof Error ? err.message : 'network error'})`,
            pending: false,
            userRequest: undefined,
          }, effectiveChatId);
          finalizeRun(runKey);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * consecutiveErrors));
        continue;
      }
      consecutiveErrors = 0;

      const turn = result?.activeTurn as {
        fullText?: string;
        done?: boolean;
        phase?: string;
        statusText?: string;
        error?: string;
        userRequest?: AgentUserRequest;
        events?: { type: string; ts: number; toolName?: string; toolCallId?: string; toolArgs?: string; toolResult?: string; text?: string }[];
      } | null;

      if (turn) {
        const progressSignature = getAcpTurnProgressSignature(turn);
        if (progressSignature !== lastProgressSignature) {
          lastProgressSignature = progressSignature;
          lastProgressAt = Date.now();
        }

        const ptyPhase = mapTurnPhase(turn.phase || '');
        const phaseStatusMap: Record<string, string> = {
          thinking: 'Thinking',
          tool_exec: 'Executing tool',
          replying: 'Generating response',
          booting: 'Starting environment',
        };
        const statusText = turn.statusText || phaseStatusMap[turn.phase || ''] || '';

        // Build content parts from events in chronological order
        const parts: ContentPart[] = [];
        const toolMap = new Map<string, ContentPart & { kind: 'tool' }>();
        if (turn.events) {
          for (const evt of turn.events) {
            if (evt.type === 'thinking' && evt.text) {
              const last = parts[parts.length - 1];
              if (last && last.kind === 'thinking') {
                last.text += evt.text;
              } else {
                parts.push({ kind: 'thinking', text: evt.text });
              }
            } else if (evt.type === 'tool_start' && evt.toolName) {
              const tp: ContentPart & { kind: 'tool' } = { kind: 'tool', toolName: evt.toolName, args: evt.toolArgs, done: false };
              if (evt.toolCallId) toolMap.set(evt.toolCallId, tp);
              parts.push(tp);
            } else if (evt.type === 'tool_complete') {
              const existing = evt.toolCallId ? toolMap.get(evt.toolCallId) : null;
              if (existing) {
                existing.result = evt.toolResult;
                existing.done = true;
              } else {
                parts.push({ kind: 'tool', toolName: evt.toolName || 'tool', result: evt.toolResult, done: true });
              }
            } else if (evt.type === 'user_response' && evt.text) {
              parts.push({ kind: 'user_answer', text: evt.text });
            } else if (evt.type === 'text_chunk' && evt.text) {
              const last = parts[parts.length - 1];
              if (last && last.kind === 'text') {
                last.text += evt.text;
              } else {
                parts.push({ kind: 'text', text: evt.text });
              }
            }
          }
        }

        const serverText = (turn.fullText || '').trim();
        const effectiveStatus = statusText || '';

        if (turn.done) {
          current.currentText = serverText;
          // Extract and save agent comments
          const { cleanText: textWithoutComments, comments: agentComments } = extractFileComments(serverText, agentId);
          if (agentComments.length > 0) {
            const agentName = agents.find(a => a.id === agentId)?.name;
            void saveAgentComments(agentId, agentComments, agentName);
            current.currentText = textWithoutComments;
          }
          const finalContent = current.currentText || (turn.error ? `⚠️ ${turn.error}` : '');
          updateMessage(current.pendingId, {
            content: finalContent,
            pending: false,
            parts: finalContent && !current.currentText ? undefined : (parts.length ? parts : undefined),
            userRequest: undefined,
          }, effectiveChatId);
          await acp({ action: 'turn-clear', agentId, chatId: effectiveChatId }).catch(() => null);
          const completedCommentId = current.commentId;
          finalizeRun(runKey);
          if (effectiveChatId) {
            const fallbackCommentId = fileCommentsRef.current.find(c => c.linkedChatId === effectiveChatId && c.status === 'processing')?.id;
            const commentIdToResolve = completedCommentId || fallbackCommentId;
            if (commentIdToResolve) void resolveProcessingCommentForChat(effectiveChatId, commentIdToResolve);
          }
          return;
        } else {
          const patch: Partial<ChatMessage> = {
            pending: true,
            ptyPhase: mapTurnPhase(turn.phase || ''),
            statusText: effectiveStatus,
            parts: parts.length ? parts : undefined,
            userRequest: turn.userRequest,
          };
          if (serverText) {
            patch.content = serverText;
            current.currentText = serverText;
          }
          updateMessage(current.pendingId, patch, effectiveChatId);
        }
      }

      await new Promise((r) => setTimeout(r, 800));
    }
  }

  /* ── Orchestration ── */

  function markOrchestrationPromptSendFailed(orchestrationId: string, err: unknown) {
    if (!(err instanceof PromptSendFailedError)) return false;
    const state = orchestrationsRef.current[orchestrationId];
    if (!state?.sourceChatId || !state.sourceUserMessageId) return false;

    markUserMessageSendFailed(
      state.sourceChatId,
      state.sourceUserMessageId,
      err.message,
      state.sourceAgentIds?.length ? state.sourceAgentIds : state.agentIds,
      state.sourceMessage || state.originalTask,
      state.sourceAttachments,
    );
    delete orchestrationsRef.current[orchestrationId];
    return true;
  }

  async function dispatchOrchestrationStep(
    orchestrationId: string,
    agentId: string,
    prompt: string,
    kind: 'worker' | 'summary',
    options?: DispatchToAgentOptions,
  ) {
    try {
      await dispatchToAgent(agentId, prompt, orchestrationId, kind, options);
      return true;
    } catch (err) {
      if (markOrchestrationPromptSendFailed(orchestrationId, err)) return false;
      throw err;
    }
  }

  async function cleanupDispatchedRuns(runKeys: string[]) {
    await Promise.all(runKeys.map(async (runKey) => {
      const run = sessionRunsRef.current[runKey];
      if (!run) return;
      clearAgentUserRequestSubmissionForMessage(run.pendingId, run.chatId);
      try {
        await acp({ action: 'interrupt', agentId: run.agentId, chatId: run.chatId });
      } catch { /* ignore */ }
      removeMessage(run.pendingId, run.chatId);
      delete sessionRunsRef.current[runKey];
    }));
    notifyRunStateChanged();
  }

  async function maybeAdvanceOrchestration(orchestrationId: string) {
    const state = orchestrationsRef.current[orchestrationId];
    if (!state || state.summaryStarted) return;
    const orchestrationChatId = state.sourceChatId || currentChatIdRef.current;

    if (state.mode === 'discussion') {
      const allDone = state.agentIds.every((id) => typeof state.results[id] === 'string');
      if (!allDone) return;

      if (state.round < state.maxRounds) {
        const prev = { ...state.results };
        state.results = {};
        state.round += 1;
        await Promise.all(state.agentIds.map((id) => {
          const others = state.agentIds.filter((x) => x !== id)
            .map((x) => `## ${x}'s perspective\n${prev[x] || '(no result)'}`).join('\n\n');
          const prompt = [
            `You are in round ${state.round} of a multi-agent discussion.`,
            `Original task: ${state.originalTask}`, '',
            `Below are other agents' perspectives from the previous round. Please respond:`,
            '1. State which points you agree with and from whom',
            '2. State which points you disagree with or want to revise',
            '3. Provide your updated perspective for this round', '', others,
          ].join('\n');
          return dispatchOrchestrationStep(orchestrationId, id, prompt, 'worker', {
            chatId: orchestrationChatId,
            round: state.round, relation: `Responding to round ${state.round - 1} perspectives`,
          });
        }));
        return;
      }

      state.summaryStarted = true;
      const summaryPrompt = [
        'You are the final coordinator. Please summarize the conclusions from this multi-agent discussion.',
        `Original task: ${state.originalTask}`, `Total rounds: ${state.maxRounds}`, '',
        ...state.agentIds.map((id) => `## ${id}\n${state.results[id] || '(no result)'}`), '',
        'Please output:', '1. Consensus reached', '2. Remaining disagreements', '3. Final recommended plan',
      ].join('\n');
      const summaryAgent = state.agentIds[0] || 'main';
      await dispatchOrchestrationStep(orchestrationId, summaryAgent, summaryPrompt, 'summary', { chatId: orchestrationChatId, relation: 'Final conclusion', summary: true });
      return;
    }

    if (state.mode === 'pipeline') {
      if (state.nextIndex < state.agentIds.length) {
        const prevId = state.agentIds[state.nextIndex - 1];
        const nextId = state.agentIds[state.nextIndex];
        const context = state.agentIds.slice(0, state.nextIndex)
          .map((id) => `## ${id}\n${state.results[id] || '(no result)'}`).join('\n\n');
        const prompt = [
          'You are participating in a multi-agent pipeline task.',
          `Original task: ${state.originalTask}`,
          prevId ? 'Please continue based on the previous agent output.' : 'Please provide your initial result.',
          context ? `\nExisting context:\n${context}` : '',
        ].filter(Boolean).join('\n');
        state.nextIndex += 1;
        await dispatchOrchestrationStep(orchestrationId, nextId, prompt, 'worker', {
          chatId: orchestrationChatId,
          round: state.nextIndex + 1, relation: prevId ? `Based on ${prevId}'s output` : 'Pipeline initial step',
        });
        return;
      }

      state.summaryStarted = true;
      const summaryPrompt = [
        'You are the final coordinator. Please summarize the results of this serial multi-agent pipeline.',
        `Original task: ${state.originalTask}`, '',
        ...state.agentIds.map((id) => `## ${id}\n${state.results[id] || '(no result)'}`), '',
        'Please output the final conclusion and next steps.',
      ].join('\n');
      const summaryAgent = state.agentIds[0] || 'main';
      await dispatchOrchestrationStep(orchestrationId, summaryAgent, summaryPrompt, 'summary', { chatId: orchestrationChatId, relation: 'Final conclusion', summary: true });
    }

    if (state.mode === 'auto') {
      const ext = state as Record<string, unknown>;
      const phase = ext.autoPhase as string;
      console.log('[Auto] maybeAdvance called, phase:', phase, 'results:', Object.keys(state.results));
      const autoStep = (ext.autoStep as number) || 0;
      const schedulerAgentId = SCHEDULER_AGENT_ID;
      const agentList = (ext.autoAgentList as string) || '';
      const autoOriginalText = (ext.autoOriginalText as string) || state.originalTask;
      const autoHistory = (ext.autoHistory as { agent: string; instruction: string; step: number }[]) || [];
      const promptAttachments = (ext.promptAttachments as ChatAttachment[]) || [];
      const dispatchedAttachmentAgents = (ext.dispatchedAttachmentAgents as string[]) || [];
      const dispatchedAttachmentAgentSet = new Set(dispatchedAttachmentAgents);

      // Helper: clear previous turn and wait before next dispatch
      const prepareNextDispatch = async (agentId: string) => {
        await acp({ action: 'turn-clear', agentId, chatId: orchestrationChatId }).catch(() => null);
        await new Promise((r) => setTimeout(r, 800));
      };

      try {
        if (phase === 'awaiting-plan' || phase === 'awaiting-eval') {
          // Parse JSON from last scheduler response (greedy to handle nested braces)
          const lastResult = Object.values(state.results).pop() || '';
          let decision: { done?: boolean; nextAgent?: string; instruction?: string; summary?: string } = { done: true };
          try {
            const jsonMatch = lastResult.match(/\{[\s\S]*\}/);
            if (jsonMatch) decision = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.warn('[Auto] Failed to parse scheduler JSON:', e, '\nRaw:', lastResult.slice(0, 500));
          }
          console.log('[Auto]', phase, 'decision:', JSON.stringify(decision), 'results keys:', Object.keys(state.results));

          if (decision.done || !decision.nextAgent || autoStep >= AUTO_MAX_STEPS) {
            // Done — generate summary
            ext.autoPhase = 'done';
            state.summaryStarted = true;
            const summaryPrompt = [
              'You are the final coordinator. Summarize the results of this auto-scheduled multi-agent task.',
              `Original task: ${state.originalTask}`, '',
              ...autoHistory.map((h, i) => `## Step ${i + 1} — ${h.agent}\n${state.results[h.agent] || '(no result)'}`), '',
              decision.summary ? `\nScheduler conclusion: ${decision.summary}` : '',
              '\nPlease output:', '1. What was accomplished', '2. Final result', '3. Any remaining issues or next steps',
            ].join('\n');
            await prepareNextDispatch(schedulerAgentId);
            await dispatchOrchestrationStep(orchestrationId, schedulerAgentId, summaryPrompt, 'summary', { chatId: orchestrationChatId, relation: 'Auto: final summary', summary: true });
            return;
          }

          // Dispatch to the chosen agent
          ext.autoStep = autoStep + 1;
          ext.autoPhase = 'awaiting-execution';
          ext.autoCurrentTarget = decision.nextAgent;
          autoHistory.push({ agent: decision.nextAgent, instruction: decision.instruction || state.originalTask, step: autoStep + 1 });
          state.results = {};
          await prepareNextDispatch(decision.nextAgent);
          const workerAttachments = dispatchedAttachmentAgentSet.has(decision.nextAgent) ? [] : promptAttachments;
          dispatchedAttachmentAgentSet.add(decision.nextAgent);
          ext.dispatchedAttachmentAgents = Array.from(dispatchedAttachmentAgentSet);
          await dispatchOrchestrationStep(orchestrationId, decision.nextAgent, decision.instruction || state.originalTask, 'worker', {
            chatId: orchestrationChatId,
            round: autoStep + 1,
            relation: `Auto: step ${autoStep + 1}`,
            attachments: workerAttachments,
          });
          return;
        }

        if (phase === 'awaiting-execution') {
          // Worker finished — ask scheduler to evaluate
          const targetAgent = ext.autoCurrentTarget as string;
          const agentResult = state.results[targetAgent] || '(no response)';

          ext.autoPhase = 'awaiting-eval';
          state.results = {};
          const evalPrompt = [
            'You are a ROUTING-ONLY scheduler evaluating a step result. Your ONLY job is to decide next action and output JSON.',
            'DO NOT use any tools. DO NOT read files. DO NOT run commands. Just evaluate and decide.',
            'Respect explicit agent mentions, role assignments, and ordering in the original user message.',
            'If the user assigned separate agents to testing/review and coding/fixing, keep those responsibilities separate.',
            `\nOriginal task: ${state.originalTask}`,
            `\nOriginal user message with agent mentions: ${autoOriginalText}`,
            `\nAvailable agents:\n${agentList}`,
            `\nStep ${autoStep} — Agent "${targetAgent}" responded:\n${agentResult}`,
            autoHistory.length > 1 ? `\nPrior steps:\n${autoHistory.slice(0, -1).map((h) => `Step ${h.step} (${h.agent}): ${h.instruction}`).join('\n')}` : '',
            `\nSteps remaining: ${AUTO_MAX_STEPS - autoStep}`,
            '\nRespond with ONLY a raw JSON object — no markdown fences, no explanation, no tool calls:',
            'The nextAgent value must be one of the available mentioned agents above.',
            '- If done: { "done": true, "summary": "<brief conclusion>" }',
            '- If another agent should act: { "done": false, "nextAgent": "<agent-id>", "instruction": "<what to tell the next agent, include relevant context>" }',
          ].join('\n');
          await prepareNextDispatch(schedulerAgentId);
          await dispatchOrchestrationStep(orchestrationId, schedulerAgentId, evalPrompt, 'worker', {
            chatId: orchestrationChatId,
            round: autoStep,
            relation: 'Auto: scheduler evaluating',
          });
          return;
        }
      } catch (err) {
        if (markOrchestrationPromptSendFailed(orchestrationId, err)) return;
        console.error('[Auto] orchestration step failed:', err);
        addMessage({ type: 'system', content: `⚠️ Auto orchestration error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  /* ── Auto (Scheduler) orchestration ── */

  async function runAutoOrchestration(orchestrationId: string, agentIds: string[], task: string, originalText: string, chatId: string, promptAttachments: ChatAttachment[] = []) {
    const schedulerAgentId = SCHEDULER_AGENT_ID;
    const agentList = agentIds.map((id) => {
      const a = agents.find((x) => x.id === id);
      return `- ${id}: ${a?.name || id}`;
    }).join('\n');
    const history: { agent: string; instruction: string; step: number }[] = [];

    // Step 1: Ask scheduler agent to plan the first step
    const planPrompt = [
      'You are a ROUTING-ONLY scheduler. Your ONLY job is to pick which agent handles the task and output JSON.',
      'DO NOT use any tools. DO NOT read files. DO NOT run commands. DO NOT explore the codebase.',
      'Just read the task and decide which agent should handle the next step.',
      'Respect explicit agent mentions, role assignments, and ordering in the original user message.',
      'If the user assigns one agent to test/review/check and another to code/fix/implement, do not combine those responsibilities into one agent.',
      'For conditional workflows, choose the first required step now; after that agent responds, evaluate whether another mentioned agent should act next.',
      `\nAvailable agents:\n${agentList}`,
      `\nOriginal user message with agent mentions: ${originalText}`,
      `\nCleaned task text: ${task}`,
      promptAttachments.length ? `\n${getAttachmentSummaryText(promptAttachments)}` : '',
      '\nRespond with ONLY a raw JSON object — no markdown fences, no explanation, no tool calls:',
      'The nextAgent value must be one of the available mentioned agents above.',
      '{ "nextAgent": "<agent-id>", "instruction": "<detailed instruction for that agent>" }',
      'If no agent is needed: { "done": true, "summary": "<your answer>" }',
    ].join('\n');

    await dispatchToAgent(schedulerAgentId, planPrompt, orchestrationId, 'worker', {
      chatId,
      round: 0,
      relation: 'Auto: scheduler planning',
    });

    // After scheduler responds, its result is captured in orchestration state via maybeAdvanceOrchestration.
    // For auto mode, we need to parse the scheduler response and continue the loop.
    // We store the scheduling intent so maybeAdvanceOrchestration can handle the auto routing.
    const state = orchestrationsRef.current[orchestrationId];
    if (state) {
      (state as Record<string, unknown>).autoHistory = history;
      (state as Record<string, unknown>).autoAgentList = agentList;
      (state as Record<string, unknown>).autoOriginalText = originalText;
      (state as Record<string, unknown>).promptAttachments = promptAttachments;
      (state as Record<string, unknown>).dispatchedAttachmentAgents = [];
      (state as Record<string, unknown>).autoStep = 0;
      (state as Record<string, unknown>).autoPhase = 'awaiting-plan'; // 'awaiting-plan' | 'awaiting-execution' | 'awaiting-eval' | 'done'
    }
  }

  async function addFilesToComposer(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter(Boolean);
    if (files.length === 0) return;
    try {
      const result = await filesToAttachments(files, attachments);
      if (result.error) {
        setAttachmentError(result.error);
        return;
      }
      setAttachments((prev) => [...prev, ...result.attachments]);
      setAttachmentError(null);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to read attachment.');
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    setAttachmentError(null);
  }

  function clearAttachments() {
    setAttachments([]);
    setAttachmentError(null);
  }

  function getFilesFromClipboard(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
    const files: File[] = [];
    const seen = new Set<string>();
    const addFile = (file: File | null) => {
      if (!file) return;
      const key = `${file.name}:${file.size}:${file.type}:${file.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      files.push(file);
    };
    Array.from(event.clipboardData.files || []).forEach(addFile);
    Array.from(event.clipboardData.items || []).forEach((item) => {
      if (item.kind === 'file') addFile(item.getAsFile());
    });
    return files;
  }

  function handleAttachmentPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = getFilesFromClipboard(event);
    if (files.length === 0) return;
    event.preventDefault();
    void addFilesToComposer(files);
  }

  function dataTransferHasFiles(event: DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types || []).includes('Files');
  }

  function handleComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingAttachment(true);
  }

  function handleComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDraggingAttachment(false);
  }

  function handleComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault();
    setIsDraggingAttachment(false);
    void addFilesToComposer(event.dataTransfer.files);
  }

  /* ── Send handler ── */

  async function dispatchParsedPrompt(
    agentIds: string[],
    message: string,
    originalText: string,
    orchestrationId: string,
    options?: { chatId?: string; relation?: string; sourceUserMessageId?: string; attachments?: ChatAttachment[] },
  ) {
    const useOrchestration = agentIds.length > 1;
    const effectiveMessage = message || originalText;
    const effectiveChatId = options?.chatId || currentChatIdRef.current;
    const promptAttachments = options?.attachments || [];
    const dispatchOptions = { chatId: effectiveChatId, relation: options?.relation, attachments: promptAttachments };

    if (useOrchestration) {
      orchestrationsRef.current[orchestrationId] = {
        id: orchestrationId,
        mode: orchestrationMode,
        agentIds,
        originalTask: effectiveMessage,
        results: {},
        nextIndex: orchestrationMode === 'pipeline' ? 1 : 0,
        summaryStarted: false,
        round: orchestrationMode === 'discussion' ? 1 : 0,
        maxRounds: orchestrationMode === 'discussion' ? discussionRounds : 1,
        sourceUserMessageId: options?.sourceUserMessageId,
        sourceChatId: effectiveChatId,
        sourceAgentIds: agentIds,
        sourceMessage: effectiveMessage,
        sourceAttachments: promptAttachments,
      };
    }

    try {
      if (!useOrchestration) {
        await dispatchToAgent(agentIds[0], effectiveMessage, orchestrationId, 'worker', dispatchOptions);
        return;
      }
      if (orchestrationMode === 'auto') {
        await runAutoOrchestration(orchestrationId, agentIds, effectiveMessage, originalText, effectiveChatId, promptAttachments);
      } else if (orchestrationMode === 'discussion') {
        const results = await Promise.allSettled(agentIds.map((id) => dispatchToAgent(id, effectiveMessage, orchestrationId, 'worker', {
          ...dispatchOptions,
          round: 1,
          relation: dispatchOptions?.relation || 'Round 1 independent perspective',
        })));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) {
          const startedRunKeys = results
            .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
            .map((result) => result.value);
          await cleanupDispatchedRuns(startedRunKeys);
          throw failed.reason;
        }
      } else {
        await dispatchToAgent(agentIds[0], effectiveMessage, orchestrationId, 'worker', {
          ...dispatchOptions,
          round: 1,
          relation: dispatchOptions?.relation || 'Pipeline initial step',
        });
      }
    } catch (err) {
      if (useOrchestration) delete orchestrationsRef.current[orchestrationId];
      throw err;
    }
  }

  async function resendFailedUserMessage(message: ChatMessage) {
    if (message.type !== 'user' || message.sendStatus !== 'failed') return;
    const chatId = currentChatIdRef.current;
    if (isChatRunning(chatId)) return;
    if (!message.resendAgentIds?.length && (agentsLoading || agents.length === 0)) return;
    const parsed = parseAgents(message.content, agents);
    const agentIds = message.resendAgentIds?.length ? message.resendAgentIds : parsed.agentIds;
    const resendMessage = message.resendMessage || parsed.message || message.content;
    if (agentIds.length === 0 || !resendMessage.trim()) return;

    clearUserMessageSendFailure(chatId, message.id);
    try {
      await dispatchParsedPrompt(agentIds, resendMessage, message.content, `resend-${makeId()}`, { chatId, sourceUserMessageId: message.id, attachments: message.attachments || [] });
    } catch (err) {
      markUserMessageSendFailed(chatId, message.id, err instanceof Error ? err.message : String(err), agentIds, resendMessage, message.attachments);
    }
  }

  async function handleSend() {
    const text = input.trim();
    const sendAttachments = attachments;
    if ((!text && sendAttachments.length === 0) || agents.length === 0) return;

    const textForAgent = text || 'Please review the attached file(s).';
    // Auto-create a chat if none is active (empty homepage state)
    if (!currentChatIdRef.current) {
      await createNewChat();
    }

    const currentChatAgentId = chatHistory.find(c => c.id === currentChatIdRef.current)?.agentId;
    const { agentIds, message } = parseAgents(textForAgent, agents, currentChatAgentId);
    const orchestrationId = `orch-${makeId()}`;
    const sendChatId = currentChatIdRef.current;

    shouldStickToBottomRef.current = true;
    const userMessageId = addMessage({ type: 'user', content: text, attachments: sendAttachments.length ? sendAttachments : undefined }, sendChatId);
    setInput('');
    clearAttachments();

    // Persist user message to SQLite immediately (don't wait for agent response)
    void saveChatToHistory(sendChatId);

    // Save to input history
    const hist = inputHistoryRef.current;
    if (text && hist[hist.length - 1] !== text) hist.push(text);
    if (hist.length > 100) hist.splice(0, hist.length - 100);
    inputHistoryIndexRef.current = -1;
    inputDraftRef.current = '';
    try { window.localStorage.setItem(STORAGE_INPUT_HISTORY, JSON.stringify(hist)); } catch { /* ignore */ }

    try {
      await dispatchParsedPrompt(agentIds, message, textForAgent, orchestrationId, { chatId: sendChatId, sourceUserMessageId: userMessageId, attachments: sendAttachments });
    } catch (err) {
      markUserMessageSendFailed(sendChatId, userMessageId, err instanceof Error ? err.message : String(err), agentIds, message || textForAgent, sendAttachments);
    }
  }

  useEffect(() => {
    if (process.env.NODE_ENV !== 'test' && process.env.NEXT_PUBLIC_E2E_TESTS !== '1') return;
    const testWindow = window as typeof window & {
      __TEST_dispatchToAgent?: typeof dispatchToAgent;
      __TEST_getCurrentChatId?: () => string;
    };
    testWindow.__TEST_dispatchToAgent = dispatchToAgent;
    testWindow.__TEST_getCurrentChatId = () => currentChatIdRef.current;
    return () => {
      delete testWindow.__TEST_dispatchToAgent;
      delete testWindow.__TEST_getCurrentChatId;
    };
  }, [dispatchToAgent]);

  async function handleStop() {
    // Interrupt all active agent runs
    const stopChatId = currentChatIdRef.current;
    const activeRuns = Object.fromEntries(
      Object.entries(sessionRunsRef.current).filter(([, run]) => run.chatId === stopChatId)
    );
    const agentIds = new Set<string>();
    for (const run of Object.values(activeRuns)) {
      agentIds.add(run.agentId);
    }

    for (const agentId of agentIds) {
      try {
        await acp({ action: 'interrupt', agentId, chatId: stopChatId });
      } catch { /* ignore */ }
    }

    // Finalize pending runs for the current chat only
    for (const [runKey, run] of Object.entries(activeRuns)) {
      clearAgentUserRequestSubmissionForMessage(run.pendingId, run.chatId);
      updateMessage(run.pendingId, {
        content: run.currentText || '⏹ Stopped',
        pending: false,
        statusText: undefined,
        ptyPhase: undefined,
        userRequest: undefined,
      }, run.chatId);
      delete sessionRunsRef.current[runKey];
    }
    notifyRunStateChanged();

    // Clear orchestrations
    orchestrationsRef.current = {};
    addMessage({ type: 'system', content: '⏹ Conversation stopped.' });
    void saveCurrentChatToHistory();
  }

  /* ── Agent settings ── */

  async function openAgentSettings(agentId: string) {
    setSettingsAgentId(agentId);
    setSettingsAgentConfig(null);
    setShowAgentSettings(true);
    setAgentSettingsLoading(true);
    setAgentAccessList([]);
    setNewAccessEmail('');
    try {
      const [configData, accessData] = await Promise.all([
        acp({ action: 'get-agent-config', agentId }),
        acp({ action: 'list-agent-access', agentId }),
      ]);
      if (configData.ok) setSettingsAgentConfig(configData.agent);
      if (accessData.ok) setAgentAccessList(accessData.access || []);
    } catch (err) {
      console.error('Failed to load agent config', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  async function addAccess() {
    if (!settingsAgentId || !newAccessEmail.trim()) return;
    await acp({ action: 'add-agent-access', agentId: settingsAgentId, email: newAccessEmail.trim() });
    setNewAccessEmail('');
    const data = await acp({ action: 'list-agent-access', agentId: settingsAgentId });
    if (data.ok) setAgentAccessList(data.access || []);
  }

  async function removeAccess(email: string) {
    if (!settingsAgentId) return;
    await acp({ action: 'remove-agent-access', agentId: settingsAgentId, email });
    const data = await acp({ action: 'list-agent-access', agentId: settingsAgentId });
    if (data.ok) setAgentAccessList(data.access || []);
  }

  async function saveAgentSettings() {
    if (!settingsAgentId || !settingsAgentConfig) return;
    setAgentSettingsLoading(true);
    try {
      const data = await acp({
        action: 'update-agent-config', agentId: settingsAgentId,
        updates: {
          name: settingsAgentConfig.name,
          command: settingsAgentConfig.command,
          args: settingsAgentConfig.args,
          cwd: settingsAgentConfig.cwd,
          yolo: settingsAgentConfig.yolo,
          public: settingsAgentConfig.public,
        },
      });
      if (data.ok) {
        setShowAgentSettings(false);
        await loadAgents();
        addMessage({ type: 'system', content: data.restarted ? `⚙️ ${settingsAgentConfig.name} settings updated, restarting...` : `⚙️ ${settingsAgentConfig.name} settings saved` });
      }
    } catch (err) {
      console.error('Failed to save agent settings', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    if (!confirm(`Delete agent "${agentName}"? This cannot be undone.`)) return;
    setAgentSettingsLoading(true);
    try {
      const data = await acp({ action: 'delete-agent', agentId });
      if (data.ok) {
        setShowAgentSettings(false);
        await loadAgents();
        addMessage({ type: 'system', content: `🗑️ Agent "${agentName}" deleted` });
      }
    } catch (err) {
      console.error('Failed to delete agent', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  /* ── Create agent ── */

  async function createAgent() {
    const { id, name, command, args, cwd, yolo } = newAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId) return;
    setAddAgentLoading(true);
    try {
      const data = await acp({
        action: 'create-agent',
        agent: {
          id: trimmedId,
          name: name.trim() || trimmedId,
          command: command.trim() || 'copilot.exe',
          args: args.trim() ? args.trim().split(/\s+/) : ['--acp'],
          cwd: cwd.trim(),
          yolo,
        },
      });
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Agent "${name.trim() || trimmedId}" created` });
        setShowAddAgent(false);
        setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: defaultCwd, yolo: true });
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }

  /* ── Create relay agent for a node ── */

  async function createRelayAgent() {
    const { id, name, cwd } = newRelayAgentForm;
    const nodeName = relayAgentNode;
    const trimmedId = id.trim();
    if (!trimmedId || !nodeName) return;
    const displayName = name.trim() || trimmedId;
    setAddAgentLoading(true);
    try {
      const data = await acp({
        action: 'create-agent',
        agent: {
          id: trimmedId,
          name: displayName,
          relay: true,
          relayConnectionName: nodeName,
          cwd: cwd.trim() || '/',
          yolo: true,
        },
      });
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Relay agent "${displayName}" created on node ${nodeName}` });
        setShowAddRelayAgent(false);
        setNewRelayAgentForm({ id: '', name: '', cwd: defaultCwd });
        setRelayAgentNode('');
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create relay agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }

  /* ── Create remote agent (from node selection) ── */

  async function createRemoteAgent() {
    const { id, name, nodeName, cwd } = newRemoteAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId || !nodeName) return;
    const agentId = trimmedId;
    const displayName = name.trim() || nodeName;
    setAddAgentLoading(true);
    try {
      const data = await acp({
        action: 'create-agent',
        agent: {
          id: agentId,
          name: displayName,
          relay: true,
          relayConnectionName: nodeName,
          cwd: cwd.trim() || '/',
          yolo: true,
        },
      });
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Remote agent "${displayName}" created on node ${nodeName}` });
        setShowAddRemoteAgent(false);
        setNewRemoteAgentForm({ id: '', name: '', nodeName: '', cwd: defaultCwd });
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create remote agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }

  /* ── New chat ── */

  async function saveChatToHistory(chatId: string, preserveOrder = false) {
    void preserveOrder;
    const currentId = chatId;
    if (!currentId) return Date.now(); // No active chat — nothing to save
    const currentMessages = chatMessagesRef.current[currentId] || (currentId === currentChatIdRef.current ? messagesRef.current : []);
    const existingHistoryEntry = chatHistory.find(c => c.id === currentId);
    const currentName = currentId === currentChatIdRef.current ? chatNameRef.current : (existingHistoryEntry?.name || currentId);
    const userMsgs = currentMessages.filter(m => m.type === 'user');
    const firstUser = userMsgs[0];
    const attachmentName = firstUser?.attachments?.[0]?.name;
    // Prefer the existing history name (which includes renames) over auto-generated name
    // But treat the default "New Chat" name as if no name exists, so it auto-generates from the first message
    const hasCustomName = existingHistoryEntry?.name && existingHistoryEntry.name !== 'New Chat';
    const autoName = firstUser
      ? (firstUser.content.trim().slice(0, 50) || (attachmentName ? `Attached file: ${attachmentName}`.slice(0, 50) : currentName))
      : currentName;
    const name = hasCustomName ? existingHistoryEntry!.name : autoName;
    const persistable = getPersistableMessages(currentMessages);

    const agentSessions = currentId === currentChatIdRef.current
      ? currentAgentSessionsRef.current
      : (existingHistoryEntry?.agentSessions || {});
    const agentId = existingHistoryEntry?.agentId || '';

    // Keep the sidebar timestamp stable for existing chats. It represents the
    // chat's list/order timestamp, not every background turn update.
    const savedAt = existingHistoryEntry?.ts ?? Date.now();
    const chatData = { id: currentId, name, ts: savedAt, messages: persistable, agentSessions, agentId };

    // Save to server
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatData }),
      });
      if (currentId === currentChatIdRef.current) {
        // Also persist last active chat ID
        void fetch('/api/chats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-last-chat', chatId: currentId }),
        }).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }

    setChatHistory(prev => {
      const entry = { id: currentId, name, ts: savedAt, agentSessions, agentId };
      if (prev.some(c => c.id === currentId)) {
        return prev.map(c => c.id === currentId ? entry : c);
      }
      return normalizeChatHistory([entry, ...prev]);
    });
    return savedAt;
  }

  async function saveCurrentChatToHistory(preserveOrder = false) {
    return saveChatToHistory(currentChatIdRef.current, preserveOrder);
  }

  function clearChatMessages() {
    const initial: ChatMessage[] = [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }];
    setMessagesForChat(currentChatIdRef.current, initial);
    setExpandedMessages({});
    setInput('');
    setSelectedAgentFilter(null);
  }

  async function loadChat(chatId: string) {
    if (chatId === currentChatId) {
      setOpenChatMenuId(null);
      setShowChatsPanel(false);
      return;
    }

    setActiveSidebarChatId(chatId);
    setOpenChatMenuId(null);

    // Save current chat first
    await saveCurrentChatToHistory(true);

    // Load target chat from server
    let targetMessages: ChatMessage[] = [];
    let targetName = chatHistory.find(c => c.id === chatId)?.name || chatId;
    let agentSessions: Record<string, string> = {};
    let migratedFailedSendState = false;
    let targetTs = Date.now();
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !data.chat) {
        addMessage({ type: 'system', content: `Failed to load chat: ${data.error || 'not found'}` });
        return;
      }
      if (data.ok && data.chat) {
        agentSessions = data.chat.agentSessions || {};
        const cachedMessages = chatMessagesRef.current[chatId];
        if (cachedMessages) {
          targetMessages = cachedMessages;
        } else {
          const isReviewChat = typeof chatId === 'string' && chatId.startsWith('comment-review:');
          const migration = migrateFailedSendWarnings(data.chat.messages || [], agentSessions, {
            inferLatestUserFailure: !isReviewChat,
          });
          targetMessages = migration.messages;
          migratedFailedSendState = migration.changed;
        }
        targetName = data.chat.name || targetName;
        targetTs = data.chat.ts || targetTs;
        currentAgentSessionsRef.current = agentSessions;
      }
    } catch {
      addMessage({ type: 'system', content: 'Failed to load chat. Please try again.' });
      return;
    }

    // If chat has no messages (e.g. newly created), use the welcome message
    if (targetMessages.length === 0) {
      targetMessages = [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }];
    }

    currentChatIdRef.current = chatId;
    setMessagesForChat(chatId, targetMessages);
    setChatName(targetName);
    setCurrentChatId(chatId);
    setExpandedMessages({});
    setInput('');
    setSelectedAgentFilter(null);
    if (migratedFailedSendState) {
      void persistLoadedChatMigration(chatId, targetName, targetTs, targetMessages, agentSessions);
    }
    // Keep active runs for other chats alive; pollers use their captured chatId.
    setChatHistory(prev => {
      if (prev.some(c => c.id === chatId)) {
        return prev.map(c => c.id === chatId ? { ...c, name: targetName, agentSessions } : c);
      }
      return [...prev, { id: chatId, name: targetName, ts: Date.now(), agentSessions }];
    });

    // Persist last active chat to server
    void fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-last-chat', chatId }),
    }).catch(() => { /* ignore */ });

    // Resume agent sessions via session/load. If session/load succeeds,
    // no history injection is needed. If it fails and falls back to session/new,
    // the first turn will inject chat history as context.
    const hasAnySessions = Object.values(agentSessions).some(s => !!lastSessionId(s));
    needsContextRestoreRef.current = true;
    if (hasAnySessions) {
      const sessionEntries = Object.entries(agentSessions)
        .map(([agentId, raw]) => [agentId, lastSessionId(raw)] as [string, string | null])
        .filter(([, sid]) => !!sid) as [string, string][];
      const resumeResults = await Promise.allSettled(
        sessionEntries.map(([agentId, sessionId]) =>
          acp({ action: 'resume-session', agentId, sessionId, chatId })
        )
      );
      // If all sessions were successfully loaded via session/load, skip history injection
      const allLoaded = resumeResults.every(
        r => r.status === 'fulfilled' && r.value?.loaded === true
      );
      if (allLoaded) {
        needsContextRestoreRef.current = false;
      }
      // Handle recovered messages and pending user messages.
      for (const [index, r] of resumeResults.entries()) {
        if (r.status !== 'fulfilled') continue;
        const agentId = sessionEntries[index]?.[0];
        const val = r.value;
        if (agentId && val?.sessionId) {
          currentAgentSessionsRef.current = { ...currentAgentSessionsRef.current, [agentId]: val.sessionId };
        }
        if (agentId && val?.activeTurn && !val.activeTurn.done) {
          resumeActiveTurn(agentId, val.activeTurn);
        }
        if (val?.recoveredMessages?.length > 0) {
          for (const rm of val.recoveredMessages) {
            addMessage({ type: 'agent', content: rm.content, agentId: rm.agentId, ts: rm.ts });
          }
          addMessage({ type: 'system', content: `✅ Recovered ${val.recoveredMessages.length} message(s) from previous session.` });
        }
      }
    }

    setShowChatsPanel(false);
    setShowAgentsPanel(false);
  }

  async function createNewChat() {
    // Save current chat to history
    await saveCurrentChatToHistory();
    setOpenChatMenuId(null);

    const newCount = chatCounter + 1;
    const newName = 'New Chat';
    // Use timestamp-based ID to avoid collisions after reload
    const newId = `chat-${Date.now()}-${newCount}`;

    currentChatIdRef.current = newId;
    clearChatMessages();
    setChatName(newName);
    setChatCounter(newCount);
    currentAgentSessionsRef.current = {};
    setCurrentChatId(newId);
    setActiveSidebarChatId(newId);

    // Persist last active chat to server
    void fetch('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-last-chat', chatId: newId }),
    }).catch(() => { /* ignore */ });

    // Register the new chat in history immediately so it persists
    const newEntry: ChatHistoryEntry = { id: newId, name: newName, ts: Date.now(), agentId: chatAgentFilter || undefined };
    setChatHistory(prev => {
      if (prev.some(c => c.id === newId)) return prev;
      return normalizeChatHistory([newEntry, ...prev]);
    });
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: { ...newEntry, messages: [], agentSessions: {} } }),
      });
    } catch { /* ignore */ }

    const errors: string[] = [];
    // Sessions are created lazily when user first sends a message to each agent
    // No need to eagerly create sessions for all agents here

    // Keep active runs for other chats alive; pollers use their captured chatId.

    if (errors.length) {
      addMessage({ type: 'system', content: `⚠️ New chat created with errors: ${errors.join(', ')}` });
    } else {
      addMessage({ type: 'system', content: `✅ New chat "${newName}" created.` });
    }

    setShowChatsPanel(false);
    setShowAgentsPanel(false);

    // Reload chat list from server to ensure old chats are visible
    fetch('/api/chats').then(r => r.json()).then(data => {
      if (data.ok && Array.isArray(data.chats)) setChatHistory(normalizeChatHistory(data.chats));
    }).catch(() => { /* ignore */ });
  }

  async function shareCurrentChat(chatId: string) {
    // Ensure latest messages are saved first
    await saveCurrentChatToHistory();
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        const fullUrl = `${window.location.origin}${data.url}`;
        setShareDialog({ variant: 'link', title: 'Share this conversation', url: fullUrl });
      } else {
        setShareDialog({ variant: 'error', title: 'Share failed', detail: data.error || 'unknown error' });
      }
    } catch {
      setShareDialog({ variant: 'error', title: 'Failed to create share link' });
    }
  }

  async function renameChatById(chatId: string, newName: string) {
    if (!newName.trim()) return;
    const trimmed = newName.trim();
    try {
      await fetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', chatId, name: trimmed }),
      });
      setChatHistory(prev => prev.map(c => c.id === chatId ? { ...c, name: trimmed } : c));
      if (chatId === currentChatId) setChatName(trimmed);
    } catch { /* ignore */ }
    setRenamingChatId(null);
    setRenameValue('');
  }

  async function deleteChatById(chatId: string) {
    try {
      await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      setChatHistory(prev => prev.filter(c => c.id !== chatId));
      setOpenChatMenuId(null);
      // If deleting the active chat, return to empty homepage
      if (chatId === currentChatId) {
        currentChatIdRef.current = '';
        setCurrentChatId('');
        setActiveSidebarChatId('');
        setChatName('New Chat');
        clearChatMessages();
        currentAgentSessionsRef.current = {};
      }
    } catch { /* ignore */ }
  }

  function selectMention(agentId: string) {
    const atIndex = input.lastIndexOf('@');
    setInput(`${input.slice(0, atIndex)}@${agentId} `);
    setMentionSelectedIndex(0);
  }

  /* ────────── Render ────────── */

  return (
    <main className="page" style={themeStyle} data-theme={normalizedThemeId} suppressHydrationWarning>
      <header className="header">
        <div className="headerLeft">
          <h1>🤖 Agents Chat</h1>
        </div>
        <div className="headerRight">
          <button className={`ghostButton mobileOnlyButton ${showChatsPanel ? 'activeGhost' : ''}`} onClick={() => { switchLeftSidebarTab('chats'); setShowChatsPanel((p) => !p); setShowAgentsPanel(false); }} title="Chats">💬</button>
          <div className="themeMenuWrap" ref={themeMenuRef}>
            <button
              type="button"
              className={`ghostButton themeMenuButton ${showThemeMenu ? 'activeGhost' : ''}`}
              onClick={() => setShowThemeMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showThemeMenu}
              title={`Theme: ${activeTheme.label}`}
            >
              <span>{activeTheme.emoji}</span>
            </button>
            {showThemeMenu && (
              <div className="themeDropdown" role="menu" aria-label="Theme list">
                {Object.entries(THEMES).map(([id, theme]) => (
                  <button
                    key={id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={normalizedThemeId === id}
                    className={`themeOption ${normalizedThemeId === id ? 'activeThemeOption' : ''}`}
                    onClick={() => {
                      setThemeId(id as ThemeId);
                      setShowThemeMenu(false);
                    }}
                  >
                    <span className="themeOptionMain">
                      <span className="themeChipEmoji">{theme.emoji}</span>
                      <span>{theme.label}</span>
                    </span>
                    {normalizedThemeId === id ? <span className="themeCheck">✓</span> : null}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={`ghostButton ${showAgentsPanel ? 'activeGhost' : ''}`} onClick={() => { setShowAgentsPanel((p) => !p); setShowChatsPanel(false); setShowNodesPanel(false); }} title="Agents">🤖</button>
          <button className={`ghostButton ${showNodesPanel ? 'activeGhost' : ''}`} onClick={() => { setShowNodesPanel((p) => { if (!p) loadNodes(); return !p; }); setShowAgentsPanel(false); setShowChatsPanel(false); }} title="Nodes">🖥️</button>
          {session?.user && (
            <div className="userChip">
              <span className="userAvatar">{(session.user.name || '?')[0].toUpperCase()}</span>
              <span className="userName">{session.user.name}{isAdmin ? ' ★' : ''}</span>
              <button className="logoutBtn" onClick={() => void signOut()} title="Sign out">↗</button>
            </div>
          )}
        </div>
      </header>

      {mobilePanelOpen ? <div className="mobilePanelBackdrop" onClick={() => { setShowChatsPanel(false); setShowAgentsPanel(false); setShowNodesPanel(false); }} /> : null}

      <div className={`chatLayout ${sidebarCollapsed ? 'sidebarCollapsed' : ''} ${(showAgentsPanel || showNodesPanel) ? 'agentsSidebarOpen' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
        {/* ── Left sidebar: chats + files ── */}
        <aside className={`participantsSidebar ${showChatsPanel ? 'mobilePanelVisible' : ''}`}>
          <div className="participantsHeader">
            {sidebarCollapsed ? (
              <button
                className="sidebarExpandBtn"
                onClick={() => setSidebarCollapsed(false)}
                title="Expand sidebar"
              >
                ☰
              </button>
            ) : (
              <>
                <div className="leftSidebarTabs">
                  <button className={`leftSidebarTab ${leftSidebarTab === 'chats' ? 'active' : ''}`} onClick={() => switchLeftSidebarTab('chats')}>💬 Chats</button>
                  <button className={`leftSidebarTab ${leftSidebarTab === 'files' ? 'active' : ''}`} onClick={() => { setLeftSidebarTab('files'); }}>📄 Files</button>
                </div>
                <span className="participantsHeaderLabel" onClick={() => setSidebarCollapsed(true)} style={{ cursor: 'pointer', fontSize: '14px', opacity: 0.6 }} title="Collapse sidebar">
                  ◀
                </span>
              </>
            )}
          </div>
          {!sidebarCollapsed && leftSidebarTab === 'chats' && (
            <div className="participantsList">
              <div className="chatAgentFilterRow" aria-label="Filter chats by primary agent">
                <select
                  className="chatAgentFilterSelect"
                  value={chatAgentFilter ?? ''}
                  onChange={(e) => switchAgentFilter(e.target.value ? e.target.value : null)}
                  aria-label="Filter chats by primary agent"
                >
                  <option value="">All agents</option>
                  {chatFilterAgents.map(a => (
                    <option key={a.id} value={a.id}>{a.name || a.id}</option>
                  ))}
                </select>
              </div>
              <div className="newChatRow">
                <button className="newChatButton" onClick={() => void createNewChat()}>+ New Chat{chatAgentFilter ? ` (${chatFilterAgents.find(a => a.id === chatAgentFilter)?.name || chatAgentFilter})` : ''}</button>
              </div>
              {(() => {
                const allChats = (currentChatId && !chatHistory.some(c => c.id === currentChatId))
                  ? [{ id: currentChatId, name: chatName, ts: chatHistory[0]?.ts ? chatHistory[0].ts + 1 : Date.now() }, ...chatHistory]
                  : chatHistory;
                const uniqueChats = normalizeChatHistory(allChats);
                const filteredChats = chatAgentFilter
                  ? uniqueChats.filter(c => c.agentId === chatAgentFilter || (!c.agentId && c.id === currentChatId))
                  : uniqueChats;
                return filteredChats.map((chat) => {
                  const isCurrent = chat.id === currentChatId;
                  const isActive = chat.id === activeSidebarChatId;
                  const sidebarStatus = getChatSidebarStatus(chat.id);
                  const isRenaming = renamingChatId === chat.id;
                  return (
                    <div key={chat.id} className={`chatHistoryRow ${isActive ? 'active' : ''}`}>
                      {isRenaming ? (
                        <div className="chatRenameWrap">
                          <input
                            className="chatRenameInput"
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void renameChatById(chat.id, renameValue);
                              if (e.key === 'Escape') { setRenamingChatId(null); setRenameValue(''); }
                            }}
                            onBlur={() => void renameChatById(chat.id, renameValue)}
                          />
                        </div>
                      ) : (
                        <button className={`chatHistoryItem ${isActive ? 'active' : ''}`} title={chat.name} onClick={() => isCurrent ? undefined : loadChat(chat.id)}>
                          <span className="chatHistoryIcon">{isActive ? '💬' : '📝'}</span>
                          <span className="chatHistoryText">
                            <span className="chatHistoryName">{isCurrent ? chatName : chat.name}</span>
                            <span className="chatHistoryMetaRow">
                              <span className="chatHistoryMeta" suppressHydrationWarning>
                                {mounted ? new Date(chat.ts).toLocaleDateString() : ''}
                              </span>
                              {sidebarStatus ? <span className={`chatStatusBadge ${sidebarStatus.kind}`} title={getStatusDisplayText(sidebarStatus.label, 'Running')}>{getSidebarStatusDisplayLabel(sidebarStatus.label)}</span> : null}
                            </span>
                          </span>
                        </button>
                      )}
                      <div className="chatActionsWrap">
                        <button
                          type="button"
                          ref={(node) => {
                            if (node) chatMenuButtonRefs.current.set(chat.id, node);
                            else chatMenuButtonRefs.current.delete(chat.id);
                          }}
                          className={`chatMoreBtn ${openChatMenuId === chat.id ? 'active' : ''}`}
                          title="Chat actions"
                          aria-haspopup="menu"
                          aria-expanded={openChatMenuId === chat.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenChatMenuId(openChatMenuId === chat.id ? null : chat.id);
                          }}
                        >
                          ...
                        </button>
                        {openChatMenuId === chat.id ? (() => {
                          const rect = chatMenuButtonRefs.current.get(chat.id)?.getBoundingClientRect();
                          if (!rect) return null;
                          const left = Math.max(8, Math.min(rect.right - CHAT_ACTION_MENU_WIDTH, window.innerWidth - CHAT_ACTION_MENU_WIDTH - 8));
                          const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - CHAT_ACTION_MENU_HEIGHT - 8));
                          return createPortal(
                            <div className="chatActionsMenu" role="menu" style={{ ...themeStyle, position: 'fixed', top, left, right: 'auto', width: CHAT_ACTION_MENU_WIDTH, zIndex: 9999 }}>
                            <button
                              type="button"
                              className="chatActionItem"
                              role="menuitem"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenChatMenuId(null);
                                setRenameValue(isCurrent ? chatName : chat.name);
                                setRenamingChatId(chat.id);
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="chatActionItem"
                              role="menuitem"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenChatMenuId(null);
                                void shareCurrentChat(chat.id);
                              }}
                            >
                              Share
                            </button>
                              <button
                                type="button"
                                className="chatActionItem danger"
                                role="menuitem"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void deleteChatById(chat.id);
                                }}
                              >
                                Delete
                              </button>
                              </div>,
                              document.body
                            );
                          })() : null}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>
          )}
          {!sidebarCollapsed && leftSidebarTab === 'files' && (
            <div className="mdFilesTab">
              <div style={{ padding: '4px 0 8px' }}>
                <select
                  className="remoteAgentSelect"
                  value={mdSelectedAgentId || ''}
                  onChange={(e) => {
                    const id = e.target.value || null;
                    setMdSelectedAgentId(id);
                    if (id) loadMdFiles(id, mdDiffOnly);
                    else setMdFilesList([]);
                  }}
                >
                  <option value="">Select agent…</option>
                  {agents.filter(a => a.cwd && !a.relay && a.id !== SCHEDULER_AGENT_ID).map(a => (
                    <option key={a.id} value={a.id}>{a.canTalk === false ? '🔒 ' : ''}{a.name || a.id}</option>
                  ))}
                </select>
                <button
                  className={`mdDiffToggle ${mdDiffOnly ? 'active' : ''}`}
                  title={mdDiffOnly ? 'Showing changed files (git diff)' : 'Show only changed files'}
                  onClick={() => {
                    const next = !mdDiffOnly;
                    setMdDiffOnly(next);
                    if (mdSelectedAgentId) loadMdFiles(mdSelectedAgentId, next);
                  }}
                >
                  {mdDiffOnly ? '🔀 Changed' : '🔀 Diff'}
                </button>
              </div>
              <div className="mdFilesList">
                {mdFilesLoading && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>Loading…</div>}
                {!mdFilesLoading && mdFilesError === 'unauthorized' && (
                  <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                    <div>Not authorized</div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>You don&apos;t have access to this agent&apos;s files</div>
                  </div>
                )}
                {!mdFilesLoading && !mdFilesError && mdSelectedAgentId && mdFilesList.length === 0 && (
                  <div className="muted" style={{ padding: 16, textAlign: 'center' }}>{mdDiffOnly ? 'No changed files' : 'No files found'}</div>
                )}
                {!mdFilesLoading && mdFileTree.length > 0 && (
                  <div className="mdTree">
                    {(function renderNodes(nodes: FileTreeNode[], depth: number): React.ReactNode[] {
                      return nodes.map(node => {
                        if (node.isDir) {
                          const expanded = mdExpandedDirs.has(node.path);
                          return (
                            <div key={node.path}>
                              <button
                                className="mdTreeDir"
                                style={{ paddingLeft: `${depth * 14}px` }}
                                onClick={() => toggleMdDir(node.path)}
                              >
                                <span className="mdTreeArrow">{expanded ? '▾' : '▸'}</span>
                                <span className="mdTreeDirIcon">📁</span>
                                <span className="mdTreeLabel">{node.name}</span>
                              </button>
                              {expanded && node.children.length > 0 && renderNodes(node.children, depth + 1)}
                            </div>
                          );
                        }
                        return (
                          <button
                            key={node.path}
                            className={`mdTreeFile ${mdSelectedFile === node.path ? 'active' : ''}`}
                            style={{ paddingLeft: `${depth * 14}px` }}
                            title={node.path}
                            onClick={() => openMdFile(node.path)}
                          >
                            <span className="mdTreeFileIcon">{getFileIcon(node.name)}</span>
                            <span className="mdTreeLabel">{node.name}</span>
                          </button>
                        );
                      });
                    })(mdFileTree, 0)}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* ── Sidebar resize handle ── */}
        {!sidebarCollapsed && (
          <div
            className="sidebarResizeHandle"
            onMouseDown={(e) => {
              e.preventDefault();
              setOpenChatMenuId(null);
              sidebarDragRef.current = true;
              document.body.style.cursor = 'col-resize';
              document.body.style.userSelect = 'none';
            }}
          />
        )}

        {/* ── Main chat area ── */}
        <div className="chatMain">
          {leftSidebarTab === 'files' && mdEditorOpen && mdSelectedFile ? (
            /* ── Inline File Editor ── */
            <div className="mdEditorInline">
              <div className="mdEditorContent">
              {mdConflict && mdConflict.mode === 'choice' && (
                <div className="mdConflictBackdrop" role="dialog" aria-modal="true" aria-labelledby="md-conflict-title">
                  <div className="mdConflictDialog">
                    <h2 id="md-conflict-title">File changed on disk</h2>
                    <p>
                      Someone else saved <strong>{mdConflict.path}</strong> after you opened it. Choose how to resolve the conflict.
                    </p>
                    <div className="mdConflictActions">
                      <button className="mdEditorBtn danger" onClick={resolveMdConflictByReload}>
                        Reload
                      </button>
                      <button className="mdEditorBtn" onClick={beginManualMdConflictResolution}>
                        Handle conflict manually
                      </button>
                      <button className="mdEditorBtn secondary" onClick={() => setMdConflict(null)}>
                        Cancel
                      </button>
                    </div>
                    <p className="mdConflictNote">Reload will discard your current unsaved changes.</p>
                  </div>
                </div>
              )}
              {mdConflict && mdConflict.mode === 'manual' && (
                <div className="mdConflictDiffPage">
                  <div className="mdConflictDiffHeader">
                    <div>
                      <h2>Resolve conflict: {mdConflict.path}</h2>
                      <p>Review the server version and your version. Edit the resolved content, or use the quick choices to keep server / keep mine.</p>
                    </div>
                    <div className="mdConflictActions">
                      <button className="mdEditorBtn secondary" onClick={keepServerVersion}>keep server</button>
                      <button className="mdEditorBtn secondary" onClick={keepMineVersion}>keep mine</button>
                      <button className="mdEditorBtn" onClick={() => void handleSaveManualMdConflict()} disabled={mdSaving}>
                        {mdSaving ? 'Saving…' : 'Save resolved'}
                      </button>
                      <button className="mdEditorBtn secondary" onClick={() => setMdConflict({ ...mdConflict, mode: 'choice' })}>Back</button>
                    </div>
                  </div>
                  <div className="mdConflictDiffGrid" aria-label="Conflict diff">
                    <div className="mdConflictDiffColumn">
                      <div className="mdConflictColumnTitle">Server</div>
                      <pre>{mdConflict.serverContent}</pre>
                    </div>
                    <div className="mdConflictDiffColumn">
                      <div className="mdConflictColumnTitle">Mine</div>
                      <pre>{mdConflict.mineContent}</pre>
                    </div>
                  </div>
                  <div className="mdConflictDiffRows">
                    {buildSimpleLineDiff(mdConflict.serverContent, mdConflict.mineContent).map((line, index) => (
                      <div key={line.key} className={`mdConflictDiffRow ${line.type}`}>
                        <span className="mdConflictLineNo">{index + 1}</span>
                        <code>{line.serverLine ?? ''}</code>
                        <code>{line.mineLine ?? ''}</code>
                      </div>
                    ))}
                  </div>
                  <label className="mdConflictResolvedLabel" htmlFor="md-conflict-resolved">Resolved content</label>
                  <textarea
                    id="md-conflict-resolved"
                    className="mdConflictResolvedTextarea"
                    value={mdConflictResolvedContent}
                    onChange={(e) => setMdConflictResolvedContent(e.target.value)}
                    spellCheck={false}
                  />
                </div>
              )}
              <div className="mdEditorToolbar">
                <div className="mdEditorToolbarLeft">
                  <span className="mdEditorFilePath">{getFileIcon(mdSelectedFile)} {mdSelectedFile}</span>
                  {mdDirty && <span className="mdDirtyBadge">● Unsaved</span>}
                </div>
                <div className="mdEditorToolbarRight">
                  {isMarkdownFile(mdSelectedFile) && (
                    <div className="mdModeToggle">
                      <button className={`mdModeBtn ${mdEditorMode === 'split' ? 'active' : ''}`} onClick={() => {
                        if (mdEditorMode === 'live') {
                          const md = syncLiveToMarkdown();
                          setMdEditContent(md);
                        }
                        setMdEditorMode('split');
                      }}>Split</button>
                      <button className={`mdModeBtn ${mdEditorMode === 'live' ? 'active' : ''}`} onClick={() => {
                        setMdLiveHtml(markdownToHtml(mdEditContent));
                        setMdEditorMode('live');
                      }}>Live Edit</button>
                    </div>
                  )}
                  {isHtmlFile(mdSelectedFile) && (
                    <div className="mdModeToggle">
                      <button className="mdModeBtn active" onClick={() => setMdEditorMode('live')}>Preview</button>
                    </div>
                  )}
                  <button
                    className={`mdEditorBtn commentToggle ${commentSidebarOpen ? 'active' : ''}`}
                    onClick={() => setCommentSidebarOpen(p => !p)}
                    title="Toggle comments"
                  >
                    💬 {fileComments.filter(c => c.status === 'active').length || ''}
                  </button>
                  <button className="mdEditorBtn save" onClick={() => void saveMdFile()} disabled={mdSaving || !mdDirty}>
                    {mdSaving ? 'Saving…' : '💾 Save'}
                  </button>
                  <button className="mdEditorBtn secondary" onClick={() => {
                    if (isMarkdownFile(mdSelectedFile) && mdEditorMode === 'live') {
                      const md = syncLiveToMarkdown();
                      if (md !== mdFileContent) { if (!confirm('Discard changes?')) return; }
                    } else if (mdDirty) { if (!confirm('Discard changes?')) return; }
                    closeMdEditor();
                  }}>
                    ✕ Close
                  </button>
                </div>
              </div>
              {!mdConflict && (isMarkdownFile(mdSelectedFile) ? (
                mdEditorMode === 'split' ? (
                  <div className="mdEditorSplit">
                    <div className="mdEditorPane mdEditorEditPane">
                      <textarea
                        className="mdEditorTextarea"
                        value={mdEditContent}
                        onChange={(e) => { setMdEditContent(e.target.value); setMdDirty(e.target.value !== mdFileContent); }}
                        spellCheck={false}
                      />
                    </div>
                    <div className="mdEditorPane mdEditorPreviewPane">
                      <div className="markdownBody">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{mdEditContent}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                ) : mdEditorMode === 'review' ? (
                  <div className="mdEditorSimple">
                    <div className="fileContentWithLines" ref={fileContentRef} onMouseUp={handleTextSelection} onScroll={handleFileContentScroll}>
                      {(() => {
                        const commentsByLine = getCommentsByLine();
                        return mdEditContent.split('\n').map((line, idx) => renderReviewFileLine(line, idx, commentsByLine));
                      })()}
                    </div>
                    {commentAddRange && !showCommentInput && (
                      <button
                        className="addCommentFloatingBtn"
                        style={{ position: 'absolute', right: commentSidebarOpen ? '280px' : '40px', top: `${(commentAddRange.startLine - 1) * 20 + 40}px` }}
                        onClick={() => { setShowCommentInput(true); if (!commentSidebarOpen) setCommentSidebarOpen(true); }}
                      >
                        💬 Add Comment
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="mdEditorLive" ref={mdLiveContainerRef} onScroll={handleLiveEditorScroll}>
                    <div
                      ref={mdLiveRef}
                      className="mdLiveEditable markdownBody"
                      contentEditable
                      suppressContentEditableWarning
                      dangerouslySetInnerHTML={{ __html: mdLiveHtml }}
                      onMouseDown={() => {
                        hideLiveEditCommentButton();
                        clearLiveSelectionDraft();
                      }}
                      onInput={() => {
                        if (mdLiveRef.current) {
                          const html = mdLiveRef.current.innerHTML;
                          const md = turndownRef.current!.turndown(html);
                          setMdLiveHtml(html);
                          setMdEditContent(md);
                          setMdDirty(md !== mdFileContent);
                        }
                      }}
                    />
                    {liveSelectionDraftAnchor && (
                      <div className="liveSelectionDraftLayer" aria-hidden="true">
                        {liveSelectionDraftAnchor.rects.map((rect, idx) => (
                          <span
                            key={`${idx}-${rect.left}-${rect.top}`}
                            className="liveSelectionDraftHighlight"
                            style={{
                              left: `${rect.left}px`,
                              top: `${rect.top}px`,
                              width: `${rect.width}px`,
                              height: `${rect.height}px`,
                            }}
                          />
                        ))}
                      </div>
                    )}
                    {liveCommentMarkers.length > 0 && (
                      <div className="liveCommentMarkerLayer">
                        {liveCommentMarkers.map(marker => (
                          <button
                            key={marker.lineNum}
                            type="button"
                            className={`lineCommentMarker liveCommentMarker ${marker.selected ? 'selected' : ''}`}
                            style={{
                              left: `${marker.left}px`,
                              top: `${marker.top}px`,
                              borderColor: marker.color,
                              color: marker.color,
                            }}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={(e) => { e.stopPropagation(); openCommentIds(marker.commentIds); }}
                            title={marker.title}
                            aria-label={marker.label}
                          >
                            💬{marker.count > 1 ? <span className="lineCommentCount">{marker.count}</span> : null}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      ref={liveEditCommentBtnRef}
                      className="addCommentFloatingBtn"
                      style={{ position: 'absolute', display: 'none' }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const range = pendingLiveEditCommentRangeRef.current;
                        const anchor = pendingLiveEditCommentAnchorRef.current;
                        const domRange = pendingLiveEditDomRangeRef.current;
                        const selectedText = pendingLiveEditSelectedTextRef.current;
                        if (!range) return;
                        setCommentAddRange(range);
                        liveSelectionDraftRangeRef.current = domRange ? domRange.cloneRange() : null;
                        liveSelectionDraftTextRef.current = selectedText;
                        setLiveSelectionDraftAnchor(anchor);
                        setShowCommentInput(true);
                        if (!commentSidebarOpen) setCommentSidebarOpen(true);
                        hideLiveEditCommentButton();
                      }}
                    >
                      💬 Add Comment
                    </button>
                  </div>
                )
              ) : isHtmlFile(mdSelectedFile) ? (
                <div className="mdHtmlPreviewWrap">
                  <iframe
                    className="mdHtmlPreviewFrame"
                    title={`Rendered preview of ${mdSelectedFile}`}
                    sandbox=""
                    srcDoc={mdFileContent}
                  />
                </div>
              ) : (
                <div className="mdEditorSimple">
                  <div className="fileContentWithLines" ref={fileContentRef} onMouseUp={handleTextSelection} onScroll={handleFileContentScroll}>
                    {(() => {
                      const commentsByLine = getCommentsByLine();
                      return mdEditContent.split('\n').map((line, idx) => renderReviewFileLine(line, idx, commentsByLine));
                    })()}
                  </div>
                  {commentAddRange && !showCommentInput && (
                    <button
                      className="addCommentFloatingBtn"
                      style={{ position: 'absolute', right: commentSidebarOpen ? '280px' : '40px', top: `${(commentAddRange.startLine - 1) * 20 + 40}px` }}
                      onClick={() => { setShowCommentInput(true); if (!commentSidebarOpen) setCommentSidebarOpen(true); }}
                    >
                      💬 Add Comment
                    </button>
                  )}
                </div>
              ))}
              </div>
              {/* ── Comment sidebar ── */}
              {commentSidebarOpen ? (
                <div className="commentSidebar" ref={commentSidebarRef}>
                  <div className="commentSidebarHeader">
                    <span>Comments</span>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <select
                        className="commentFilterSelect"
                        value={commentFilter}
                        onChange={(e) => setCommentFilter(e.target.value as 'all' | 'active' | 'resolved')}
                      >
                        <option value="all">All</option>
                        <option value="active">Active</option>
                        <option value="resolved">Resolved</option>
                      </select>
                      <button className="sidebarToggle" onClick={() => setCommentSidebarOpen(false)} title="Collapse comments">◀</button>
                    </div>
                  </div>
                  <div className="commentSidebarList">
                    {(() => {
                      const visibleComments = getVisibleSidebarComments();
                      const commentLayout = getCommentSidebarLayout(visibleComments);
                      return (
                        <>
                          <div className="commentSidebarCanvas" style={{ minHeight: `${getCommentSidebarHeight(visibleComments, commentLayout)}px` }}>
                            {visibleComments.map(c => {
                              const isSelected = selectedCommentId === c.id;
                              const isReplying = replyingToCommentId === c.id;
                              const repliesExpanded = expandedReplyIds.has(c.id);
                              return (
                                <div
                                 key={c.id}
                                 data-comment-id={c.id}
                                 className={`commentCard aligned ${isSelected ? 'selected' : ''} ${c.status === 'resolved' ? 'resolved' : ''} ${c.status === 'processing' ? 'processing' : ''} ${c.status === 'queued' ? 'queued' : ''}`}
                                 style={{ top: `${commentLayout.get(c.id) ?? getCommentLineTop(c)}px` }}
                                 onClick={() => setSelectedCommentId(isSelected ? null : c.id)}
                                >
                                 <div className="commentCardHeader">
                                   <span className="commentAuthor">
                                     {c.authorType === 'agent' ? '🤖' : '👤'} {c.authorName || c.authorType}
                                   </span>
                                   <span className="commentHeaderMeta">
                                     <span className={`commentStatusBadge ${c.status}`}>{getCommentStatusLabel(c.status)}</span>
                                     <span className="commentLineRange">
                                       {c.rangeStartLine != null ? (c.rangeEndLine != null && c.rangeEndLine !== c.rangeStartLine ? `L${c.rangeStartLine}-${c.rangeEndLine}` : `L${c.rangeStartLine}`) : ''}
                                     </span>
                                   </span>
                                 </div>
                                 {isSelected || c.status === 'processing' || c.status === 'queued' ? (
                                   <>
                                     <div className="commentContent">{c.content}</div>
                                     {c.status === 'active' && (
                                       <div className="commentActions">
                                         <button className="commentActionBtn approve" onClick={(e) => { e.stopPropagation(); void handleApproveComment(c.id); }}>✓ Approve</button>
                                         <button className="commentActionBtn reject" onClick={(e) => { e.stopPropagation(); void handleRejectComment(c.id); }}>✗ Reject</button>
                                         <button className="commentActionBtn reply" onClick={(e) => { e.stopPropagation(); setReplyingToCommentId(isReplying ? null : c.id); setReplyInput(''); }}>💬 Reply</button>
                                       </div>
                                     )}
                                     {c.status === 'processing' && (
                                       <>
                                         <div className="commentProcessing" onClick={(e) => {
                                           e.stopPropagation();
                                           if (c.linkedChatId) {
                                             openCommentReviewChat(c.linkedChatId);
                                           }
                                         }}>
                                           <span className="commentSpinner" />
                                           <span>Processing… (click to view)</span>
                                         </div>
                                         <div className="commentActions">
                                           <button className="commentActionBtn stop" onClick={(e) => { e.stopPropagation(); void handleStopProcessingComment(c); }}>⏹ Stop</button>
                                         </div>
                                       </>
                                     )}
                                     {c.status === 'queued' && (
                                       <div className="commentProcessing queued" onClick={(e) => {
                                         e.stopPropagation();
                                         if (c.linkedChatId) {
                                           openCommentReviewChat(c.linkedChatId);
                                         }
                                       }}>
                                         <span>⏳ Queued… (click to view)</span>
                                       </div>
                                     )}
                                     {c.status === 'resolved' && (
                                       <div className="commentResolved">
                                         <span>✓ Resolved</span>
                                         {c.linkedChatId && (
                                           <button
                                             type="button"
                                             className="commentReviewChatLink"
                                             onClick={(e) => {
                                               e.stopPropagation();
                                               openCommentReviewChat(c.linkedChatId!);
                                             }}
                                           >
                                             View chat
                                           </button>
                                         )}
                                       </div>
                                     )}
                                     {c.replies.length > 0 && (
                                       <div className="commentReplies">
                                         {!repliesExpanded && c.replies.length > 1 ? (
                                           <button className="commentShowReplies" onClick={(e) => { e.stopPropagation(); setExpandedReplyIds(prev => new Set(prev).add(c.id)); }}>
                                             {c.replies.length} replies
                                           </button>
                                         ) : (
                                           c.replies.map(rp => (
                                             <div key={rp.id} className="commentReply">
                                               <span className="commentReplyAuthor">{rp.authorType === 'agent' ? '🤖' : '👤'} {rp.authorName || rp.authorType}</span>
                                               <span className="commentReplyText">{rp.content}</span>
                                             </div>
                                           ))
                                         )}
                                       </div>
                                     )}
                                     {isReplying && (
                                       <div className="commentReplyInput" onClick={(e) => e.stopPropagation()}>
                                         <input
                                           type="text"
                                           value={replyInput}
                                           onChange={(e) => setReplyInput(e.target.value)}
                                           placeholder="Reply…"
                                           onKeyDown={(e) => { if (e.key === 'Enter') void handleReplyComment(c.id); }}
                                           autoFocus
                                         />
                                         <button onClick={() => void handleReplyComment(c.id)}>Send</button>
                                       </div>
                                     )}
                                   </>
                                 ) : (
                                   <div className="commentContentCompact">{c.content}</div>
                                 )}
                                </div>
                              );
                            })}
                            {showCommentInput && commentAddRange && (
                              <div
                                className="commentAddForm aligned"
                                ref={commentAddFormRef}
                                style={{ top: `${(commentAddRange.startLine - 1) * FILE_REVIEW_LINE_HEIGHT - commentSourceScrollTop}px` }}
                              >
                                <div className="commentAddLabel">New comment on L{commentAddRange.startLine}{commentAddRange.endLine !== commentAddRange.startLine ? `-${commentAddRange.endLine}` : ''}</div>
                                <textarea
                                 className="commentAddTextarea"
                                 value={commentInput}
                                 onChange={(e) => setCommentInput(e.target.value)}
                                 placeholder="Write a comment…"
                                 autoFocus={!liveSelectionDraftAnchor}
                                />
                                <div className="commentAddActions">
                                 <button className="commentActionBtn" onClick={() => { setShowCommentInput(false); setCommentAddRange(null); setCommentInput(''); clearLiveSelectionDraft(); }}>Cancel</button>
                                 <button className="commentActionBtn approve" onClick={() => void handleCreateComment()} disabled={!commentInput.trim()}>Submit</button>
                                </div>
                              </div>
                            )}
                          </div>
                          {visibleComments.length === 0 && !showCommentInput && (
                            <div className="muted" style={{ padding: 20, textAlign: 'center', fontSize: 13 }}>
                              No comments
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              ) : (
                fileComments.length > 0 && (
                  <div className="commentSidebarCollapsed" onClick={() => setCommentSidebarOpen(true)} title="Open comments">
                    <span className="commentSidebarCollapsedLabel">COMMENTS</span>
                    <span className="commentBadge">{fileComments.filter(c => c.status === 'active').length}</span>
                    <span className="commentExpandBtn">▶</span>
                  </div>
                )
              )}
            </div>
          ) : !currentChatId ? (
          /* ── Empty homepage: no chat selected ── */
          <div className="emptyHomepage">
            <div className="emptyHomepageContent">
              <div className="emptyHomepageLogo">💬</div>
              <h2 className="emptyHomepageTitle">Agents Chat</h2>
              <p className="emptyHomepageSubtitle">Start a new conversation with your agents</p>
              <button className="emptyHomepageNewChat" onClick={() => void createNewChat()}>
                + New Chat{chatAgentFilter ? ` with ${chatFilterAgents.find(a => a.id === chatAgentFilter)?.name || chatAgentFilter}` : ''}
              </button>
            </div>
          </div>
          ) : (
          <>
          <section className="chatContainer" ref={chatContainerRef}>
            {visibleMessages.map((message) => (
              <div key={message.id} className={`message ${message.type} ${message.summary ? 'summaryCard' : ''}`}>
                {message.type !== 'user' && (
                  <div className="messageHeader">
                    <span className="agentName">{message.type === 'system' ? 'System' : (agents.find((a) => a.id === message.agentId)?.name || message.agentId || 'agent')}</span>
                    {message.round ? <span className="messageMetaTag">Round {message.round}</span> : null}
                    {message.relation ? <span className="messageMetaTag">{message.relation}</span> : null}
                    <span suppressHydrationWarning>{mounted ? formatMessageTime(message.ts) : ''}</span>
                  </div>
                )}
                {message.pending && !message.content && !(message.parts && message.parts.length > 0) && !message.userRequest ? (
                  <div className="thinkingWrap">
                    <span className="thinkingText">{getStatusDisplayText(message.statusText, 'Thinking')}</span>
                    <span className="thinkingDots"><span /><span /><span /></span>
                  </div>
                ) : (() => {
                  const hasParts = message.parts && message.parts.length > 0;
                  const isLong = (message.content || '').length > 400 || (message.content || '').split('\n').length > 12;
                  const isCollapsed = expandedMessages[message.id] === false;
                  return (
                    <>
                      {message.pending && message.statusText && !hasParts ? <div className="ptyStatusBadge">{getStatusDisplayText(message.statusText, 'Generating')}</div> : null}
                      {hasParts ? (() => {
                        const totalText = message.parts!.filter(p => p.kind === 'text').map(p => p.text).join('');
                        const partsLong = totalText.length > 400 || totalText.split('\n').length > 12 || message.parts!.length > 6;
                        return (<>
                        <div className={`partsStream ${partsLong && isCollapsed && !message.pending ? 'collapsed' : ''}`}>
                          {message.parts!.map((part, pi) => {
                            if (part.kind === 'thinking') {
                              return (
                                <div key={pi} className="thinkingPart">
                                  <div className="thinkingPartText">{part.text}</div>
                                </div>
                              );
                            }
                            if (part.kind === 'tool') {
                              return (
                                <details key={pi} className="toolCallItem" open={!part.done}>
                                  <summary className={`toolCallSummary ${part.done ? 'complete' : 'running'}`}>
                                    <span className="toolCallIcon">{part.done ? '✅' : '⏳'}</span>
                                    <span className="toolCallName">{part.toolName}</span>
                                  </summary>
                                  {part.args && <pre className="toolCallDetail">{part.args.length > 500 ? part.args.slice(0, 500) + '…' : part.args}</pre>}
                                  {part.result && <pre className="toolCallDetail toolCallResult">{part.result.length > 500 ? part.result.slice(0, 500) + '…' : part.result}</pre>}
                                </details>
                              );
                            }
                            if (part.kind === 'user_answer') {
                              return (
                                <div key={pi} className="userAnswerPart">
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{part.text}</ReactMarkdown>
                                </div>
                              );
                            }
                            if (part.kind === 'text') {
                              return (
                                <div key={pi} className={`messageContent markdownBody ${message.pending ? 'pending' : ''}`}>
                                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{part.text}</ReactMarkdown>
                                </div>
                              );
                            }
                            return null;
                          })}
                          {message.pending && (
                            <div className="streamingIndicator">
                              <span className="streamingPulse" />
                              <span>{getStatusDisplayText(message.statusText, 'Generating')}</span>
                            </div>
                          )}
                        </div>
                        {renderAttachmentsList(message.attachments)}
                        {renderAgentUserRequest(message)}
                        <div className="messageActions">
                          {partsLong && !message.pending && (
                            <button className="collapseToggle" onClick={() => setExpandedMessages((prev) => ({ ...prev, [message.id]: prev[message.id] === false ? true : false }))}>
                              {isCollapsed ? 'Expand' : 'Collapse'}
                            </button>
                          )}
                          {message.type !== 'user' && (
                            <button
                              type="button"
                              className="messageCopyButton"
                              aria-label="Copy answer"
                              title="Copy answer"
                              onClick={() => void copyMessageToClipboard(message)}
                            >
                              {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                            </button>
                          )}
                        </div>
                        </>);
                      })() : (
                        <>
                          <div className={`messageContent markdownBody ${message.pending ? 'pending' : ''} ${isLong && isCollapsed ? 'collapsed' : ''}`}>
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{message.content}</ReactMarkdown>
                          </div>
                          {renderAttachmentsList(message.attachments)}
                          {renderUserSendFailure(message)}
                          {message.pending && message.content && (
                            <div className="streamingIndicator">
                              <span className="streamingPulse" />
                              <span>{getStatusDisplayText(message.statusText, 'Generating')}</span>
                            </div>
                          )}
                          {renderAgentUserRequest(message)}
                          <div className="messageActions">
                            {isLong && (
                              <button className="collapseToggle" onClick={() => setExpandedMessages((prev) => ({ ...prev, [message.id]: prev[message.id] === false ? true : false }))}>
                                {isCollapsed ? 'Expand' : 'Collapse'}
                              </button>
                            )}
                            {message.type !== 'user' && (
                              <button
                                type="button"
                                className="messageCopyButton"
                                aria-label="Copy answer"
                                title="Copy answer"
                                onClick={() => void copyMessageToClipboard(message)}
                              >
                                {copiedMessageId === message.id ? 'Copied' : 'Copy'}
                              </button>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  );
                })()}
              </div>
            ))}
          </section>

          <section className="chatInputDock">
            <div className="composerStack">
              {filteredAgents.length > 0 && (
                <div className="mentionDropdown">
                  {filteredAgents.map((agent, idx) => (
                    <button key={agent.id} className={`mentionItem ${mentionSelectedIndex === idx ? 'selected' : ''}`} onClick={() => selectMention(agent.id)}>
                      <span className="mentionId">@{agent.id}</span>
                      <span className="mentionDesc">{agent.name || ''}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="inputArea">
                <div
                  className={`composerShell ${isDraggingAttachment ? 'dragOver' : ''}`}
                  onDragOver={handleComposerDragOver}
                  onDragLeave={handleComposerDragLeave}
                  onDrop={handleComposerDrop}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ATTACHMENT_ACCEPT}
                    className="srOnlyFileInput"
                    onChange={(e) => { void addFilesToComposer(e.currentTarget.files || []); e.currentTarget.value = ''; }}
                  />
                  {mentionedAgentIds.length > 0 ? (
                    <div className="targetPills">
                      {mentionedAgentIds.map((agentId) => (
                        <span key={agentId} className="targetPill">@{agentId}</span>
                      ))}
                      {orchestrationEnabled && (
                        <>
                          <button
                            type="button"
                            className={`targetPill orchPill ${orchestrationMode === 'auto' ? 'orchPillActive' : ''}`}
                            onClick={() => setOrchestrationMode('auto')}
                            title="Auto: a scheduler decides which agent to call next based on results"
                          >
                            🧠 Auto
                          </button>
                          <button
                            type="button"
                            className={`targetPill orchPill ${orchestrationMode === 'pipeline' ? 'orchPillActive' : ''}`}
                            onClick={() => setOrchestrationMode('pipeline')}
                            title="Pipeline: agents run sequentially, each receives the previous agent's output"
                          >
                            🔀 Pipeline
                          </button>
                          <button
                            type="button"
                            className={`targetPill orchPill ${orchestrationMode === 'discussion' ? 'orchPillActive' : ''}`}
                            onClick={() => setOrchestrationMode('discussion')}
                            title="Discussion: agents run in parallel, then a summary is generated"
                          >
                            💬 Discussion
                          </button>
                          {orchestrationMode === 'discussion' && (
                            <select
                              className="orchRoundsSelect"
                              value={discussionRounds}
                              onChange={(e) => setDiscussionRounds(Number(e.target.value))}
                              title="Number of discussion rounds"
                            >
                              {[1, 2, 3, 4, 5].map((n) => (
                                <option key={n} value={n}>{n} {n === 1 ? 'round' : 'rounds'}</option>
                              ))}
                            </select>
                          )}
                        </>
                      )}
                    </div>
                  ) : null}
                  {renderAttachmentsList(attachments, 'composer')}
                  {attachmentError ? <div className="attachmentError" role="alert">{attachmentError}</div> : null}
                  <div className="composerRow">
                    <button
                      type="button"
                      className="attachButton"
                      aria-label="Attach files or photos"
                      title="Attach files or photos"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      📎
                    </button>
                    <textarea
                      ref={composerRef}
                      className="composerTextarea"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onPaste={handleAttachmentPaste}
                      onKeyDown={(e) => {
                        if (filteredAgents.length > 0) {
                          if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIndex((p) => (p + 1) % filteredAgents.length); return; }
                          if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIndex((p) => (p - 1 + filteredAgents.length) % filteredAgents.length); return; }
                          if (e.key === 'Enter' || e.key === 'Tab') {
                            e.preventDefault();
                            const sel = filteredAgents[mentionSelectedIndex] || filteredAgents[0];
                            if (sel) selectMention(sel.id);
                            return;
                          }
                          if (e.key === 'Escape') { e.preventDefault(); setInput((p) => p.replace(/@(\S*)$/, '')); return; }
                        }
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (isCurrentChatSending) { void handleStop(); } else { void handleSend(); } }
                        if (filteredAgents.length === 0) {
                          const caretStart = e.currentTarget.selectionStart ?? 0;
                          const caretEnd = e.currentTarget.selectionEnd ?? 0;
                          const singleLine = !input.includes('\n');
                          if (e.key === 'ArrowUp' && singleLine && caretStart === 0 && caretEnd === 0) {
                            e.preventDefault();
                            const hist = inputHistoryRef.current;
                            if (hist.length === 0) return;
                            if (inputHistoryIndexRef.current === -1) inputDraftRef.current = input;
                            const newIdx = inputHistoryIndexRef.current === -1 ? hist.length - 1 : Math.max(0, inputHistoryIndexRef.current - 1);
                            inputHistoryIndexRef.current = newIdx;
                            setInput(hist[newIdx]);
                            return;
                          }
                          if (e.key === 'ArrowDown' && singleLine && caretStart === input.length && caretEnd === input.length) {
                            e.preventDefault();
                            const hist = inputHistoryRef.current;
                            if (inputHistoryIndexRef.current === -1) return;
                            const newIdx = inputHistoryIndexRef.current + 1;
                            if (newIdx >= hist.length) {
                              inputHistoryIndexRef.current = -1;
                              setInput(inputDraftRef.current);
                            } else {
                              inputHistoryIndexRef.current = newIdx;
                              setInput(hist[newIdx]);
                            }
                            return;
                          }
                        }
                      }}
                      placeholder="Message Agents Chat"
                      rows={1}
                      spellCheck={false}
                    />
                    <div className="composerActions composerInlineActions">
                      {isCurrentChatSending
                        ? <button className="sendButton stopButton" onClick={() => void handleStop()} aria-label="Stop generation">⏹</button>
                        : <button className="sendButton" onClick={() => void handleSend()} disabled={agents.length === 0 || (!input.trim() && attachments.length === 0)} aria-label="Send message">
                            <span className="sendButtonIcon">↑</span>
                          </button>
                      }
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
          </>
          )}
        </div>

        {/* ── Right sidebar: agents ── */}
        {showAgentsPanel && (
          <aside className={`agentsSidebar ${showAgentsPanel ? 'mobilePanelVisible' : ''}`}>
            <div className="agentsSidebarHeader">
              <span>Agents</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <div style={{ position: 'relative' }}>
                  <button className="sidebarToggle" onClick={() => setShowAgentAddMenu(p => !p)} title="Add agent">+</button>
                  {showAgentAddMenu && (
                    <div className="nodeAddMenu">
                      {isAdmin && (
                        <button className="nodeAddMenuItem" onClick={() => { setShowAgentAddMenu(false); setShowAddAgent(true); }}>
                          🖥️ Add Agent in Server
                        </button>
                      )}
                      <button className="nodeAddMenuItem" onClick={() => { setShowAgentAddMenu(false); loadNodes(); setNewRemoteAgentForm({ id: '', name: '', nodeName: '', cwd: defaultCwd }); setShowAddRemoteAgent(true); }}>
                        🌐 Add Agent from Remote Node
                      </button>
                      <button className="nodeAddMenuItem" onClick={() => setShowAgentAddMenu(false)}>
                        ✕ Cancel
                      </button>
                    </div>
                  )}
                </div>
                <button className="sidebarToggle" onClick={() => setShowAgentsPanel(false)}>→</button>
              </div>
            </div>
            <div className="agentsSidebarSection">
              {agentSidebarItems.map((agent) => (
                <button key={agent.id} className="agentListItem" style={agent.canModify ? undefined : { cursor: 'default' }} onClick={() => agent.canModify && openAgentSettings(agent.id)} title={agent.canModify ? `${agent.name} — Click for settings` : agent.name}>
                  <span className="agentListAvatar">{(agent.name || agent.id).slice(0, 1).toUpperCase()}</span>
                  <span className="agentListInfo">
                    <span className="agentListName">{agent.name || agent.id}{agent.canTalk === false ? ' 🔒' : ''}</span>
                    <span className="agentListId" title={getAgentLocationTitle(agent)}>{getAgentLocationLabel(agent)}</span>
                  </span>
                  <span className={`agentListStatus ${agent.running ? 'running' : ''}`}>{agent.running ? '●' : '○'}</span>
                </button>
              ))}
              {agentSidebarItems.length === 0 && (
                <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
                  {agentsLoading ? 'Loading...' : 'No agents configured'}
                </div>
              )}
            </div>
          </aside>
        )}

        {/* ── Right sidebar: nodes ── */}
        {showNodesPanel && (
          <aside className={`agentsSidebar ${showNodesPanel ? 'mobilePanelVisible' : ''}`}>
            <div className="agentsSidebarHeader">
              <span>Nodes</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="sidebarToggle" onClick={() => loadNodes()} title="Refresh all">↻</button>
                <div style={{ position: 'relative' }}>
                  <button className="sidebarToggle" onClick={() => { setShowSetupScript(true); }} title="Add node">+</button>
                </div>
                <button className="sidebarToggle" onClick={() => setShowNodesPanel(false)}>→</button>
              </div>
            </div>
            <div className="agentsSidebarSection">
              {nodesData.map((node) => (
                <button key={node.name} className="agentListItem" onClick={() => handleRefreshNode(node.name)} title={`Click to refresh — ${node.online ? 'Online' : 'Offline'}`}>
                  <span className="agentListAvatar nodeAvatar" data-online={node.online ? '' : undefined}>{node.label.slice(0, 1).toUpperCase()}</span>
                  <span className="agentListInfo">
                    {editingNodeName === node.name ? (
                      <input
                        className="nodeEditInput"
                        value={editingNodeLabel}
                        onChange={(e) => setEditingNodeLabel(e.target.value)}
                        onBlur={() => { if (editingNodeLabel.trim() && editingNodeLabel !== node.label) handleRenameNode(node.name, editingNodeLabel.trim()); setEditingNodeName(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } if (e.key === 'Escape') { setEditingNodeName(null); } }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <span className="agentListName" onDoubleClick={(e) => { if (node.canModify) { e.stopPropagation(); setEditingNodeName(node.name); setEditingNodeLabel(node.label); } }} title={node.canModify ? 'Double-click to rename' : undefined}>{node.label}</span>
                    )}
                    <span className="agentListId">{node.name}{!node.manual ? ' · auto' : ''}</span>
                  </span>
                  <span className={`agentListStatus ${node.online ? 'running' : ''}`}>{node.online ? '●' : '○'}</span>
                  {node.canModify && (
                    <span className="nodeActionBtn" onClick={(e) => { e.stopPropagation(); setRelayAgentNode(node.name); setNewRelayAgentForm({ id: '', name: '', cwd: defaultCwd }); setShowAddRelayAgent(true); }} title="Add agent on this node">＋</span>
                  )}
                  {node.canModify && (
                    <span className="nodeRemoveBtn" onClick={(e) => { e.stopPropagation(); handleRemoveNode(node.name); }} title="Remove node">✕</span>
                  )}
                </button>
              ))}
              {nodesData.length === 0 && (
                <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
                  {nodesLoading ? 'Checking nodes...' : 'No nodes configured'}
                </div>
              )}
            </div>

            {/* Add node form */}
            {showAddNode && (
              <div className="nodeAddForm">
                <div className="nodeAddFormTitle">Add Node</div>
                <input className="nodeAddInput" placeholder="Connection name (e.g. cpc-team-vm1)" value={newNodeForm.name} onChange={(e) => setNewNodeForm(f => ({ ...f, name: e.target.value }))} />
                <input className="nodeAddInput" placeholder="Display label (optional)" value={newNodeForm.label} onChange={(e) => setNewNodeForm(f => ({ ...f, label: e.target.value }))} />
                <div className="nodeAddActions">
                  <button className="ghostButton nodeAddBtn" onClick={handleAddNode} disabled={addNodeLoading || !newNodeForm.name.trim()}>
                    {addNodeLoading ? '...' : 'Add'}
                  </button>
                  <button className="ghostButton nodeAddBtn" onClick={() => { setShowAddNode(false); setNewNodeForm({ name: '', label: '' }); }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </aside>
        )}

      </div>


      {/* ── Setup script modal ── */}
      {showSetupScript && (
        <div className="modalOverlay">
          <div className="modal setupScriptModal">
            <h2>🖥️ Node Setup Kit</h2>
            <p className="setupScriptDesc">
              Download the setup kit and run it on your devbox to connect it as a node.
              It includes <code>setup-node.ps1</code> and <code>relay-listener.js</code>.
            </p>
            <div className="setupScriptSteps">
              <div className="setupScriptStep">
                <span className="setupStepNum">1</span>
                <span>Download and extract the zip</span>
              </div>
              <div className="setupScriptStep">
                <span className="setupStepNum">2</span>
                <span>Open PowerShell in the extracted folder</span>
              </div>
              <div className="setupScriptStep">
                <span className="setupStepNum">3</span>
                <span>Run: <code>.\setup-node.ps1</code></span>
              </div>
              <div className="setupScriptStep">
                <span className="setupStepNum">4</span>
                <span>The node appears here automatically</span>
              </div>
            </div>
            <div className="setupScriptNote">
              <strong>Prerequisites:</strong> Node.js, GitHub Copilot CLI, Azure CLI (logged in)
            </div>
            <div className="setupScriptActions">
              <button className="ghostButton setupDownloadBtn" onClick={() => downloadSetupZip()}>
                📦 Download copilot-node-setup.zip
              </button>
              <button className="ghostButton" onClick={() => setShowSetupScript(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add relay agent modal ── */}
      {showAddRelayAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>➕ Add Agent on <code>{relayAgentNode}</code></h2>
            <label>
              <span>Agent ID</span>
              <input value={newRelayAgentForm.id} onChange={(e) => setNewRelayAgentForm(f => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Agent Name</span>
              <input value={newRelayAgentForm.name} onChange={(e) => setNewRelayAgentForm(f => ({ ...f, name: e.target.value }))} placeholder="My Remote Agent" />
              <span className="fieldHint">Display name for the agent</span>
            </label>
            <label>
              <span>Working Directory (on the remote node)</span>
              <input value={newRelayAgentForm.cwd} onChange={(e) => setNewRelayAgentForm(f => ({ ...f, cwd: e.target.value }))} placeholder="/home/user/project or C:\Repos\MyProject" />
              <span className="fieldHint">The cwd the copilot agent runs in on that node</span>
            </label>
            <div className="modalActions">
              <button onClick={() => void createRelayAgent()} disabled={addAgentLoading || !newRelayAgentForm.id.trim()}>
                {addAgentLoading ? 'Creating...' : 'Create Relay Agent'}
              </button>
              <button className="secondary" onClick={() => setShowAddRelayAgent(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add remote agent modal (from agents panel) ── */}
      {showAddRemoteAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>🌐 Add Agent from Remote Node</h2>
            <label>
              <span>Agent ID</span>
              <input value={newRemoteAgentForm.id} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Agent Name</span>
              <input value={newRemoteAgentForm.name} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, name: e.target.value }))} placeholder="My Remote Agent" />
              <span className="fieldHint">Display name for the agent</span>
            </label>
            <label>
              <span>Node</span>
              <select value={newRemoteAgentForm.nodeName} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, nodeName: e.target.value }))} className="remoteAgentSelect">
                <option value="">— Select a node —</option>
                {nodesData.map(n => (
                  <option key={n.name} value={n.name}>{n.label} ({n.name}){n.online ? '' : ' · offline'}</option>
                ))}
              </select>
              <span className="fieldHint">The remote node to run the agent on</span>
            </label>
            <label>
              <span>Working Directory (on the remote node)</span>
              <input value={newRemoteAgentForm.cwd} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, cwd: e.target.value }))} placeholder="/home/user/project or C:\Repos\MyProject" />
              <span className="fieldHint">The cwd the copilot agent runs in on that node</span>
            </label>
            <div className="modalActions">
              <button onClick={() => void createRemoteAgent()} disabled={addAgentLoading || !newRemoteAgentForm.id.trim() || !newRemoteAgentForm.nodeName}>
                {addAgentLoading ? 'Creating...' : 'Create Remote Agent'}
              </button>
              <button className="secondary" onClick={() => setShowAddRemoteAgent(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Share link dialog ── */}
      {shareDialog && (
        <div className="modalOverlay">
          <div className={`modal shareLinkModal ${shareDialog.variant}`} role="dialog" aria-modal="true" aria-labelledby="shareDialogTitle" onClick={(e) => e.stopPropagation()}>
            <h2 id="shareDialogTitle">{shareDialog.title}</h2>
            {shareDialog.url ? (
              <>
                <p className="shareDialogText">Anyone with this link can view the shared conversation.</p>
                <input
                  className="shareLinkInput"
                  readOnly
                  value={shareDialog.url}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </>
            ) : (
              <p className="shareDialogText">{shareDialog.detail}</p>
            )}
            {shareDialog.detail && shareDialog.url ? <p className="shareDialogStatus">{shareDialog.detail}</p> : null}
            <div className="modalActions">
              {shareDialog.url ? (
                <button type="button" onClick={() => void copyShareDialogLink()}>{shareDialog.copied ? 'Copied' : 'Copy'}</button>
              ) : null}
              <button type="button" className="secondary" onClick={() => setShareDialog(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Status bar ── */}
      <footer className="statusBar">
        <div className="statusGroup">
          <span className={`statusDot ${agents.length > 0 ? 'connected' : ''}`} />
          <span>{agents.length} agent{agents.length !== 1 ? 's' : ''} configured</span>
        </div>
        <span>{messages.filter((m) => m.type === 'user').length} messages</span>
      </footer>

      {/* ── Agent settings modal (admin or owner) ── */}
      {showAgentSettings && settingsAgentConfig && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>⚙️ {settingsAgentConfig.name}</h2>
            <label>
              <span>Agent ID</span>
              <input value={settingsAgentConfig.id} disabled style={{ opacity: 0.6 }} />
              <span className="fieldHint">Unique identifier (read-only)</span>
            </label>
            <label>
              <span>Name</span>
              <input value={settingsAgentConfig.name} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, name: e.target.value } : c)} />
            </label>
            {settingsAgentConfig.relay ? (
              <>
                <label>
                  <span>Node</span>
                  <input value={settingsAgentConfig.relayConnectionName || ''} disabled style={{ opacity: 0.6 }} />
                  <span className="fieldHint">Remote node this agent runs on</span>
                </label>
                <label>
                  <span>Working Directory (on the remote node)</span>
                  <input value={settingsAgentConfig.cwd} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, cwd: e.target.value } : c)} />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>Command</span>
                  <input value={settingsAgentConfig.command} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, command: e.target.value } : c)} />
                  <span className="fieldHint">Path to the ACP executable</span>
                </label>
                <label>
                  <span>Arguments</span>
                  <input value={(settingsAgentConfig.args || []).join(' ')} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, args: e.target.value.split(/\s+/).filter(Boolean) } : c)} />
                  <span className="fieldHint">Space-separated args (e.g. --acp --yolo)</span>
                </label>
                <label>
                  <span>Working Directory</span>
                  <input value={settingsAgentConfig.cwd} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, cwd: e.target.value } : c)} />
                </label>
                <label className="checkboxLabel">
                  <input type="checkbox" checked={settingsAgentConfig.yolo} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, yolo: e.target.checked } : c)} />
                  <span>YOLO mode (auto-approve)</span>
                </label>
              </>
            )}
            {/* Access Control */}
            <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '12px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '13px', color: '#8a90a2' }}>🔐 Access Control</h3>
              <label className="checkboxLabel" style={{ marginBottom: '8px' }}>
                <input type="checkbox" checked={!!settingsAgentConfig.public} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, public: e.target.checked } : c)} />
                <span>Public (anyone can talk to this agent)</span>
              </label>
              {!settingsAgentConfig.public && (
                <>
                  <p style={{ fontSize: '12px', color: '#666', margin: '0 0 8px' }}>Only listed users (and admins) can talk to this agent.</p>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                    <input
                      value={newAccessEmail}
                      onChange={(e) => setNewAccessEmail(e.target.value)}
                      placeholder="user@email.com"
                      style={{ flex: 1, fontSize: '12px' }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addAccess(); } }}
                    />
                    <button onClick={() => void addAccess()} disabled={!newAccessEmail.trim()} style={{ fontSize: '12px', padding: '4px 10px' }}>Grant</button>
              </div>
              {agentAccessList.length > 0 ? (
                <div style={{ maxHeight: '120px', overflowY: 'auto', fontSize: '12px' }}>
                  {agentAccessList.map((entry) => (
                    <div key={entry.email} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span>{entry.email}</span>
                      <button onClick={() => void removeAccess(entry.email)} style={{ fontSize: '11px', padding: '2px 6px', background: 'transparent', color: '#e55', border: '1px solid #e55', borderRadius: '3px', cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: '#666', fontStyle: 'italic' }}>No users granted access yet. Only the owner and admins can talk to this agent.</div>
              )}
                </>
              )}
            </div>
            <div className="modalActions">
              <button onClick={() => void saveAgentSettings()} disabled={agentSettingsLoading}>{agentSettingsLoading ? 'Saving...' : 'Save'}</button>
              <button className="secondary" onClick={() => setShowAgentSettings(false)}>Cancel</button>
              <button className="danger" style={{ marginLeft: 'auto' }} onClick={() => settingsAgentId && void deleteAgent(settingsAgentId, settingsAgentConfig.name)} disabled={agentSettingsLoading}>🗑️ Delete</button>
            </div>
          </div>
        </div>
      )}

      {showAgentSettings && !settingsAgentConfig && agentSettingsLoading && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <div style={{ textAlign: 'center', padding: '20px', color: '#8a90a2' }}>Loading...</div>
          </div>
        </div>
      )}

      {/* ── Add agent modal ── */}
      {showAddAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>➕ Add New Agent</h2>
            <label>
              <span>Agent ID</span>
              <input value={newAgentForm.id} onChange={(e) => setNewAgentForm((f) => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Display Name</span>
              <input value={newAgentForm.name} onChange={(e) => setNewAgentForm((f) => ({ ...f, name: e.target.value }))} placeholder="My Agent" />
            </label>
            <label>
              <span>Command</span>
              <input value={newAgentForm.command} onChange={(e) => setNewAgentForm((f) => ({ ...f, command: e.target.value }))} placeholder="copilot.exe" />
              <span className="fieldHint">Path to the ACP executable</span>
            </label>
            <label>
              <span>Arguments</span>
              <input value={newAgentForm.args} onChange={(e) => setNewAgentForm((f) => ({ ...f, args: e.target.value }))} placeholder="--acp" />
              <span className="fieldHint">Space-separated args</span>
            </label>
            <label>
              <span>Working Directory</span>
              <input value={newAgentForm.cwd} onChange={(e) => setNewAgentForm((f) => ({ ...f, cwd: e.target.value }))} placeholder="C:\path\to\project" />
            </label>
            <label className="checkboxLabel">
              <input type="checkbox" checked={newAgentForm.yolo} onChange={(e) => setNewAgentForm((f) => ({ ...f, yolo: e.target.checked }))} />
              <span>YOLO mode (auto-approve)</span>
            </label>
            <div className="modalActions">
              <button onClick={() => void createAgent()} disabled={addAgentLoading || !newAgentForm.id.trim()}>
                {addAgentLoading ? 'Creating...' : 'Create Agent'}
              </button>
              <button className="secondary" onClick={() => setShowAddAgent(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {lightboxImage && (
        <div className="lightboxOverlay" onClick={() => setLightboxImage(null)}>
          <img src={lightboxImage} className="lightboxImg" alt="Full size preview" onClick={(e) => e.stopPropagation()} />
          <button className="lightboxClose" onClick={() => setLightboxImage(null)} aria-label="Close">×</button>
        </div>
      )}

      <style jsx>{`
        .page {
          height: 100vh;
          min-height: 100vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          background: var(--bg-accent);
          color: var(--text);
          transition: background 220ms ease, color 220ms ease;
        }
        .header {
          position: relative;
          z-index: 10;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          padding: 16px 24px;
          border-bottom: 1px solid var(--border);
          background: var(--header-bg);
          backdrop-filter: blur(18px);
          box-shadow: var(--shadow);
        }
        .headerLeft {
          display: flex;
          align-items: center;
          gap: 14px;
          min-width: 0;
        }
        .headerRight {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        h1 {
          margin: 0;
          font-size: 20px;
          color: var(--accent);
          letter-spacing: -0.03em;
        }
        .userChip {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px 4px 4px;
          border-radius: 20px;
          background: var(--panel-strong);
          border: 1px solid var(--border);
          font-size: 12px;
          color: var(--text-soft);
        }
        .userAvatar {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background: var(--accent);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 700;
        }
        .userName {
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .logoutBtn {
          background: none;
          border: none;
          color: var(--muted);
          cursor: pointer;
          padding: 2px;
          font-size: 14px;
          line-height: 1;
          transition: color 150ms;
        }
        .logoutBtn:hover {
          color: var(--accent);
        }
        .themeMenuWrap {
          position: relative;
        }
        .themeMenuButton {
          min-width: unset;
          padding: 6px 10px;
        }
        .themeDropdown {
          position: absolute;
          top: calc(100% + 10px);
          right: 0;
          z-index: 100;
          min-width: 220px;
          padding: 8px;
          border-radius: 16px;
          border: 1px solid var(--border);
          background: var(--panel-strong);
          box-shadow: var(--shadow);
          display: grid;
          gap: 6px;
          z-index: 20;
        }
        .themeOption {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          transition: all 160ms ease;
        }
        .themeOption:hover {
          background: var(--accent-soft);
          color: var(--text);
          border-color: var(--border);
        }
        .activeThemeOption {
          background: linear-gradient(135deg, var(--accent-soft), var(--accent-strong));
          color: var(--text);
          border-color: var(--border-strong);
        }
        .themeOptionMain {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .themeChipEmoji {
          font-size: 14px;
          line-height: 1;
        }
        .themeCheck {
          color: var(--accent);
          font-weight: 700;
        }
        .mobileOnlyButton {
          display: none;
        }
        .mobilePanelBackdrop {
          display: none;
        }
        .ghostButton,
        .inputArea button,
        .modalActions button,
        .mentionItem {
          cursor: pointer;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--text);
          border-radius: 12px;
          transition: all 160ms ease;
        }
        .ghostButton {
          padding: 10px 14px;
        }
        .ghostButton:hover,
        .mentionItem:hover,
        .inputArea button:hover,
        .modalActions button:hover {
          border-color: var(--border-strong);
          background: var(--accent-soft);
        }
        .activeGhost {
          color: var(--accent) !important;
          border-color: var(--border-strong) !important;
          background: linear-gradient(135deg, var(--accent-soft), var(--accent-strong)) !important;
        }
        .chatLayout {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: grid;
          grid-template-columns: var(--sidebar-width, 280px) 4px minmax(0, 1fr);
          transition: grid-template-columns 0.15s ease;
        }
        .chatLayout.agentsSidebarOpen {
          grid-template-columns: var(--sidebar-width, 280px) 4px minmax(0, 1fr) 260px;
        }
        .chatLayout.sidebarCollapsed {
          grid-template-columns: 76px minmax(0, 1fr);
        }
        .chatLayout.sidebarCollapsed.agentsSidebarOpen {
          grid-template-columns: 76px minmax(0, 1fr) 260px;
        }
        .participantsSidebar {
          border-right: none;
          background: var(--panel-bg);
          backdrop-filter: blur(16px);
          padding: 16px 12px;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
        }
        .sidebarResizeHandle {
          width: 4px;
          cursor: col-resize;
          background: transparent;
          border-right: 1px solid var(--border);
          transition: background 0.15s;
          z-index: 2;
        }
        .sidebarResizeHandle:hover,
        .sidebarResizeHandle:active {
          background: var(--accent);
          border-right-color: var(--accent);
        }
        .participantsHeader {
          color: var(--text);
          font-weight: 700;
          margin-bottom: 12px;
          padding: 0 8px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .sidebarExpandBtn {
          width: 100%;
          padding: 8px;
          border: none;
          background: transparent;
          color: var(--text);
          font-size: 20px;
          cursor: pointer;
          border-radius: 8px;
          transition: background 160ms ease;
        }
        .sidebarExpandBtn:hover {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .participantsHeaderLabel {
          cursor: pointer;
          font-size: 13px;
          user-select: none;
          transition: color 160ms ease;
        }
        .participantsHeaderLabel:hover {
          color: var(--accent);
        }
        .leftSidebarTabs {
          display: flex;
          gap: 2px;
          flex: 1;
        }
        .leftSidebarTab {
          flex: 1;
          padding: 6px 8px;
          border: none;
          background: transparent;
          color: var(--text-soft);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          border-radius: 8px;
          transition: all 0.15s ease;
        }
        .leftSidebarTab:hover {
          background: var(--accent-soft);
          color: var(--text);
        }
        .leftSidebarTab.active {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .mdFilesTab {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-height: 0;
          flex: 1;
        }
        .mdFilesTab .remoteAgentSelect {
          font-size: 12px;
          padding: 8px 10px;
        }
        .mdFilesList {
          overflow-y: auto;
          min-height: 0;
        }
        .mdTree {
          font-size: 12px;
        }
        .mdTreeDir, .mdTreeFile {
          display: flex;
          align-items: center;
          gap: 4px;
          width: 100%;
          padding: 4px 8px;
          border: none;
          background: transparent;
          color: var(--text);
          font-size: 12px;
          cursor: pointer;
          border-radius: 6px;
          text-align: left;
          white-space: nowrap;
        }
        .mdTreeLabel {
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }
        .mdTreeDir:hover, .mdTreeFile:hover {
          background: var(--accent-soft);
        }
        .mdTreeFile.active {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .mdTreeArrow {
          font-size: 14px;
          width: 16px;
          flex-shrink: 0;
          color: var(--text-soft);
        }
        .mdDiffToggle {
          margin-top: 4px;
          padding: 3px 8px;
          font-size: 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          width: 100%;
          text-align: center;
        }
        .mdDiffToggle:hover { background: var(--hover-bg); }
        .mdDiffToggle.active {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
        }
        .mdTreeDirIcon, .mdTreeFileIcon {
          font-size: 12px;
          flex-shrink: 0;
        }
        .mdTreeLabel {
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .participantsList {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 8px;
          min-width: 0;
        }
        .chatAgentFilterRow {
          display: flex;
          gap: 4px;
          padding: 0 0 6px;
          align-items: center;
          flex-shrink: 0;
        }
        .chatAgentFilterSelect {
          flex: 1 1 auto;
          min-width: 0;
          padding: 6px 10px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--text);
          font-size: 12px;
          cursor: pointer;
          outline: none;
          transition: border-color 0.15s, background 0.15s;
        }
        .chatAgentFilterSelect:hover {
          border-color: var(--border-strong);
        }
        .chatAgentFilterSelect:focus {
          border-color: var(--accent);
        }
        .newChatRow {
          display: flex;
          gap: 6px;
        }
        .newChatButton {
          flex: 1;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px dashed var(--border-strong);
          background: transparent;
          color: var(--text-soft);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s;
        }
        .newChatButton:hover {
          color: var(--accent);
          background: var(--accent-soft);
        }
        .newChatButton:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .chatRenameWrap {
          flex: 1;
          padding: 6px 12px;
        }
        .chatRenameInput {
          width: 100%;
          padding: 6px 8px;
          border: 1px solid var(--accent);
          border-radius: 8px;
          background: var(--bg);
          color: var(--text);
          font-size: 12px;
          outline: none;
        }
        .chatHistoryItem {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          text-align: left;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          transition: all 0.12s ease;
        }
        .chatHistoryItem:hover,
        .chatHistoryItem.active {
          color: var(--text);
        }
        .chatHistoryIcon { font-size: 16px; flex: 0 0 auto; }
        .chatHistoryText { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
        .chatHistoryName { font-size: 13px; font-weight: 600; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
        .chatHistoryMetaRow { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .chatHistoryMeta { font-size: 11px; color: var(--muted); }
        .chatStatusBadge {
          display: inline-flex;
          align-items: center;
          max-width: 96px;
          padding: 1px 6px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          line-height: 1.4;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .chatStatusBadge.running { color: var(--accent); background: var(--accent-soft); }
        .chatStatusBadge.done { color: var(--success); background: rgba(134, 239, 172, 0.12); }
        .chatStatusBadge.error { color: var(--danger); background: rgba(239, 68, 68, 0.12); }
        .chatHistoryRow {
          display: flex;
          align-items: center;
          gap: 2px;
          border-radius: 14px;
          border: 1px solid transparent;
          position: relative;
          min-width: 0;
          transition: all 0.12s ease;
        }
        .chatHistoryRow .chatHistoryItem { flex: 1; min-width: 0; }
        .chatHistoryRow:hover,
        .chatHistoryRow:focus-within {
          background: var(--panel-soft);
          border-color: var(--border);
          color: var(--text);
        }
        .chatHistoryRow.active { background: var(--panel-soft); border-color: var(--border-strong); box-shadow: inset 0 0 0 1px var(--accent-soft); border-radius: 14px; }
        .chatHistoryRow:hover .chatHistoryItem,
        .chatHistoryRow:focus-within .chatHistoryItem,
        .chatHistoryRow.active .chatHistoryItem { border-color: transparent; box-shadow: none; background: transparent; }
        .chatActionsWrap {
          flex: 0 0 auto;
          position: relative;
          margin-right: 4px;
        }
        .chatMoreBtn {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          cursor: pointer;
          font-size: 14px;
          font-weight: 700;
          line-height: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.12s ease;
          opacity: 0;
          pointer-events: none;
        }
        .chatHistoryRow:hover .chatMoreBtn,
        .chatHistoryRow:focus-within .chatMoreBtn,
        .chatMoreBtn.active {
          opacity: 1;
          pointer-events: auto;
        }
        .chatMoreBtn:hover,
        .chatMoreBtn.active {
          color: var(--accent);
          background: var(--accent-soft);
          border-color: var(--border);
        }
        .chatActionsMenu {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          min-width: 132px;
          padding: 6px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--panel-bg);
          box-shadow: 0 14px 30px rgba(0, 0, 0, 0.18);
          z-index: 30;
        }
        .chatActionItem {
          width: 100%;
          padding: 8px 10px;
          border: 0;
          border-radius: 8px;
          background: transparent;
          color: var(--text);
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          text-align: left;
          transition: all 0.12s ease;
        }
        .chatActionItem:hover,
        .chatActionItem:focus-visible {
          background: var(--accent-soft);
          color: var(--accent);
          outline: none;
        }
        .chatActionItem.danger {
          color: #d53f3f;
        }
        .chatActionItem.danger:hover,
        .chatActionItem.danger:focus-visible {
          color: #e53e3e;
          background: rgba(229, 62, 62, 0.1);
        }
        }
        .agentsSidebar {
          border-left: 1px solid var(--border);
          background: var(--panel-bg);
          backdrop-filter: blur(16px);
          min-height: 0;
          overflow: hidden;
          padding: 0;
          display: flex;
          flex-direction: column;
        }
        .agentsSidebarHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 12px 8px;
          color: var(--text);
          font-weight: 700;
          font-size: 14px;
        }
        .sidebarToggle {
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--text-soft);
          border-radius: 8px;
          font-size: 14px;
          cursor: pointer;
          transition: all 0.12s ease;
          padding: 0;
        }
        .sidebarToggle:hover {
          border-color: var(--border-strong);
          background: var(--accent-soft);
          color: var(--text);
        }
        .agentsSidebarSection {
          padding: 4px 12px 12px;
          flex: 1;
          overflow-y: auto;
          min-height: 0;
        }
        .agentListItem {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          text-align: left;
          padding: 9px 10px;
          border-radius: 12px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          transition: all 0.12s ease;
          margin-bottom: 4px;
        }
        .agentListItem:hover {
          background: var(--panel-soft);
          border-color: var(--border);
          color: var(--text);
        }
        .agentListAvatar {
          width: 34px;
          height: 34px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--avatar-bg, linear-gradient(135deg, var(--accent), var(--accent-2)));
          color: var(--avatar-text, #fff);
          font-weight: 700;
          font-size: 13px;
          flex: 0 0 auto;
          box-shadow: 0 8px 18px rgba(0,0,0,0.18);
        }
        .agentListInfo { display: flex; flex-direction: column; min-width: 0; flex: 1; }
        .agentListName { font-size: 13px; font-weight: 600; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .agentListId { font-size: 11px; color: var(--muted); }
        .agentListStatus { font-size: 12px; color: var(--muted); flex: 0 0 auto; }
        .agentListStatus.running { color: var(--success); }
        .nodeAvatar[data-online] { background: var(--avatar-bg, linear-gradient(135deg, var(--accent), var(--accent-2))); }
        .nodeAvatar:not([data-online]) { background: linear-gradient(135deg, #718096, #4a5568) !important; }
        .nodeRemoveBtn {
          font-size: 11px;
          color: var(--muted);
          cursor: pointer;
          flex: 0 0 auto;
          padding: 2px 4px;
          border-radius: 4px;
          transition: all 0.12s ease;
          opacity: 0;
        }
        .nodeActionBtn {
          font-size: 13px;
          color: var(--muted);
          cursor: pointer;
          flex: 0 0 auto;
          padding: 2px 4px;
          border-radius: 4px;
          transition: all 0.12s ease;
          opacity: 0;
        }
        .agentListItem:hover .nodeRemoveBtn,
        .agentListItem:hover .nodeActionBtn { opacity: 1; }
        .nodeRemoveBtn:hover { color: #e53e3e; background: rgba(229,62,62,0.1); }
        .nodeActionBtn:hover { color: var(--accent); background: rgba(99,102,241,0.1); }
        .nodeEditInput {
          font-size: 13px;
          font-weight: 600;
          background: var(--bg);
          border: 1px solid var(--accent);
          border-radius: 4px;
          color: var(--text);
          padding: 2px 6px;
          width: 100%;
          outline: none;
        }
        .nodeAddForm {
          padding: 12px;
          border-top: 1px solid var(--border);
        }
        .nodeAddFormTitle {
          font-size: 13px;
          font-weight: 600;
          margin-bottom: 8px;
          color: var(--text);
        }
        .nodeAddInput {
          width: 100%;
          padding: 6px 8px;
          margin-bottom: 6px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--panel-bg);
          color: var(--text);
          font-size: 12px;
          outline: none;
          transition: border-color 0.15s ease;
        }
        .nodeAddInput:focus { border-color: var(--accent); }
        .nodeAddActions { display: flex; gap: 6px; margin-top: 4px; }
        .nodeAddBtn { font-size: 12px !important; padding: 4px 10px !important; }
        .nodeAddMenu {
          position: absolute;
          top: 100%;
          right: 0;
          z-index: 100;
          background: var(--panel-bg);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.2);
          padding: 4px;
          min-width: 200px;
          backdrop-filter: blur(16px);
        }
        .nodeAddMenuItem {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 8px 12px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--text-soft);
          font-size: 13px;
          cursor: pointer;
          text-align: left;
          transition: all 0.12s ease;
        }
        .nodeAddMenuItem:hover {
          background: var(--panel-soft);
          color: var(--text);
        }
        .setupScriptModal {
          max-width: 480px;
        }
        .setupScriptDesc {
          font-size: 13px;
          color: var(--text-soft);
          margin: 0 0 16px;
          line-height: 1.5;
        }
        .setupScriptSteps {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-bottom: 20px;
        }
        .setupScriptStep {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          color: var(--text);
        }
        .setupScriptStep code {
          background: var(--panel-soft);
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 12px;
          color: var(--accent);
        }
        .setupStepNum {
          width: 24px;
          height: 24px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          color: #fff;
          font-size: 12px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }
        .setupScriptActions {
          display: flex;
          gap: 8px;
        }
        .setupScriptNote {
          font-size: 12px;
          color: var(--muted);
          background: var(--panel-soft);
          padding: 8px 12px;
          border-radius: 8px;
          margin-bottom: 16px;
        }
        .setupScriptNote code {
          background: var(--panel-soft);
          padding: 1px 4px;
          border-radius: 3px;
          font-size: 11px;
        }
        .setupDownloadBtn {
          background: linear-gradient(135deg, var(--accent-soft), var(--accent-strong)) !important;
          border-color: var(--accent) !important;
          color: var(--text) !important;
        }
        .chatMain {
          min-width: 0;
          min-height: 0;
          height: 100%;
          overflow: hidden;
          display: grid;
          grid-template-rows: minmax(0, 1fr) auto;
        }
        .chatContainer {
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .emptyHomepage {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 0;
        }
        .emptyHomepageContent {
          text-align: center;
          max-width: 400px;
          padding: 40px 24px;
        }
        .emptyHomepageLogo {
          font-size: 56px;
          margin-bottom: 16px;
          opacity: 0.7;
        }
        .emptyHomepageTitle {
          font-size: 24px;
          font-weight: 700;
          color: var(--text);
          margin: 0 0 8px;
        }
        .emptyHomepageSubtitle {
          font-size: 14px;
          color: var(--text-soft);
          margin: 0 0 28px;
        }
        .emptyHomepageNewChat {
          padding: 12px 28px;
          border-radius: 12px;
          border: 1px dashed var(--border-strong);
          background: transparent;
          color: var(--accent);
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
        }
        .emptyHomepageNewChat:hover {
          background: var(--accent-soft);
          border-color: var(--accent);
        }
        .chatInputDock {
          position: relative;
          border-top: 1px solid var(--border);
          background: var(--header-bg);
          backdrop-filter: blur(18px);
          padding: 16px 24px;
          min-width: 0;
        }
        .message {
          max-width: 80%;
          padding: 14px 16px;
          border-radius: 18px;
          line-height: 1.5;
          font-size: 13.5px;
          border: 1px solid var(--border);
          box-shadow: 0 14px 30px rgba(0,0,0,0.08);
          position: relative;
        }
        .messageActions {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 10px;
        }
        .messageCopyButton,
        :global(.userSendFailureButton) {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--accent);
          border-radius: 10px;
          padding: 0 10px;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          transition: all 160ms ease;
        }
        .messageCopyButton:hover,
        :global(.userSendFailureButton:hover) {
          border-color: var(--border-strong);
          background: var(--accent-soft);
        }
        .message.user {
          align-self: flex-end;
          background: var(--message-user);
          border-color: var(--border-strong);
        }
        .message.agent,
        .message.system {
          align-self: flex-start;
          background: var(--message-agent);
          border-left: 3px solid var(--accent);
        }
        .message.summaryCard {
          border-left: 3px solid var(--accent-2);
          box-shadow: 0 0 0 1px var(--summary-glow), 0 14px 34px var(--summary-glow);
        }
        .messageHeader {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          font-size: 12px;
          color: var(--text-soft);
          margin-bottom: 8px;
        }
        .messageMetaTag {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 999px;
          background: var(--panel-soft);
          border: 1px solid var(--border);
          color: var(--text-soft);
        }
        .agentName {
          font-weight: 700;
          color: var(--accent);
        }
        .messageContent {
          word-break: break-word;
        }
        .markdownBody :global(*) { max-width: 100%; }
        .markdownBody :global(p) { margin: 0 0 0.4em; }
        .markdownBody :global(p:last-child) { margin-bottom: 0; }
        .markdownBody :global(ul),
        .markdownBody :global(ol) {
          margin: 0.25em 0 0.4em;
          padding-left: 1.4em;
        }
        .markdownBody :global(ul) { list-style-type: disc; }
        .markdownBody :global(ul ul) { list-style-type: circle; margin: 0.1em 0; }
        .markdownBody :global(ul ul ul) { list-style-type: square; }
        .markdownBody :global(ol) { list-style-type: decimal; }
        .markdownBody :global(ol ol) { list-style-type: lower-alpha; margin: 0.1em 0; }
        .markdownBody :global(li) {
          margin: 0.08em 0;
          padding-left: 0.2em;
          line-height: 1.45;
        }
        .markdownBody :global(li > p) { margin: 0; }
        .markdownBody :global(li > p + p) { margin-top: 0.25em; }
        .markdownBody :global(li > ul),
        .markdownBody :global(li > ol) { margin-top: 0.1em; margin-bottom: 0.1em; }
        .markdownBody :global(code) {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 0.88em;
          background: var(--code-bg);
          border: 1px solid var(--border);
          border-radius: 5px;
          padding: 0.1em 0.32em;
        }
        .markdownBody :global(pre) {
          background: var(--code-bg);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 10px 14px;
          overflow-x: auto;
          margin: 0.4em 0;
          font-size: 0.88em;
          line-height: 1.45;
        }
        .markdownBody :global(pre code) { background: transparent; border: 0; padding: 0; font-size: inherit; }
        .markdownBody :global(blockquote) {
          margin: 0.4em 0;
          padding: 0.2em 0 0.2em 0.85em;
          border-left: 3px solid var(--accent);
          color: var(--text-soft);
          font-style: italic;
        }
        .markdownBody :global(blockquote p) { margin: 0.15em 0; }
        .markdownBody :global(h1) { font-size: 1.3em; margin: 0.7em 0 0.3em; line-height: 1.25; font-weight: 700; }
        .markdownBody :global(h2) { font-size: 1.15em; margin: 0.6em 0 0.25em; line-height: 1.25; font-weight: 700; }
        .markdownBody :global(h3) { font-size: 1.05em; margin: 0.5em 0 0.2em; line-height: 1.3; font-weight: 600; }
        .markdownBody :global(h4) { font-size: 1em; margin: 0.45em 0 0.15em; line-height: 1.3; font-weight: 600; }
        .markdownBody :global(table) { width: 100%; border-collapse: collapse; margin: 0.5em 0; font-size: 0.92em; }
        .markdownBody :global(th),
        .markdownBody :global(td) { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
        .markdownBody :global(th) { background: var(--panel-soft); font-weight: 600; }
        .markdownBody :global(a) { color: var(--accent); text-decoration: none; }
        .markdownBody :global(a:hover) { text-decoration: underline; }
        .markdownBody :global(hr) { border: 0; border-top: 1px solid var(--border); margin: 0.6em 0; }
        .markdownBody :global(strong) { font-weight: 600; }
        .markdownBody :global(img) { border-radius: 8px; }
        .messageContent.collapsed {
          max-height: 220px;
          overflow: hidden;
          position: relative;
        }
        .messageContent.collapsed::after {
          content: '';
          position: absolute;
          left: 0; right: 0; bottom: 0;
          height: 64px;
          background: linear-gradient(to bottom, rgba(0, 0, 0, 0), var(--message-agent));
          pointer-events: none;
        }
        .collapseToggle {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          margin-top: 0;
          padding: 0 10px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--accent);
          cursor: pointer;
          font-size: 12px;
          line-height: 1;
          transition: all 160ms ease;
        }
        .collapseToggle:hover { border-color: var(--border-strong); background: var(--accent-soft); }
        .messageContent.pending { opacity: 0.78; }
        :global(.userSendFailure) {
          display: flex;
          justify-content: flex-end;
          margin-top: 8px;
        }
        :global(.userSendFailurePill) {
          display: inline-flex;
          align-items: stretch;
          border: 1px solid color-mix(in srgb, var(--danger) 55%, transparent);
          background: color-mix(in srgb, var(--danger) 10%, var(--panel-soft));
          border-radius: 12px;
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
        }
        :global(.userSendFailureStatus) {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 0 10px;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
          color: var(--danger);
          letter-spacing: 0.01em;
          cursor: help;
          user-select: none;
        }
        :global(.userSendFailureStatus::before) {
          content: '⚠';
          font-size: 13px;
          line-height: 1;
        }
        :global(.userSendFailureButton) {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 30px;
          padding: 0 12px;
          border: none;
          border-left: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
          border-radius: 0;
          background: transparent;
          color: var(--danger);
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
          cursor: pointer;
          transition: background 160ms ease, color 160ms ease;
        }
        :global(.userSendFailureButton::before) {
          content: '↻';
          font-size: 14px;
          line-height: 1;
          display: inline-block;
        }
        :global(.userSendFailureButton:hover) {
          background: color-mix(in srgb, var(--danger) 18%, transparent);
        }
        :global(.userSendFailureButton:focus-visible) {
          outline: 2px solid var(--danger);
          outline-offset: -2px;
        }
        :global(.userSendFailureButton:disabled) {
          opacity: 0.5;
          cursor: not-allowed;
        }
        :global(.userSendFailureButton:disabled:hover) {
          background: transparent;
        }
        .partsStream { display: flex; flex-direction: column; gap: 6px; }
        .partsStream.collapsed { max-height: 300px; overflow: hidden; position: relative; }
        .partsStream.collapsed::after { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(transparent, var(--message-agent)); pointer-events: none; }
        :global(.agentUserRequestCard) {
          margin-top: 10px;
          padding: 12px;
          border: 1px solid rgba(88, 166, 255, 0.35);
          border-radius: 10px;
          background: rgba(88, 166, 255, 0.08);
        }
        :global(.agentUserRequestHeader) {
          font-size: 12px;
          font-weight: 700;
          color: var(--accent);
          margin-bottom: 6px;
        }
        :global(.agentUserRequestPrompt) {
          color: var(--text);
          line-height: 1.4;
        }
        :global(.agentUserRequestActions),
        :global(.agentUserRequestForm) {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }
        :global(.agentUserRequestForm.structured) {
          flex-direction: column;
          align-items: stretch;
        }
        :global(.agentUserRequestQuestions) {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        :global(.agentUserRequestQuestion) {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        :global(.agentUserRequestQuestionLabel) {
          font-size: 12px;
          font-weight: 600;
          color: var(--text);
        }
        :global(.agentUserRequestQuestionMessage) {
          color: var(--text-soft);
          font-size: 12px;
          line-height: 1.35;
        }
        :global(.agentUserRequestButton) {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--accent);
          border-radius: 10px;
          padding: 0 10px;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          transition: all 160ms ease;
        }
        :global(.agentUserRequestButton):hover:not(:disabled) {
          border-color: var(--border-strong);
          background: var(--accent-soft);
        }
        :global(.agentUserRequestButton):disabled,
        :global(.agentUserRequestInput):disabled,
        :global(.agentUserRequestSelect):disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        :global(.agentUserRequestInput),
        :global(.agentUserRequestSelect) {
          flex: 1;
          min-width: 180px;
          padding: 6px 8px;
          border: 1px solid var(--border);
          border-radius: 7px;
          background: var(--input-bg);
          color: var(--text);
        }
        :global(.agentUserRequestSelect) {
          min-height: 32px;
        }
        :global(.agentUserRequestError) {
          margin-top: 10px;
          color: #fca5a5;
          font-size: 12px;
        }
        .thinkingPart { background: rgba(127, 127, 127, 0.08); border-left: 3px solid var(--border-strong); border-radius: 8px; overflow: hidden; }
        .thinkingPartText { padding: 6px 10px; font-size: 0.82rem; color: var(--text-soft); white-space: pre-wrap; font-style: italic; }
        .userAnswerPart {
          align-self: stretch;
          padding: 8px 10px;
          border: 1px solid rgba(134, 239, 172, 0.28);
          border-left: 3px solid var(--success);
          border-radius: 10px;
          background: rgba(134, 239, 172, 0.08);
          color: var(--text);
          font-size: 0.9rem;
        }
        .userAnswerPart :global(p) { margin: 0 0 4px; }
        .userAnswerPart :global(p:last-child) { margin-bottom: 0; }
        .htmlFileLink { color: var(--accent); text-decoration: underline; cursor: pointer; word-break: break-all; }
        .htmlFileLink:hover { opacity: 0.85; }
        .toolCallItem { background: rgba(127,127,127,0.06); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
        .toolCallSummary { cursor: pointer; padding: 6px 10px; display: flex; align-items: center; gap: 6px; font-size: 0.82rem; color: var(--text); user-select: none; }
        .toolCallSummary.running { color: var(--accent); }
        .toolCallSummary.complete { color: var(--success); }
        .toolCallIcon { font-size: 0.9rem; }
        .toolCallName { font-family: 'Fira Code', 'Cascadia Code', monospace; font-weight: 500; }
        .toolCallDetail { margin: 0; padding: 6px 10px 8px; font-size: 0.75rem; color: var(--text-soft); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; border-top: 1px solid var(--border); background: rgba(127,127,127,0.04); }
        .toolCallResult { color: var(--success); }
        .ptyStatusBadge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          margin-bottom: 10px;
          padding: 4px 10px;
          border-radius: 999px;
          background: var(--accent-soft);
          border: 1px solid var(--border-strong);
          color: var(--accent);
          font-size: 12px;
        }
        .streamingIndicator {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
          padding: 4px 12px;
          border-radius: 999px;
          background: rgba(34, 197, 94, 0.08);
          border: 1px solid rgba(34, 197, 94, 0.2);
          color: var(--success);
          font-size: 12px;
        }
        .streamingPulse {
          width: 7px; height: 7px;
          border-radius: 999px;
          background: var(--success);
          animation: streamPulse 1.4s ease-in-out infinite;
          flex-shrink: 0;
        }
        @keyframes streamPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.35; transform: scale(0.75); }
        }
        .thinkingWrap {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          color: var(--text-soft);
          min-height: 24px;
        }
        .thinkingText { letter-spacing: 0.02em; }
        .thinkingDots { display: inline-flex; align-items: center; gap: 6px; }
        .thinkingDots span {
          width: 8px; height: 8px;
          border-radius: 999px;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 35%, transparent);
          animation: thinkingBounce 1.2s infinite ease-in-out;
        }
        .thinkingDots span:nth-child(2) { animation-delay: 0.15s; }
        .thinkingDots span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes thinkingBounce {
          0%, 80%, 100% { transform: translateY(0) scale(0.75); opacity: 0.45; }
          40% { transform: translateY(-3px) scale(1); opacity: 1; }
        }

        :global(.messageAttachments),
        :global(.attachmentTray) {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 10px;
        }
        :global(.attachmentTray) {
          margin-top: 0;
          padding: 4px 2px 0;
        }
        :global(.attachmentChip),
        :global(.messageAttachment) {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: min(100%, 340px);
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--panel-strong);
          overflow: hidden;
        }
        :global(.attachmentChip) {
          position: relative;
          min-height: 26px;
          padding: 4px 28px 4px 8px;
          background: color-mix(in srgb, var(--panel-strong) 88%, var(--accent-soft));
        }
        :global(.messageAttachment) {
          position: relative;
          padding: 6px 8px;
          overflow: visible;
        }
        :global(.attachmentThumb) {
          width: 16px;
          height: 16px;
          object-fit: cover;
          border-radius: 3px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          flex: 0 0 auto;
        }
        :global(.messageAttachmentImage) {
          width: 120px;
          height: 90px;
          object-fit: cover;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          flex: 0 0 auto;
        }
        :global(.messageAttachmentImageWrap) {
          position: relative;
          display: inline-flex;
          flex: 0 0 auto;
          outline: none;
        }
        :global(.messageAttachmentImageWrap:focus-visible .messageAttachmentImage) {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 24%, transparent);
        }
        :global(.messageAttachmentPreview) {
          position: absolute;
          left: 0;
          bottom: calc(100% + 10px);
          z-index: 40;
          display: block;
          max-width: min(72vw, 560px);
          max-height: min(70vh, 520px);
          padding: 8px;
          border: 1px solid var(--border-strong);
          border-radius: 8px;
          background: var(--panel-strong);
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.32);
          opacity: 0;
          visibility: hidden;
          pointer-events: none;
          transform: translateY(4px) scale(0.985);
          transform-origin: bottom left;
          transition: opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
        }
        .message.user :global(.messageAttachmentPreview) {
          right: 0;
          left: auto;
          transform-origin: bottom right;
        }
        :global(.messageAttachmentImageWrap:hover .messageAttachmentPreview),
        :global(.messageAttachmentImageWrap:focus-visible .messageAttachmentPreview),
        :global(.messageAttachmentImageWrap:focus-within .messageAttachmentPreview) {
          opacity: 1;
          visibility: visible;
          transform: translateY(0) scale(1);
        }
        :global(.messageAttachmentPreviewImage) {
          display: block;
          width: auto;
          height: auto;
          max-width: calc(min(72vw, 560px) - 16px);
          max-height: calc(min(70vh, 520px) - 16px);
          object-fit: contain;
          border-radius: 6px;
          background: var(--panel-soft);
        }
        :global(.attachmentFileIcon) {
          width: 16px;
          height: 16px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 2px;
          background: transparent;
          border: 0;
          color: var(--accent);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 8px;
          font-weight: 800;
          line-height: 1;
          flex: 0 0 auto;
        }
        :global(.attachmentFileIconLabel) {
          display: block;
          max-width: 16px;
          overflow: hidden;
          text-align: center;
          letter-spacing: 0;
          text-transform: uppercase;
        }
        :global(.messageAttachmentFileIcon) {
          width: 42px;
          height: 42px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          background: var(--accent-soft);
          border: 1px solid var(--border-strong);
          color: var(--accent);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 10px;
          font-weight: 800;
          line-height: 1;
          flex: 0 0 auto;
        }
        :global(.attachmentMeta) {
          display: flex;
          flex-direction: column;
          flex: 1 1 auto;
          min-width: 0;
          gap: 2px;
        }
        :global(.attachmentName) {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text);
          font-size: 13px;
          font-weight: 700;
        }
        :global(.attachmentChip .attachmentName) {
          font-size: 12px;
          font-weight: 600;
          line-height: 16px;
        }
        :global(.attachmentDetails) {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--muted);
          font-size: 11px;
        }
        :global(.attachmentRemoveButton) {
          position: absolute;
          top: 50%;
          right: 5px;
          width: 18px;
          height: 18px;
          min-width: 18px;
          padding: 0;
          border-radius: 999px;
          border: 1px solid transparent;
          background: color-mix(in srgb, var(--panel-soft) 82%, transparent);
          color: var(--text-soft);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          line-height: 1;
          transform: translateY(-50%);
        }
        :global(.attachmentRemoveButton):hover,
        :global(.attachmentRemoveButton):focus-visible {
          color: var(--danger);
          border-color: color-mix(in srgb, var(--danger) 45%, transparent);
          background: color-mix(in srgb, var(--danger) 10%, transparent);
        }
        :global(.attachmentError) {
          color: var(--danger);
          font-size: 12px;
          padding: 0 4px;
        }
        .composerStack {
          position: relative;
          width: 100%;
        }
        .mentionDropdown {
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(100% + 10px);
          background: var(--panel-strong);
          border: 1px solid var(--border);
          border-radius: 18px;
          overflow: hidden;
          box-shadow: var(--shadow);
        }
        .mentionItem {
          width: 100%;
          text-align: left;
          padding: 11px 14px;
          border-radius: 0;
          border: 0;
          border-bottom: 1px solid var(--border);
          display: flex;
          gap: 10px;
          background: var(--panel-strong);
        }
        .mentionItem.selected { background: var(--accent-soft); outline: none; }
        .mentionItem:last-child { border-bottom: 0; }
        .mentionId { color: var(--accent); font-weight: 700; }
        .mentionDesc { color: var(--muted); }
        .inputArea {
          display: block;
        }
        .composerShell {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px 12px;
          background: var(--panel-soft);
          border: 1px solid var(--border);
          border-radius: 12px;
          box-shadow: 0 10px 26px rgba(0, 0, 0, 0.06);
          transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
        }
        .composerShell:focus-within {
          border-color: var(--border-strong);
          box-shadow: 0 0 0 1px var(--accent-soft), 0 14px 30px rgba(0, 0, 0, 0.08);
          transform: translateY(-1px);
        }
        .composerShell.dragOver {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px var(--accent-soft), 0 14px 30px rgba(0, 0, 0, 0.1);
        }
        .srOnlyFileInput {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .orchPill {
          cursor: pointer;
          border-color: var(--border);
          background: transparent;
          color: var(--muted);
          transition: all 180ms cubic-bezier(0.4, 0, 0.2, 1);
        }
        .orchPill:hover {
          color: var(--accent);
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .orchPill.orchPillActive {
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          color: #fff;
          border-color: color-mix(in srgb, var(--accent) 40%, transparent);
          box-shadow: 0 3px 10px color-mix(in srgb, var(--accent) 22%, transparent);
        }
        .orchPill.orchPillActive:hover {
          filter: brightness(1.08);
        }
        .orchRoundsSelect {
          padding: 4px 8px;
          border-radius: 999px;
          border: 1px solid var(--border-strong);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: all 160ms ease;
          outline: none;
          -webkit-appearance: none;
          -moz-appearance: none;
          appearance: none;
          padding-right: 20px;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2345d7ff' opacity='0.7'/%3E%3C/svg%3E");
          background-repeat: no-repeat;
          background-position: right 7px center;
          background-size: 8px 5px;
        }
        .orchRoundsSelect:hover {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px var(--accent-soft);
        }
        .orchRoundsSelect:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 2px var(--accent-soft), 0 4px 12px color-mix(in srgb, var(--accent) 18%, transparent);
          background-color: color-mix(in srgb, var(--accent-soft) 60%, var(--panel-soft));
        }
        .orchRoundsSelect option {
          background: var(--panel-strong);
          color: var(--fg);
          padding: 6px 10px;
          font-weight: 600;
        }
        .composerRow {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          min-width: 0;
        }
        .composerTextarea {
          flex: 1;
          width: 100%;
          min-height: 24px;
          max-height: 180px;
          resize: none;
          overflow-y: hidden;
          padding: 8px 0 7px;
          margin: 0;
          background: transparent;
          border: 0;
          color: var(--text);
          outline: none;
          line-height: 1.5;
          font-size: 15px;
          font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
        }
        .composerTextarea::placeholder {
          color: var(--muted);
        }
        .composerActions,
        .targetPills {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .composerActions {
          margin-left: auto;
          flex: 0 0 auto;
        }
        .composerInlineActions {
          align-self: flex-end;
          margin-bottom: 1px;
        }
        .targetPill {
          display: inline-flex;
          align-items: center;
          padding: 5px 10px;
          border-radius: 999px;
          border: 1px solid var(--border-strong);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          line-height: 1;
          font-weight: 700;
        }
        .composerHint {
          display: none;
        }
        .attachButton {
          width: 38px;
          min-width: 38px;
          height: 38px;
          padding: 0;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--panel-strong);
          color: var(--muted);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          align-self: flex-end;
        }
        .attachButton:hover {
          color: var(--accent);
          border-color: var(--border-strong);
          background: var(--accent-soft);
        }
        .sendButton,
        .modalActions button {
          padding: 12px 18px;
        }
        .sendButton {
          width: 38px;
          min-width: 38px;
          height: 38px;
          padding: 0 !important;
          border-radius: 999px !important;
          border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent) !important;
          background: linear-gradient(135deg, var(--accent), var(--accent-2)) !important;
          color: white !important;
          box-shadow: 0 8px 18px color-mix(in srgb, var(--accent) 18%, transparent), inset 0 1px 0 rgba(255,255,255,0.22);
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          align-self: flex-end;
        }
        .sendButton:hover:not(:disabled) {
          transform: translateY(-1px);
          filter: saturate(1.04) brightness(1.03);
        }
        .sendButton:disabled {
          opacity: 0.45;
          cursor: not-allowed;
          box-shadow: none;
          filter: grayscale(0.08);
        }
        .sendButtonIcon {
          font-size: 18px;
          line-height: 1;
        }
        .stopButton {
          background: linear-gradient(135deg, var(--danger), color-mix(in srgb, var(--danger) 76%, black 24%)) !important;
          border-color: color-mix(in srgb, var(--danger) 58%, transparent) !important;
          color: #fff !important;
        }
        .stopButton:hover { filter: brightness(1.08); }
        .statusBar {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 24px;
          border-top: 1px solid var(--border);
          background: var(--header-bg);
          color: var(--text-soft);
          font-size: 12px;
          backdrop-filter: blur(18px);
        }
        .statusGroup { display: flex; align-items: center; gap: 8px; }
        .statusDot {
          width: 8px; height: 8px;
          border-radius: 999px;
          display: inline-block;
          background: var(--danger);
        }
        .statusDot.connected { background: var(--success); }
        .muted { color: var(--muted); }
        .modalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.62);
          display: grid;
          place-items: center;
          padding: 16px;
          z-index: 100;
          backdrop-filter: blur(10px);
        }
        .modal {
          width: min(520px, 100%);
          background: var(--panel-strong);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 20px;
          box-shadow: var(--shadow);
        }
        .modal h2 { margin-top: 0; color: var(--accent); }
        .modal label { display: block; margin-bottom: 14px; }
        .modal label span { display: block; margin-bottom: 6px; color: var(--text-soft); }
        .modal input {
          width: 100%;
          padding: 12px 14px;
          background: var(--input-bg);
          border: 1px solid var(--border);
          border-radius: 12px;
          color: var(--text);
        }
        .modal select {
          width: 100%;
          padding: 12px 14px;
          background: var(--input-bg);
          border: 1px solid var(--border);
          border-radius: 12px;
          color: var(--text);
        }
        .modalActions { display: flex; gap: 10px; justify-content: flex-end; }
        .modalActions .secondary { background: transparent; }
        .modalActions .danger { background: #d9363e; color: #fff; border: none; }
        .modalActions .danger:hover { background: #c22d35; }
        .shareLinkModal {
          width: min(560px, 100%);
        }
        .shareLinkModal.error h2 {
          color: var(--danger);
        }
        .shareDialogText {
          margin: 0 0 14px;
          color: var(--text-soft);
          line-height: 1.5;
        }
        .shareLinkInput {
          margin-bottom: 10px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 13px;
        }
        .shareDialogStatus {
          margin: 0 0 14px;
          color: var(--success);
          font-size: 13px;
        }
        .agentSettingsModal { width: min(580px, 100%); }
        /* ── Inline Markdown Editor ── */
        .mdEditorInline {
          display: flex;
          flex-direction: row;
          height: 100%;
          overflow: hidden;
          position: relative;
        }
        .mdEditorContent {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-width: 0;
          overflow: hidden;
        }
        .mdEditorToolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
          background: var(--header-bg);
          backdrop-filter: blur(18px);
          flex-shrink: 0;
        }
        .mdEditorToolbarLeft {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .mdEditorFilePath {
          font-size: 14px;
          font-weight: 600;
          color: var(--text);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .mdEditorToolbarRight {
          display: flex;
          gap: 8px;
          flex-shrink: 0;
        }
        .mdEditorBtn {
          padding: 4px 12px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--accent);
          color: #fff;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
        }
        .mdEditorBtn:hover:not(:disabled) { opacity: 0.85; }
        .mdEditorBtn:disabled { opacity: 0.4; cursor: default; }
        .mdEditorBtn.secondary {
          background: transparent;
          color: var(--text-soft);
          border-color: var(--border);
        }
        .mdEditorBtn.secondary:hover:not(:disabled) { background: var(--hover-bg); }
        .mdEditorBtn.danger {
          background: var(--danger);
          border-color: color-mix(in srgb, var(--danger) 70%, transparent);
        }
        .mdEditorBtn.save:not(:disabled) {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .mdEditorBtn.commentToggle {
          background: transparent;
          color: var(--text-soft);
        }
        .mdEditorBtn.commentToggle.active {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .mdConflictBackdrop {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 18px;
          background: rgba(0, 0, 0, 0.52);
          backdrop-filter: blur(6px);
          z-index: 8;
        }
        .mdConflictDialog {
          width: min(560px, 100%);
          padding: 22px;
          border: 1px solid var(--border);
          border-radius: 18px;
          background: var(--panel-strong);
          box-shadow: var(--shadow);
        }
        .mdConflictDialog h2,
        .mdConflictDiffHeader h2 {
          margin: 0 0 10px;
          color: var(--accent);
        }
        .mdConflictDialog p,
        .mdConflictDiffHeader p {
          margin: 0 0 14px;
          color: var(--text-soft);
          line-height: 1.5;
        }
        .mdConflictActions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 8px;
        }
        .mdConflictNote {
          margin-top: 12px !important;
          font-size: 12px;
          color: var(--muted) !important;
        }
        .mdConflictDiffPage {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: auto;
          padding: 16px;
          gap: 12px;
          background: var(--input-bg);
        }
        .mdConflictDiffHeader {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
          padding: 14px;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--panel-bg);
        }
        .mdConflictDiffGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .mdConflictDiffColumn {
          min-width: 0;
          border: 1px solid var(--border);
          border-radius: 12px;
          overflow: hidden;
          background: var(--panel-bg);
        }
        .mdConflictColumnTitle {
          padding: 8px 10px;
          border-bottom: 1px solid var(--border);
          color: var(--text-soft);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .mdConflictDiffColumn pre {
          margin: 0;
          padding: 10px;
          min-height: 120px;
          max-height: 220px;
          overflow: auto;
          color: var(--text);
          white-space: pre-wrap;
          font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
          font-size: 12px;
          line-height: 1.5;
        }
        .mdConflictDiffRows {
          border: 1px solid var(--border);
          border-radius: 12px;
          overflow: hidden;
          background: var(--panel-bg);
        }
        .mdConflictDiffRow {
          display: grid;
          grid-template-columns: 48px minmax(0, 1fr) minmax(0, 1fr);
          border-bottom: 1px solid color-mix(in srgb, var(--border) 65%, transparent);
          font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
          font-size: 12px;
        }
        .mdConflictDiffRow:last-child { border-bottom: none; }
        .mdConflictDiffRow.changed { background: rgba(245, 158, 11, 0.10); }
        .mdConflictDiffRow.added { background: rgba(34, 197, 94, 0.10); }
        .mdConflictDiffRow.removed { background: rgba(239, 68, 68, 0.10); }
        .mdConflictDiffRow code,
        .mdConflictLineNo {
          padding: 6px 8px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .mdConflictLineNo {
          color: var(--muted);
          border-right: 1px solid var(--border);
          text-align: right;
        }
        .mdConflictDiffRow code:first-of-type { border-right: 1px solid var(--border); }
        .mdConflictResolvedLabel {
          color: var(--text-soft);
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .mdConflictResolvedTextarea {
          min-height: 220px;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: 12px;
          resize: vertical;
          background: var(--panel-bg);
          color: var(--text);
          font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
          font-size: 13px;
          line-height: 1.6;
          outline: none;
        }
        .mdEditorSplit {
          flex: 1;
          display: flex;
          min-height: 0;
          overflow: hidden;
        }
        .mdEditorPane {
          flex: 1;
          min-width: 0;
          overflow-y: auto;
        }
        .mdEditorEditPane {
          border-right: 1px solid var(--border);
        }
        .mdEditorTextarea {
          width: 100%;
          height: 100%;
          padding: 16px;
          background: var(--input-bg);
          border: none;
          color: var(--text);
          font-family: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
          font-size: 13px;
          line-height: 1.6;
          resize: none;
          outline: none;
          tab-size: 2;
        }
        .mdEditorPreviewPane {
          padding: 16px 24px;
        }
        .mdDirtyBadge {
          font-size: 12px;
          color: #f0a020;
          white-space: nowrap;
        }
        .mdModeToggle {
          display: flex;
          border: 1px solid var(--border);
          border-radius: 6px;
          overflow: hidden;
        }
        .mdModeBtn {
          padding: 3px 10px;
          font-size: 12px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--text-soft);
          cursor: pointer;
          white-space: nowrap;
        }
        .mdModeBtn.active {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .mdModeBtn:hover:not(.active) { background: var(--hover-bg); }
        .mdPreviewBadge {
          display: inline-flex;
          align-items: center;
          padding: 4px 9px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
        }
        .mdEditorLive {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          position: relative;
        }
        .mdEditorSimple {
          flex: 1;
          min-height: 0;
          display: flex;
        }
        .mdEditorSimple .mdEditorTextarea {
          flex: 1;
          border: none;
          border-radius: 0;
        }
        .mdHtmlPreviewWrap {
          flex: 1;
          min-height: 0;
          padding: 16px;
          background: var(--input-bg);
        }
        .mdHtmlPreviewFrame {
          width: 100%;
          height: 100%;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: #fff;
        }
        .mdLiveEditable {
          min-height: 100%;
          padding: 20px 72px 20px 32px;
          outline: none;
          cursor: text;
        }
        .mdLiveEditable:focus {
          box-shadow: inset 0 0 0 2px var(--accent);
          border-radius: 4px;
        }
        .liveSelectionDraftLayer {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 2;
        }
        .liveSelectionDraftHighlight {
          position: absolute;
          background: rgba(88, 166, 255, 0.28);
          border: 1px solid rgba(88, 166, 255, 0.5);
          border-radius: 3px;
          box-shadow: 0 0 0 1px rgba(88, 166, 255, 0.16);
        }
        .liveCommentMarkerLayer {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 3;
        }
        .liveCommentMarker {
          position: absolute;
          pointer-events: auto;
        }
        .mdFileItem {
          cursor: pointer;
        }
        .mdFileIcon {
          font-size: 14px !important;
          min-width: 28px !important;
          min-height: 28px !important;
        }
        .fieldHint { font-size: 12px; color: var(--muted); margin-top: 4px; }
        .remoteAgentSelect {
          width: 100%;
          padding: 10px 12px;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--text);
          font-size: 14px;
          outline: none;
          cursor: pointer;
        }
        .remoteAgentSelect:focus {
          border-color: var(--accent);
        }
        .checkboxLabel {
          display: flex !important;
          flex-direction: row !important;
          align-items: center;
          gap: 10px;
          margin-bottom: 18px;
          cursor: pointer;
        }
        .checkboxLabel input[type="checkbox"] {
          width: 18px; height: 18px;
          accent-color: var(--accent);
          cursor: pointer;
          flex-shrink: 0;
        }
        .checkboxLabel span { margin-bottom: 0 !important; }

        @media (max-width: 1100px) {
          .header {
            align-items: flex-start;
            flex-direction: column;
            padding: 14px 16px;
          }
          .headerLeft,
          .headerRight {
            width: 100%;
          }
          .headerRight {
            justify-content: space-between;
          }
          .themeMenuWrap {
            flex: none;
            min-width: 0;
          }
          .themeMenuButton {
            min-width: 0;
            width: auto;
          }
          .themeDropdown {
            left: 0;
            right: auto;
            min-width: min(260px, 100%);
          }
          .chatContainer {
            padding: 18px 16px;
          }
          .chatInputDock {
            padding: 14px 16px;
          }
          .statusBar {
            padding: 10px 16px;
          }
        }

        @media (max-width: 900px) {
          .mobileOnlyButton {
            display: inline-flex;
          }
          .mobilePanelBackdrop {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.42);
            backdrop-filter: blur(3px);
            z-index: 11;
          }
          .chatLayout,
          .chatLayout.agentsSidebarOpen,
          .chatLayout.sidebarCollapsed,
          .chatLayout.sidebarCollapsed.agentsSidebarOpen {
            grid-template-columns: minmax(0, 1fr);
          }
          .sidebarResizeHandle {
            display: none;
          }
          .participantsSidebar,
          .agentsSidebar {
            display: block;
            position: fixed;
            top: 0;
            bottom: 0;
            width: min(84vw, 320px);
            z-index: 12;
            box-shadow: var(--shadow);
            transition: transform 180ms ease;
          }
          .participantsSidebar {
            left: 0;
            transform: translateX(-105%);
            border-right: 1px solid var(--border);
          }
          .agentsSidebar {
            right: 0;
            transform: translateX(105%);
            border-left: 1px solid var(--border);
          }
          .participantsSidebar.mobilePanelVisible,
          .agentsSidebar.mobilePanelVisible {
            transform: translateX(0);
          }
          .chatMoreBtn {
            opacity: 1;
            pointer-events: auto;
          }
          .participantsHeader,
          .agentsSidebarHeader {
            position: sticky;
            top: 0;
            background: var(--panel-strong);
            backdrop-filter: blur(16px);
            z-index: 1;
          }
          .message {
            max-width: 100%;
            padding: 12px 14px;
            border-radius: 16px;
          }
          .chatContainer {
            padding: 14px 12px;
            gap: 12px;
          }
          .chatInputDock {
            padding: 12px;
          }
          .composerStack {
            max-width: none;
          }
          .composerShell {
            border-radius: 12px;
          }
          .sendButton {
            width: 40px;
            min-width: 40px;
            height: 40px;
            min-height: 40px;
          }
          .mentionDropdown {
            left: 0;
            right: 0;
            bottom: calc(100% + 8px);
          }
          .statusBar {
            flex-wrap: wrap;
            gap: 6px 12px;
            padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
          }
          .modalOverlay {
            padding: 12px;
          }
          .modal,
          .agentSettingsModal {
            width: 100%;
            max-height: calc(100vh - 24px);
            overflow-y: auto;
            padding: 16px;
            border-radius: 18px;
          }
        }

        @media (max-width: 560px) {
          .header {
            gap: 12px;
          }
          h1 {
            font-size: 18px;
          }
          .headerRight {
            gap: 8px;
          }
          .mobileOnlyButton {
            min-height: 42px;
          }
          .ghostButton,
          .themeMenuButton {
            min-height: unset;
            padding: 6px 10px;
            font-size: 14px;
          }
          .inputArea {
            display: block;
          }
          .composerShell {
            width: 100%;
            padding: 10px 12px;
            border-radius: 12px;
          }
          .composerRow {
            gap: 8px;
          }
          .composerTextarea {
            min-height: 22px;
            padding: 7px 0 6px;
          }
          .composerActions {
            justify-content: flex-end;
          }
          .messageHeader {
            gap: 6px;
            font-size: 11px;
          }
          .chatHistoryItem,
          .agentListItem {
            padding: 10px;
          }
        }

        /* ── Comment sidebar ── */
        .commentSidebar {
          width: 260px;
          min-width: 260px;
          border-left: 1px solid var(--border);
          background: var(--panel-bg);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .commentSidebarHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          border-bottom: 1px solid var(--border);
          font-size: 13px;
          font-weight: 600;
          color: var(--text-soft);
        }
        .commentFilterSelect {
          background: var(--panel-strong);
          border: 1px solid var(--border);
          border-radius: 4px;
          color: var(--text-soft);
          font-size: 11px;
          padding: 2px 4px;
          cursor: pointer;
        }
        .commentSidebarList {
          flex: 1;
          overflow: visible;
          min-height: 0;
          position: relative;
          padding: 8px;
        }
        .commentSidebarCanvas {
          position: relative;
        }
        .commentCard {
          background: var(--panel-strong);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 8px;
          margin-bottom: 6px;
          font-size: 12px;
          cursor: pointer;
          transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
        }
        .commentCard.aligned {
          position: absolute;
          left: 0;
          right: 0;
          margin-bottom: 0;
        }
        .commentCard.selected {
          border-color: var(--accent);
          box-shadow: 0 0 8px rgba(88, 166, 255, 0.2);
          z-index: 2;
        }
        .commentCard.resolved {
          border-color: rgba(45, 212, 191, 0.45);
          box-shadow: 0 0 0 1px rgba(45, 212, 191, 0.08);
        }
        .commentCard.processing {
          border-color: #d29922;
        }
        .commentCard.queued {
          border-color: rgba(245, 158, 11, 0.45);
          background: rgba(245, 158, 11, 0.08);
        }
        .commentCardHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 4px;
        }
        .commentAuthor {
          font-size: 11px;
          color: var(--text-soft);
        }
        .commentHeaderMeta {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .commentStatusBadge {
          padding: 1px 6px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 10px;
          font-weight: 600;
          line-height: 1.4;
        }
        .commentStatusBadge.resolved {
          background: rgba(45, 212, 191, 0.12);
          border-color: rgba(45, 212, 191, 0.35);
          color: #5eead4;
        }
        .commentStatusBadge.processing {
          background: rgba(210, 153, 34, 0.14);
          border-color: rgba(210, 153, 34, 0.4);
          color: #d29922;
        }
        .commentStatusBadge.queued {
          background: rgba(245, 158, 11, 0.12);
          border-color: rgba(245, 158, 11, 0.35);
          color: #f59e0b;
        }
        .commentLineRange {
          font-size: 10px;
          color: var(--text-soft);
          opacity: 0.6;
        }
        .commentContent {
          color: var(--text);
          margin: 4px 0;
          line-height: 1.4;
        }
        .commentContentCompact {
          color: var(--text-soft);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .commentActions {
          display: flex;
          gap: 4px;
          margin-top: 6px;
        }
        .commentActionBtn {
          padding: 2px 8px;
          border-radius: 4px;
          border: none;
          font-size: 11px;
          cursor: pointer;
          background: var(--panel-strong);
          color: var(--text-soft);
        }
        .commentActionBtn.approve {
          border: 1px solid rgba(94, 234, 212, 0.45);
          background: linear-gradient(135deg, rgba(20, 184, 166, 0.92), rgba(52, 211, 153, 0.9));
          color: #042f2e;
          box-shadow: 0 0 14px rgba(45, 212, 191, 0.18);
          font-weight: 700;
        }
        .commentActionBtn.reject {
          background: #da3633;
          color: white;
        }
        .commentActionBtn.stop {
          background: #d29922;
          color: #0d1117;
        }
        .commentActionBtn.reply {
          background: var(--panel-strong);
          color: var(--text-soft);
        }
        .commentActionBtn:hover { opacity: 0.85; }
        .commentActionBtn:disabled { opacity: 0.4; cursor: default; }
        .commentProcessing {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 6px;
          color: #d29922;
          font-size: 11px;
          cursor: pointer;
        }
        .commentProcessing.queued {
          color: var(--text-soft);
        }
        .commentSpinner {
          width: 12px;
          height: 12px;
          border: 2px solid #d29922;
          border-top-color: transparent;
          border-radius: 50%;
          display: inline-block;
          animation: commentSpin 1s linear infinite;
        }
        @keyframes commentSpin { to { transform: rotate(360deg); } }
        .commentResolved {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--text-soft);
          font-size: 11px;
          margin-top: 4px;
        }
        .commentReviewChatLink {
          background: none;
          border: none;
          color: var(--accent);
          cursor: pointer;
          font-size: 11px;
          padding: 0;
        }
        .commentReviewChatLink:hover {
          text-decoration: underline;
        }
        .commentReplies {
          border-top: 1px solid var(--border);
          margin-top: 6px;
          padding-top: 6px;
        }
        .commentShowReplies {
          background: none;
          border: none;
          color: var(--accent);
          font-size: 11px;
          cursor: pointer;
          padding: 0;
        }
        .commentReply {
          border-left: 2px solid var(--border);
          padding-left: 8px;
          margin-bottom: 4px;
          font-size: 11px;
        }
        .commentReplyAuthor {
          color: var(--text-soft);
          font-size: 10px;
          display: block;
        }
        .commentReplyText {
          color: var(--text-soft);
        }
        .commentReplyInput {
          display: flex;
          gap: 4px;
          margin-top: 6px;
        }
        .commentReplyInput input {
          flex: 1;
          background: var(--bg-accent);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 4px 8px;
          color: var(--text);
          font-size: 11px;
        }
        .commentReplyInput button {
          background: var(--accent);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 10px;
          font-size: 11px;
          cursor: pointer;
        }
        .commentAddForm {
          background: var(--panel-strong);
          border: 1px solid var(--accent);
          border-radius: 6px;
          padding: 8px;
          margin-top: 8px;
        }
        .commentAddForm.aligned {
          position: absolute;
          left: 0;
          right: 0;
          margin-top: 0;
          z-index: 3;
        }
        .commentAddLabel {
          font-size: 11px;
          color: var(--text-soft);
          margin-bottom: 4px;
        }
        .commentAddTextarea {
          width: 100%;
          min-height: 50px;
          background: var(--bg-accent);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 6px;
          color: var(--text);
          font-size: 12px;
          resize: vertical;
          box-sizing: border-box;
        }
        .commentAddActions {
          display: flex;
          justify-content: flex-end;
          gap: 4px;
          margin-top: 6px;
        }

        /* ── Collapsed sidebar ── */
        .commentSidebarCollapsed {
          width: 28px;
          min-width: 28px;
          background: var(--panel-bg);
          border-left: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          align-items: center;
          padding-top: 12px;
          gap: 8px;
          cursor: pointer;
        }
        .commentSidebarCollapsedLabel {
          writing-mode: vertical-rl;
          font-size: 10px;
          color: var(--text-soft);
          letter-spacing: 0.05em;
        }
        .commentBadge {
          background: var(--accent);
          color: #fff;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          text-align: center;
          line-height: 18px;
          font-size: 10px;
          font-weight: 600;
        }
        .commentExpandBtn {
          color: var(--text-soft);
          font-size: 12px;
        }

        /* ── File line viewer ── */
        .fileContentWithLines {
          flex: 1;
          overflow: auto;
          font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
          font-size: 13px;
          line-height: 20px;
          padding: 8px 0;
          position: relative;
        }
        .fileLine {
          display: flex;
          min-height: 20px;
          padding: 0 12px 0 0;
        }
        .fileLine.highlighted {
          background: rgba(88, 166, 255, 0.12);
          border-left: 3px solid var(--accent);
        }
        .fileLine.has-comment {
          /* subtle marker only, no line highlight */
        }
        .fileLineGutter {
          width: 60px;
          min-width: 60px;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 4px;
          padding-right: 12px;
          user-select: none;
        }
        .fileLineNum {
          color: var(--text-soft);
          opacity: 0.4;
          font-size: 12px;
        }
        .lineCommentMarker {
          width: 22px;
          height: 18px;
          border: 1px solid currentColor;
          border-radius: 5px;
          background: color-mix(in srgb, currentColor 10%, transparent);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          color: var(--accent);
          font-size: 10px;
          line-height: 1;
          cursor: pointer;
          position: relative;
          flex-shrink: 0;
        }
        .lineCommentMarker:hover,
        .lineCommentMarker.selected {
          background: color-mix(in srgb, currentColor 22%, transparent);
          box-shadow: 0 0 0 1px color-mix(in srgb, currentColor 35%, transparent);
        }
        .lineCommentMarker.liveCommentMarker {
          position: absolute;
          pointer-events: auto;
        }
        .lineCommentCount {
          position: absolute;
          top: -7px;
          right: -7px;
          min-width: 13px;
          height: 13px;
          padding: 0 3px;
          border-radius: 999px;
          background: var(--accent);
          color: #fff;
          font-size: 9px;
          line-height: 13px;
          font-family: system-ui, sans-serif;
          font-weight: 700;
          box-sizing: border-box;
        }
        .fileLineText {
          white-space: pre;
          color: var(--text);
          flex: 1;
        }
        .fileLineSelectedText {
          background: rgba(88, 166, 255, 0.28);
          border: 1px solid rgba(88, 166, 255, 0.5);
          border-radius: 3px;
          box-shadow: 0 0 0 1px rgba(88, 166, 255, 0.16);
        }
        .fileLineCommentSlot {
          width: 34px;
          min-width: 34px;
          display: flex;
          align-items: center;
          justify-content: center;
          user-select: none;
        }
        .addCommentFloatingBtn {
          background: var(--accent);
          color: white;
          border: none;
          border-radius: 4px;
          padding: 4px 12px;
          font-size: 12px;
          cursor: pointer;
          z-index: 10;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .addCommentFloatingBtn:hover { opacity: 0.85; }
        .lightboxOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.85);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
          cursor: pointer;
        }
        .lightboxImg {
          max-width: 90vw;
          max-height: 90vh;
          border-radius: 8px;
          box-shadow: 0 4px 32px rgba(0,0,0,0.5);
          cursor: default;
        }
        .lightboxClose {
          position: fixed;
          top: 16px;
          right: 24px;
          background: rgba(255,255,255,0.15);
          border: none;
          color: #fff;
          font-size: 28px;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lightboxClose:hover { background: rgba(255,255,255,0.3); }
      `}</style>
    </main>
  );
}
