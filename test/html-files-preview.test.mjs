import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const routeSource = readFileSync(new URL('../app/api/markdown/route.ts', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

const skipExtensionsMatch = routeSource.match(/const SKIP_EXTENSIONS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(skipExtensionsMatch, 'Files API should define skipped binary extensions explicitly');
const skippedExtensions = skipExtensionsMatch[1];
assert.doesNotMatch(skippedExtensions, /['"]\.html['"]/, 'Files API should not skip .html files when listing agent files');
assert.doesNotMatch(skippedExtensions, /['"]\.htm['"]/, 'Files API should not skip .htm files when listing agent files');
assert.match(
  routeSource,
  /const kind = ext === '\.html' \|\| ext === '\.htm' \? 'html'/,
  'HTML reads should be identified as kind=html so the UI can render them as HTML',
);
assert.match(uiSource, /function isHtmlFile/, 'Files UI should detect HTML files separately from markdown');
assert.match(uiSource, /sandbox=""/, 'Rendered HTML preview should use a sandboxed iframe');
assert.match(uiSource, /srcDoc=\{mdFileContent\}/, 'Rendered HTML preview should feed the selected file content to the iframe');
assert.match(uiSource, /mdPreviewBadge/, 'HTML preview should be labeled as rendered HTML in the toolbar');

console.log('html files listing and rendered preview checks passed');
