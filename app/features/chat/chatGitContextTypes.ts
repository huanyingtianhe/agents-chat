export type ChatGitContext = {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  isFallback?: boolean;
};

export type ChatGitWorktree = {
  worktreePath: string;
  branchName: string;
  isMain: boolean;
};

export type ChatGitContextOptions = {
  available: boolean;
  repoRoot: string;
  branches: string[];
  worktrees: ChatGitWorktree[];
  effective: ChatGitContext | null;
  statusText?: string;
};

export type ChatGitContextState = {
  loading: boolean;
  options: ChatGitContextOptions | null;
  selected: ChatGitContext | null;
  locked: boolean;
  error: string | null;
};
