import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/markdown/route.ts', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /error:\s*'conflict'[\s\S]*serverContent[\s\S]*serverMtime/s,
  'POST /api/markdown conflict response should include serverContent and serverMtime so the UI can resolve manually',
);

for (const expected of [
  'type MdConflictState',
  'setMdConflict({',
  'resolveMdConflictByReload',
  'beginManualMdConflictResolution',
  'keep server',
  'keep mine',
  'saveMdFile(mdConflictResolvedContent, mdConflict.serverMtime)',
  'mdConflictDialog',
  'mdConflictDiffPage',
]) {
  assert.ok(uiSource.includes(expected), `UI should include conflict resolution support: ${expected}`);
}

assert.match(
  uiSource,
  /File changed on disk[\s\S]*Reload[\s\S]*Handle conflict manually/s,
  'Conflict modal should offer Reload and Handle conflict manually choices',
);

console.log('markdown conflict resolution checks passed');
