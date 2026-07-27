import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const chatStoreSource = readFileSync(new URL('../lib/chatStore.ts', import.meta.url), 'utf8');

assert.match(
  chatStoreSource,
  /export\s+type\s+StoredGitContext\s*=\s*\{[\s\S]*?repoRoot:\s*string;[\s\S]*?worktreePath:\s*string;[\s\S]*?branchName:\s*string;/,
  'chatStore should declare StoredGitContext with repoRoot/worktreePath/branchName',
);

assert.match(
  chatStoreSource,
  /type\s+StoredChat\s*=\s*\{[\s\S]*?gitContext\?:\s*StoredGitContext;/,
  'StoredChat should expose optional gitContext',
);

assert.match(
  chatStoreSource,
  /CREATE TABLE IF NOT EXISTS chats[\s\S]*?git_context\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'/,
  'chats table should persist git_context',
);

assert.match(
  chatStoreSource,
  /ALTER TABLE chats ADD COLUMN git_context TEXT NOT NULL DEFAULT '\{\}'/,
  'existing chats table should migrate git_context column',
);

assert.match(
  chatStoreSource,
  /INSERT INTO chats \(user_id, chat_id, name, ts, messages, agent_sessions, agent_id, git_context\)/,
  'saveChat upsert should include git_context column',
);

assert.match(
  chatStoreSource,
  /git_context = CASE WHEN excluded\.git_context != '\{\}' THEN excluded\.git_context ELSE chats\.git_context END/,
  'saveChat upsert should preserve existing git_context when omitted and update it when provided',
);

assert.match(
  chatStoreSource,
  /export async function updateChatGitContext\([\s\S]*?agent_sessions\s*=\s*\?/,
  'updateChatGitContext should clear agent_sessions after git context change',
);

console.log('chat git context store checks passed');
