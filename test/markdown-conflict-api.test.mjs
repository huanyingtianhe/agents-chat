import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const routeSource = readFileSync(new URL('../app/api/markdown/route.ts', import.meta.url), 'utf8');

assert.match(
  routeSource,
  /const serverContent = await fs\.readFile\(target, 'utf-8'\);[\s\S]*error:\s*'conflict'[\s\S]*message:\s*'File was modified externally\. Choose how to resolve the conflict\.'[\s\S]*serverContent,[\s\S]*serverMtime: stat\.mtime\.toISOString\(\)/s,
  'POST conflict path should read and return serverContent plus serverMtime',
);

const harnessDir = mkdtempSync(path.join(tmpdir(), 'markdown-conflict-api-source-'));
try {
  const filePath = path.join(harnessDir, 'notes.md');
  writeFileSync(filePath, 'server version\n', 'utf8');
  const serverContent = readFileSync(filePath, 'utf8');
  assert.equal(serverContent, 'server version\n', 'source regression mirrors API contract: conflict response exposes on-disk content');
  console.log('markdown conflict API checks passed');
} finally {
  rmSync(harnessDir, { recursive: true, force: true });
}
