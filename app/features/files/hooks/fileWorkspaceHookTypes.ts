import type { MutableRefObject } from 'react';
import type TurndownService from 'turndown';
import type { Agent } from '../../agents/agentTypes';
import type { FileTreeNode, FileWorkspaceController, LeftSidebarTab, MdConflictState, MdEditorMode } from '../fileWorkspaceTypes';

export type MarkdownFileEntry = { path: string; name: string; mtime: string };

export type FileOpenedPayload = {
  agentId: string;
  filePath: string;
  restoreScrollTop: number;
};

export type UseFileWorkspaceStateDeps = {
  agents: Agent[];
  agentsLoading: boolean;
  mounted: boolean;
  schedulerAgentId: string;
  onFileOpened?: (payload: FileOpenedPayload) => void | Promise<void>;
};

export type UseFileWorkspaceStateResult = FileWorkspaceController & {
  leftSidebarTab: LeftSidebarTab;
  setLeftSidebarTab: (tab: LeftSidebarTab) => void;
  mdFilesList: MarkdownFileEntry[];
  setMdFilesList: (files: MarkdownFileEntry[]) => void;
  mdFilesLoading: boolean;
  mdFilesError: string | null;
  mdSelectedAgentId: string | null;
  setMdSelectedAgentId: (agentId: string | null) => void;
  mdSelectedFile: string | null;
  setMdSelectedFile: (path: string | null) => void;
  mdFileContent: string;
  setMdFileContent: (content: string) => void;
  mdEditContent: string;
  setMdEditContent: (content: string) => void;
  mdFileMtime: string | null;
  setMdFileMtime: (mtime: string | null) => void;
  mdSaving: boolean;
  mdDirty: boolean;
  setMdDirty: (dirty: boolean) => void;
  mdEditorOpen: boolean;
  mdEditorMode: MdEditorMode;
  setMdEditorMode: (mode: MdEditorMode | ((mode: MdEditorMode) => MdEditorMode)) => void;
  mdLiveHtml: string;
  setMdLiveHtml: (html: string) => void;
  mdConflict: MdConflictState | null;
  setMdConflict: (conflict: MdConflictState | null) => void;
  mdConflictResolvedContent: string;
  setMdConflictResolvedContent: (content: string) => void;
  mdExpandedDirs: Set<string>;
  mdDiffOnly: boolean;
  setMdDiffOnly: (diffOnly: boolean) => void;
  mdLiveRef: MutableRefObject<HTMLDivElement | null>;
  mdLiveElementVersion: number;
  setMdLiveElementRef: (node: HTMLDivElement | null) => void;
  turndownRef: MutableRefObject<TurndownService | null>;
  mdFileTree: FileTreeNode[];
  loadMdFiles: (agentId: string, diff?: boolean) => Promise<void>;
  openMdFileForAgent: (agentId: string, filePath: string, options?: { skipDirtyConfirm?: boolean; editorMode?: MdEditorMode; restoreScrollTop?: number }) => Promise<void>;
  openMdFile: (filePath: string) => Promise<void>;
  selectMdAgent: (agentId: string | null) => void;
  toggleMdDiffOnly: () => void;
  toggleMdDir: (dirPath: string) => void;
  syncLiveToMarkdown: () => string;
  switchLeftSidebarTab: (tab: LeftSidebarTab) => void;
  saveMdFile: (contentOverride?: string, mtimeOverride?: string | null) => Promise<void>;
  applyMdContent: (content: string, mtime: string | null, dirty: boolean) => void;
  resolveMdConflictByReload: () => void;
  beginManualMdConflictResolution: () => void;
  keepServerVersion: () => void;
  keepMineVersion: () => void;
  handleSaveManualMdConflict: () => Promise<void>;
  closeMdEditor: () => void;
  setWorkspaceScrollTop: (scrollTop: number) => void;
};
