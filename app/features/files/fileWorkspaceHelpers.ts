import type { DiffLine, ExtractedAgentFileComment, FileTreeNode, FileWorkspaceState, LeftSidebarTab, MdEditorMode } from './fileWorkspaceTypes';

export const FILE_REVIEW_LINE_HEIGHT = 20;
export const COMMENT_SIDEBAR_CARD_PADDING = 120;
export const COMMENT_SIDEBAR_CARD_GAP = 8;
export const COMMENT_SIDEBAR_COLLAPSED_CARD_HEIGHT = 54;
export const COMMENT_SIDEBAR_EXPANDED_CARD_HEIGHT = 118;

export function getFileIcon(name: string): string {
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

export function isLeftSidebarTab(value: unknown): value is LeftSidebarTab {
  return value === 'chats' || value === 'files';
}

export function isMdEditorMode(value: unknown): value is MdEditorMode {
  return value === 'split' || value === 'live' || value === 'review';
}

export function normalizeFileEditorMode(mode: MdEditorMode, filePath?: string | null): MdEditorMode {
  if (!filePath) return mode === 'review' ? 'live' : mode;
  if (isMarkdownFile(filePath)) return mode === 'review' ? 'live' : mode;
  if (isHtmlFile(filePath)) return 'live';
  return mode;
}

export function parseFileWorkspaceState(raw: string | null): FileWorkspaceState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FileWorkspaceState>;
    const filePath = typeof parsed.filePath === 'string' && parsed.filePath ? parsed.filePath : null;
    const editorMode = isMdEditorMode(parsed.editorMode) ? parsed.editorMode : 'live';
    const scrollTop = typeof parsed.scrollTop === 'number' && Number.isFinite(parsed.scrollTop) && parsed.scrollTop >= 0
      ? parsed.scrollTop
      : undefined;
    return {
      tab: isLeftSidebarTab(parsed.tab) ? parsed.tab : 'chats',
      agentId: typeof parsed.agentId === 'string' && parsed.agentId ? parsed.agentId : null,
      filePath,
      diffOnly: parsed.diffOnly === true,
      editorMode: normalizeFileEditorMode(editorMode, filePath),
      scrollTop,
    };
  } catch {
    return null;
  }
}

export function buildSimpleLineDiff(serverContent: string, mineContent: string): DiffLine[] {
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

export function isMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}

export function isHtmlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

export function buildFileTree(files: { path: string; name: string }[]): FileTreeNode[] {
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

export function extractFileCommentsFromText(text: string): { cleanText: string; comments: ExtractedAgentFileComment[] } {
  const commentBlockRegex = /```json:file-comments\s*\n([\s\S]*?)```/g;
  const comments: ExtractedAgentFileComment[] = [];
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
    } catch {
      // Invalid JSON in an agent response should not block the chat turn.
    }
    cleanText = cleanText.replace(match[0], '').trim();
  }

  return { cleanText, comments };
}
