import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /function buildSessionParams\s*\([\s\S]*?mcpServers:\s*\[\][\s\S]*?!proc\.config\.noTools\s*&&\s*!proc\.config\.relay[\s\S]*?loadMcpServers/,
  'route.ts should default session params to empty MCP servers and only load host MCPs for non-relay agents',
);

assert.match(
  routeSource,
  /function normalizeMcpServerConfig\(name:\s*string,\s*cfg:\s*Record<string, unknown>\)[\s\S]*?type === 'http' \|\| type === 'sse'[\s\S]*?url[\s\S]*?headers:\s*normalizeMcpHeaders\(cfg\.headers\)[\s\S]*?command[\s\S]*?normalizeMcpStringArray\(cfg\.args\)/,
  'route.ts should preserve HTTP/SSE MCP server type/url/headers and only emit stdio MCP servers when command is present',
);

assert.match(
  routeSource,
  /\.map\(\(\[name, cfg\]\) => normalizeMcpServerConfig\(name, cfg\)\)\s*\.filter\(\(server\): server is Record<string, unknown> => !!server\)/,
  'loadMcpServers should skip malformed MCP server entries after normalization',
);

assert.doesNotMatch(
  routeSource,
  /proc\.rpc(?:!)?\.send\('session\/(?:new|load)',\s*\{\s*(?:sessionId:\s*[^,]+,\s*)?cwd:\s*proc\.cachedCwd,\s*mcpServers\s*\}/,
  'session/new and session/load should use the shared session params helper instead of passing loaded MCP servers directly',
);

console.log('session MCP routing checks passed');
