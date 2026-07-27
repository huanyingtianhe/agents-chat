'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchChatGitContext, saveChatGitContext } from '../chatGitContextApi';
import type { ChatGitContext, ChatGitContextState } from '../chatGitContextTypes';

type UseChatGitContextOptions = {
  currentChatId: string | null;
  sessionLockSignature?: string;
  onContextChanged?: () => void;
};

export function useChatGitContext({ currentChatId, sessionLockSignature = '', onContextChanged }: UseChatGitContextOptions) {
  const [state, setState] = useState<ChatGitContextState>({
    loading: false,
    options: null,
    selected: null,
    locked: false,
    error: null,
  });

  useEffect(() => {
    if (!currentChatId) {
      setState({ loading: false, options: null, selected: null, locked: false, error: null });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    void fetchChatGitContext(currentChatId).then((result) => {
      if (cancelled) return;
      setState({
        loading: false,
        options: result.options,
        selected: result.selected,
        locked: result.locked,
        error: result.error || (result.locked ? 'session active - git context locked' : null),
      });
    });
    return () => { cancelled = true; };
  }, [currentChatId]);

  const derivedLocked = state.locked || sessionLockSignature.length > 0;

  const setWorktree = useCallback(async (worktreePath: string) => {
    if (!currentChatId || !state.options || derivedLocked) return;
    const selectedWorktree = state.options.worktrees.find((worktree) => worktree.worktreePath === worktreePath);
    if (!selectedWorktree) return;
    const nextContext: ChatGitContext = {
      repoRoot: state.options.repoRoot,
      worktreePath: selectedWorktree.worktreePath,
      branchName: selectedWorktree.branchName,
    };
    const result = await saveChatGitContext(currentChatId, nextContext);
    if (!result.ok || !result.gitContext) {
      setState((prev) => ({
        ...prev,
        locked: prev.locked || result.error === 'git_context_locked',
        error: result.error === 'git_context_locked' ? 'session active - git context locked' : (result.error || 'Failed to update git context'),
      }));
      return;
    }
    setState((prev) => ({ ...prev, selected: result.gitContext || prev.selected }));
    onContextChanged?.();
  }, [currentChatId, derivedLocked, onContextChanged, state.options]);

  const setBranch = useCallback(async (branchName: string) => {
    if (!currentChatId || !state.options || !state.selected || derivedLocked) return;
    const mappedWorktree = state.options.worktrees.find((worktree) => worktree.branchName === branchName);
    if (!mappedWorktree) {
      setState((prev) => ({ ...prev, error: 'No existing worktree for this branch' }));
      return;
    }
    const result = await saveChatGitContext(currentChatId, {
      repoRoot: state.options.repoRoot,
      worktreePath: mappedWorktree.worktreePath,
      branchName: mappedWorktree.branchName,
    });
    if (!result.ok || !result.gitContext) {
      setState((prev) => ({
        ...prev,
        locked: prev.locked || result.error === 'git_context_locked',
        error: result.error === 'git_context_locked' ? 'session active - git context locked' : (result.error || 'Failed to update git context'),
      }));
      return;
    }
    setState((prev) => ({ ...prev, selected: result.gitContext || prev.selected, error: null }));
    onContextChanged?.();
  }, [currentChatId, derivedLocked, onContextChanged, state.options, state.selected]);

  const view = useMemo(() => {
    const selectedWorktree = state.selected?.worktreePath || '';
    const selectedBranch = state.selected?.branchName || '';
    const locked = state.locked || sessionLockSignature.length > 0;
    return {
      disabled: state.loading || locked || !(state.options?.available),
      branches: state.options?.branches || [],
      worktrees: (state.options?.worktrees || []).map((worktree) => ({
        path: worktree.worktreePath,
        label: worktree.isMain
          ? `${worktree.branchName || '(detached)'} · ${worktree.worktreePath}`
          : `${worktree.branchName || '(detached)'} · ${worktree.worktreePath}`,
      })),
      selectedWorktree,
      selectedBranch,
      statusText: state.error || (locked ? 'session active - git context locked' : state.options?.statusText || ''),
      locked,
    };
  }, [sessionLockSignature, state]);

  return {
    state,
    view,
    setWorktree,
    setBranch,
  };
}
