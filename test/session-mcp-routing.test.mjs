import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /function buildSessionParams\s*\([\s\S]*?mcpServers:\s*\[\][\s\S]*?!proc\.config\.noTools\s*&&\s*!proc\.config\.relay[\s\S]*?loadMcpServers/,
  'route.ts should default session params to empty MCP servers and only load host MCPs for non-relay agents',
);

assert.doesNotMatch(
  routeSource,
  /proc\.rpc(?:!)?\.send\('session\/(?:new|load)',\s*\{\s*(?:sessionId:\s*[^,]+,\s*)?cwd:\s*proc\.cachedCwd,\s*mcpServers\s*\}/,
  'session/new and session/load should use the shared session params helper instead of passing loaded MCP servers directly',
);

console.log('session MCP routing checks passed');
