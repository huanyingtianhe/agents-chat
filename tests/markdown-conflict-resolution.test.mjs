import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/markdown/route.ts', import.meta.url), 'utf8');
const fileEditorSource = readFileSync(new URL('../app/features/files/components/FileEditorPanel.tsx', import.meta.url), 'utf8');
const fileWorkspaceStateSource = readFileSync(new URL('../app/features/files/hooks/useFileWorkspaceState.ts', import.meta.url), 'utf8');
const fileTypesSource = readFileSync(new URL('../app/features/files/fileWorkspaceTypes.ts', import.meta.url), 'utf8');

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
  const source = expected === 'type MdConflictState'
    ? fileTypesSource
    : ['keep server', 'keep mine', 'mdConflictDialog', 'mdConflictDiffPage'].includes(expected)
      ? fileEditorSource
      : expected === 'saveMdFile(mdConflictResolvedContent, mdConflict.serverMtime)'
        ? fileWorkspaceStateSource.replace(/\s+/g, '')
      : fileWorkspaceStateSource;
  const needle = expected === 'saveMdFile(mdConflictResolvedContent, mdConflict.serverMtime)'
    ? expected.replace(/\s+/g, '')
    : expected;
  assert.ok(source.includes(needle), `UI should include conflict resolution support: ${expected}`);
}

assert.match(
  fileEditorSource,
  /File changed on disk[\s\S]*Reload[\s\S]*Handle conflict manually/s,
  'Conflict modal should offer Reload and Handle conflict manually choices',
);

console.log('markdown conflict resolution checks passed');
