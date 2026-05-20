'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { STORAGE_FILE_WORKSPACE } from '../../chat/runtime/sessionPersistence';
import { markdownToHtml } from '../../messages/markdownHelpers';
import {
  buildFileTree,
  buildSimpleLineDiff,
  isMarkdownFile,
  normalizeFileEditorMode,
  parseFileWorkspaceState,
} from '../fileWorkspaceHelpers';
import type { FileWorkspaceState, LeftSidebarTab, MdConflictState, MdEditorMode } from '../fileWorkspaceTypes';
import type { MarkdownFileEntry, UseFileWorkspaceStateDeps, UseFileWorkspaceStateResult } from './fileWorkspaceHookTypes';

export type { MarkdownFileEntry, UseFileWorkspaceStateResult } from './fileWorkspaceHookTypes';


export function useFileWorkspaceState({
  agents,
  agentsLoading,
  mounted,
  schedulerAgentId,
  onFileOpened,
}: UseFileWorkspaceStateDeps): UseFileWorkspaceStateResult {
  const [leftSidebarTab, setLeftSidebarTab] = useState<LeftSidebarTab>('chats');
  const [mdFilesList, setMdFilesList] = useState<MarkdownFileEntry[]>([]);
  const [mdFilesLoading, setMdFilesLoading] = useState(false);
  const [mdFilesError, setMdFilesError] = useState<string | null>(null);
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
  const [workspaceScrollTop, setWorkspaceScrollTop] = useState(0);
  const mdLiveRef = useRef<HTMLDivElement>(null);
  const [mdLiveElementVersion, setMdLiveElementVersion] = useState(0);
  const fileWorkspaceRestoreRef = useRef<FileWorkspaceState | null>(null);
  const fileWorkspaceRestoredRef = useRef(false);
  const fileWorkspaceStorageReadRef = useRef(false);
  const turndownRef = useRef<TurndownService | null>(null);

  if (!turndownRef.current) {
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*' });
    td.use(gfm);
    turndownRef.current = td;
  }

  const setMdLiveElementRef = useCallback((node: HTMLDivElement | null) => {
    mdLiveRef.current = node;
    if (node) setMdLiveElementVersion((version) => version + 1);
  }, []);

  const mdFileTree = useMemo(() => buildFileTree(mdFilesList), [mdFilesList]);

  const loadMdFiles = useCallback(async (agentId: string, diff = false) => {
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
  }, []);

  const openMdFileForAgent = useCallback(async (
    agentId: string,
    filePath: string,
    options?: { skipDirtyConfirm?: boolean; editorMode?: MdEditorMode; restoreScrollTop?: number },
  ) => {
    if (!options?.skipDirtyConfirm && mdDirty) {
      if (!confirm('You have unsaved changes. Discard?')) return;
    }
    try {
      const res = await fetch(`/api/markdown?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      if (data.content === undefined) return;
      const restoreScrollTop = options?.restoreScrollTop ?? 0;
      setMdSelectedFile(filePath);
      setMdFileContent(data.content);
      setMdEditContent(data.content);
      setMdFileMtime(data.mtime || null);
      setMdDirty(false);
      setMdLiveHtml(isMarkdownFile(filePath) ? markdownToHtml(data.content) : '');
      setMdEditorMode(current => normalizeFileEditorMode(options?.editorMode ?? current, filePath));
      setMdEditorOpen(true);
      await onFileOpened?.({ agentId, filePath, restoreScrollTop });
    } catch (err) {
      console.error('Failed to read markdown file', err);
    }
  }, [mdDirty, onFileOpened]);

  const openMdFile = useCallback(async (filePath: string) => {
    if (!mdSelectedAgentId) return;
    await openMdFileForAgent(mdSelectedAgentId, filePath);
  }, [mdSelectedAgentId, openMdFileForAgent]);

  useEffect(() => {
    if (!mounted || fileWorkspaceStorageReadRef.current) return;
    fileWorkspaceStorageReadRef.current = true;
    const savedFileWorkspace = parseFileWorkspaceState(window.localStorage.getItem(STORAGE_FILE_WORKSPACE));
    if (!savedFileWorkspace) return;
    fileWorkspaceRestoreRef.current = savedFileWorkspace;
    setLeftSidebarTab(savedFileWorkspace.tab);
    setMdDiffOnly(savedFileWorkspace.diffOnly);
    setMdEditorMode(savedFileWorkspace.editorMode);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !fileWorkspaceStorageReadRef.current || agentsLoading || fileWorkspaceRestoredRef.current) return;
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

    const agentCanShowFiles = agents.some(a => a.id === workspace.agentId && a.cwd && !a.relay && a.id !== schedulerAgentId);
    if (!agentCanShowFiles) return;

    const agentId = workspace.agentId;
    setMdSelectedAgentId(agentId);
    void (async () => {
      await loadMdFiles(agentId, workspace.diffOnly);
      if (workspace.filePath) {
        await openMdFileForAgent(agentId, workspace.filePath, {
          skipDirtyConfirm: true,
          editorMode: workspace.editorMode,
          restoreScrollTop: workspace.scrollTop,
        });
      }
    })();
  }, [agents, agentsLoading, loadMdFiles, mounted, openMdFileForAgent, schedulerAgentId]);

  useEffect(() => {
    if (!mounted || !fileWorkspaceStorageReadRef.current) return;
    window.localStorage.setItem(STORAGE_FILE_WORKSPACE, JSON.stringify({
      tab: leftSidebarTab,
      agentId: mdSelectedAgentId,
      filePath: mdSelectedFile,
      diffOnly: mdDiffOnly,
      editorMode: mdEditorMode,
      scrollTop: workspaceScrollTop,
    } satisfies FileWorkspaceState));
  }, [leftSidebarTab, mdSelectedAgentId, mdSelectedFile, mdDiffOnly, mdEditorMode, workspaceScrollTop, mounted]);

  const toggleMdDir = useCallback((dirPath: string) => {
    setMdExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const selectMdAgent = useCallback((agentId: string | null) => {
    setMdSelectedAgentId(agentId);
    if (agentId) void loadMdFiles(agentId, mdDiffOnly);
    else setMdFilesList([]);
  }, [loadMdFiles, mdDiffOnly]);

  const toggleMdDiffOnly = useCallback(() => {
    const next = !mdDiffOnly;
    setMdDiffOnly(next);
    if (mdSelectedAgentId) void loadMdFiles(mdSelectedAgentId, next);
  }, [loadMdFiles, mdDiffOnly, mdSelectedAgentId]);

  const syncLiveToMarkdown = useCallback((): string => {
    if (mdEditorMode === 'live' && mdLiveRef.current) {
      const html = mdLiveRef.current.innerHTML;
      const md = turndownRef.current!.turndown(html);
      setMdLiveHtml(html);
      setMdEditContent(md);
      setMdDirty(md !== mdFileContent);
      return md;
    }
    return mdEditContent;
  }, [mdEditContent, mdEditorMode, mdFileContent]);

  const switchLeftSidebarTab = useCallback((tab: LeftSidebarTab) => {
    if (tab !== 'files') syncLiveToMarkdown();
    setLeftSidebarTab(tab);
  }, [syncLiveToMarkdown]);

  const saveMdFile = useCallback(async (contentOverride?: string, mtimeOverride?: string | null) => {
    if (!mdSelectedAgentId || !mdSelectedFile) return;
    const content = contentOverride ?? syncLiveToMarkdown();
    const mtimeToSave = mtimeOverride !== undefined ? mtimeOverride : mdFileMtime;
    setMdSaving(true);
    try {
      const res = await fetch('/api/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: mdSelectedAgentId, path: mdSelectedFile, content, mtime: mtimeToSave }),
      });
      const data = await res.json();
      if (data.ok) {
        setMdFileContent(content);
        setMdEditContent(content);
        setMdFileMtime(data.mtime || null);
        setMdDirty(false);
        setMdConflict(null);
        setMdConflictResolvedContent('');
        setMdLiveHtml(isMarkdownFile(mdSelectedFile) ? markdownToHtml(content) : '');
        void loadMdFiles(mdSelectedAgentId, mdDiffOnly);
      } else if (data.error === 'conflict') {
        const serverContent = typeof data.serverContent === 'string' ? data.serverContent : mdFileContent;
        const serverMtime = typeof data.serverMtime === 'string' ? data.serverMtime : null;
        setMdConflict({ path: mdSelectedFile, baseContent: mdFileContent, mineContent: content, serverContent, serverMtime, mode: 'choice' });
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
  }, [loadMdFiles, mdDiffOnly, mdFileContent, mdFileMtime, mdSelectedAgentId, mdSelectedFile, syncLiveToMarkdown]);

  const applyMdContent = useCallback((content: string, mtime: string | null, dirty: boolean) => {
    setMdFileContent(content);
    setMdEditContent(content);
    setMdFileMtime(mtime);
    setMdDirty(dirty);
    setMdLiveHtml(mdSelectedFile && isMarkdownFile(mdSelectedFile) ? markdownToHtml(content) : '');
  }, [mdSelectedFile]);

  const resolveMdConflictByReload = useCallback(() => {
    if (!mdConflict) return;
    applyMdContent(mdConflict.serverContent, mdConflict.serverMtime, false);
    setMdConflict(null);
    setMdConflictResolvedContent('');
    if (mdSelectedAgentId) void loadMdFiles(mdSelectedAgentId, mdDiffOnly);
  }, [applyMdContent, loadMdFiles, mdConflict, mdDiffOnly, mdSelectedAgentId]);

  const beginManualMdConflictResolution = useCallback(() => {
    if (!mdConflict) return;
    setMdConflictResolvedContent(mdConflict.mineContent);
    setMdConflict({ ...mdConflict, mode: 'manual' });
  }, [mdConflict]);

  const keepServerVersion = useCallback(() => { if (mdConflict) setMdConflictResolvedContent(mdConflict.serverContent); }, [mdConflict]);
  const keepMineVersion = useCallback(() => { if (mdConflict) setMdConflictResolvedContent(mdConflict.mineContent); }, [mdConflict]);

  const handleSaveManualMdConflict = useCallback(async () => {
    if (!mdConflict) return;
    setMdEditContent(mdConflictResolvedContent);
    setMdDirty(mdConflictResolvedContent !== mdFileContent);
    await saveMdFile(mdConflictResolvedContent, mdConflict.serverMtime);
  }, [mdConflict, mdConflictResolvedContent, mdFileContent, saveMdFile]);

  const closeMdEditor = useCallback(() => {
    setMdEditorOpen(false);
    setMdSelectedFile(null);
    setMdFileContent('');
    setMdEditContent('');
    setMdFileMtime(null);
    setMdDirty(false);
    setMdLiveHtml('');
    setMdConflict(null);
    setMdConflictResolvedContent('');
  }, []);

  const workspace: FileWorkspaceState = {
    tab: leftSidebarTab,
    agentId: mdSelectedAgentId,
    filePath: mdSelectedFile,
    diffOnly: mdDiffOnly,
    editorMode: mdEditorMode,
    scrollTop: workspaceScrollTop,
  };
  const diffLines = mdConflict ? buildSimpleLineDiff(mdConflict.serverContent, mdConflict.mineContent) : [];

  return {
    workspace,
    activeFilePath: mdSelectedFile,
    activeFileContent: mdEditContent,
    editorMode: mdEditorMode,
    diffLines,
    conflictState: mdConflict,
    setActiveFilePath: setMdSelectedFile,
    setEditorMode: setMdEditorMode,
    openFilePath: openMdFile,
    saveActiveFile: () => saveMdFile(),
    leftSidebarTab,
    setLeftSidebarTab,
    mdFilesList,
    setMdFilesList,
    mdFilesLoading,
    mdFilesError,
    mdSelectedAgentId,
    setMdSelectedAgentId,
    mdSelectedFile,
    setMdSelectedFile,
    mdFileContent,
    setMdFileContent,
    mdEditContent,
    setMdEditContent,
    mdFileMtime,
    setMdFileMtime,
    mdSaving,
    mdDirty,
    setMdDirty,
    mdEditorOpen,
    mdEditorMode,
    setMdEditorMode,
    mdLiveHtml,
    setMdLiveHtml,
    mdConflict,
    setMdConflict,
    mdConflictResolvedContent,
    setMdConflictResolvedContent,
    mdExpandedDirs,
    mdDiffOnly,
    setMdDiffOnly,
    mdLiveRef,
    mdLiveElementVersion,
    setMdLiveElementRef,
    turndownRef,
    mdFileTree,
    loadMdFiles,
    openMdFileForAgent,
    openMdFile,
    selectMdAgent,
    toggleMdDiffOnly,
    toggleMdDir,
    syncLiveToMarkdown,
    switchLeftSidebarTab,
    saveMdFile,
    applyMdContent,
    resolveMdConflictByReload,
    beginManualMdConflictResolution,
    keepServerVersion,
    keepMineVersion,
    handleSaveManualMdConflict,
    closeMdEditor,
    setWorkspaceScrollTop,
  };
}
