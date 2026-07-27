import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const acpRouteSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');

assert.match(
  acpRouteSource,
  /async function buildSessionParams\([\s\S]*?cwdOverride\?:\s*string[\s\S]*?cwd:\s*cwdOverride\s*\|\|\s*proc\.cachedCwd/,
  'buildSessionParams should support optional cwd override',
);

assert.match(
  acpRouteSource,
  /async function resolveChatCwd\(userId: string, chatId\?: string\): Promise<string \| undefined>/,
  'ACP route should resolve per-chat cwd from stored git context',
);

assert.match(
  acpRouteSource,
  /buildSessionParamsForChat\([\s\S]*?resolveChatCwd\(userId, chatId\)/,
  'ACP route should derive session params from chat context helper',
);

assert.match(
  acpRouteSource,
  /await ensureUserSession\(proc, sess, agentId, userId, isAdmin, chatId\)/,
  'send action should pass chatId into ensureUserSession for chat-scoped cwd',
);

assert.match(
  acpRouteSource,
  /if \(!savedSessionId\) \{[\s\S]*?sess\.chatSessions\.delete\(chatId\);[\s\S]*?sess\.sessionId\s*=\s*null;/,
  'send action should invalidate stale in-memory chat sessions when persisted mapping is cleared',
);

console.log('chat git context cwd checks passed');
