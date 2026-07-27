import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const chatsRouteSource = readFileSync(new URL('../app/api/chats/route.ts', import.meta.url), 'utf8');
const gitContextSource = readFileSync(new URL('../lib/gitContext.ts', import.meta.url), 'utf8');

assert.match(
  chatsRouteSource,
  /action\s*===\s*['"]update-git-context['"]/,
  'chats route should support update-git-context action',
);

assert.match(
  chatsRouteSource,
  /missing_chatId/,
  'update-git-context action should validate chatId',
);

assert.match(
  chatsRouteSource,
  /invalid_git_context/,
  'update-git-context action should validate gitContext payload shape',
);

assert.match(
  chatsRouteSource,
  /const\s+gitContextOptions\s*=\s*getGitContextOptions\(/,
  'GET chat payload should include git context options',
);

assert.match(
  gitContextSource,
  /export function parseWorktreePorcelain\(output: string\): GitWorktree\[]/,
  'gitContext helper should expose worktree porcelain parser',
);

assert.match(
  gitContextSource,
  /export function selectWorktreeForBranch\(branchName: string, worktrees: GitWorktree\[\]\): GitWorktree \| null/,
  'gitContext helper should expose branch->worktree selection helper',
);

assert.match(
  gitContextSource,
  /branch_without_worktree/,
  'gitContext validation should report missing worktree mappings for branch selections',
);

console.log('chat git context api checks passed');
