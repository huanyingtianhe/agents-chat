import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const routeSource = readFileSync(new URL('../app/api/markdown/route.ts', import.meta.url), 'utf8');

assert.doesNotMatch(
  routeSource,
  /MAX_FILES|result\.length\s*>=|files\.slice\s*\(/,
  'Files tab should not impose an artificial file-count limit when listing agent files',
);

assert.match(
  routeSource,
  /MAX_DEPTH/,
  'Files tab should keep traversal safety guards such as depth limits while removing count limits',
);

console.log('markdown file count limit checks passed');
