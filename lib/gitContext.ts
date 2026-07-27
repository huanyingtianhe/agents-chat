import { execFileSync } from 'child_process';
import * as path from 'path';
import type { StoredGitContext } from './chatStore';

export type GitWorktree = {
  worktreePath: string;
  branchName: string;
  isMain: boolean;
};

export type GitContextOptions = {
  available: boolean;
  repoRoot: string;
  branches: string[];
  worktrees: GitWorktree[];
  effective: StoredGitContext | null;
  statusText?: string;
};

export type GitContextValidationResult =
  | { ok: true; gitContext: StoredGitContext }
  | { ok: false; error: string };

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function normalizePath(input: string): string {
  return path.resolve(input).replace(/\\/g, '/');
}

export function parseWorktreePorcelain(output: string): GitWorktree[] {
  const blocks = output
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsed = blocks
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const wt = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length) || '';
      const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) || '';
      const branchName = branchRef.startsWith('refs/heads/')
        ? branchRef.slice('refs/heads/'.length)
        : branchRef;
      const normalized = wt ? normalizePath(wt) : '';
      return {
        worktreePath: normalized,
        branchName,
        isMain: !normalized.includes('/.worktrees/'),
      };
    })
    .filter((entry) => entry.worktreePath.length > 0);

  return parsed;
}

export function selectWorktreeForBranch(branchName: string, worktrees: GitWorktree[]): GitWorktree | null {
  return worktrees.find((worktree) => worktree.branchName === branchName) || null;
}

export function isValidStoredGitContext(value: unknown): value is StoredGitContext {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.repoRoot === 'string'
    && typeof candidate.worktreePath === 'string'
    && typeof candidate.branchName === 'string';
}

export function getGitContextOptions(savedContext?: StoredGitContext | null, repoRootHint?: string): GitContextOptions {
  try {
    const initialRoot = normalizePath(repoRootHint || savedContext?.repoRoot || process.cwd());
    const repoRoot = normalizePath(runGit(initialRoot, ['rev-parse', '--show-toplevel']));
    const branchesOutput = runGit(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    const branches = branchesOutput
      .split(/\r?\n/)
      .map((branch) => branch.trim())
      .filter(Boolean);

    const worktreesOutput = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
    const worktrees = parseWorktreePorcelain(worktreesOutput);

    const validSaved = savedContext
      && normalizePath(savedContext.repoRoot) === repoRoot
      && worktrees.some((worktree) => worktree.worktreePath === normalizePath(savedContext.worktreePath));

    let effective: StoredGitContext | null = null;
    if (validSaved && savedContext) {
      effective = {
        repoRoot,
        worktreePath: normalizePath(savedContext.worktreePath),
        branchName: savedContext.branchName,
        isFallback: false,
      };
    } else if (worktrees.length > 0) {
      const main = worktrees.find((worktree) => worktree.isMain) || worktrees[0];
      effective = {
        repoRoot,
        worktreePath: main.worktreePath,
        branchName: main.branchName || branches[0] || '',
        isFallback: !!savedContext,
      };
    }

    return { available: true, repoRoot, branches, worktrees, effective };
  } catch {
    return {
      available: false,
      repoRoot: '',
      branches: [],
      worktrees: [],
      effective: null,
      statusText: 'Git context unavailable',
    };
  }
}

export function validateGitContext(input: StoredGitContext, options: GitContextOptions): GitContextValidationResult {
  if (!options.available) return { ok: false, error: 'git_unavailable' };

  const repoRoot = normalizePath(input.repoRoot);
  const worktreePath = normalizePath(input.worktreePath);
  if (repoRoot !== normalizePath(options.repoRoot)) return { ok: false, error: 'repo_mismatch' };

  const selectedWorktree = options.worktrees.find((worktree) => worktree.worktreePath === worktreePath);
  if (!selectedWorktree) return { ok: false, error: 'unknown_worktree' };

  const branchName = selectedWorktree.branchName || input.branchName;
  if (input.branchName && input.branchName !== branchName) {
    const mapped = selectWorktreeForBranch(input.branchName, options.worktrees);
    if (!mapped) return { ok: false, error: 'branch_without_worktree' };
    return {
      ok: true,
      gitContext: {
        repoRoot: options.repoRoot,
        worktreePath: mapped.worktreePath,
        branchName: mapped.branchName,
      },
    };
  }

  return {
    ok: true,
    gitContext: {
      repoRoot: options.repoRoot,
      worktreePath,
      branchName,
    },
  };
}
