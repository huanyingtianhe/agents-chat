import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/markdown/route.ts', import.meta.url), 'utf8');
const fileEditorSource = readFileSync(new URL('../app/features/files/components/FileEditorPanel.tsx', import.meta.url), 'utf8');
const fileHelpersSource = readFileSync(new URL('../app/features/files/fileWorkspaceHelpers.ts', import.meta.url), 'utf8');

const skipExtensionsMatch = routeSource.match(/const SKIP_EXTENSIONS = new Set\(\[([\s\S]*?)\]\);/);
assert.ok(skipExtensionsMatch, 'Files API should define skipped binary extensions explicitly');
for (const extension of ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']) {
  assert.doesNotMatch(
    skipExtensionsMatch[1],
    new RegExp(`['"]\\${extension}['"]`),
    `Files API should list supported image extension ${extension}`,
  );
}

assert.match(
  routeSource,
  /MAX_IMAGE_PREVIEW_BYTES/,
  'Image previews should have an explicit size limit',
);
assert.match(
  routeSource,
  /toString\('base64'\)/,
  'Local image previews should be encoded without interpreting binary data as UTF-8',
);
assert.match(
  routeSource,
  /kind:\s*'image'/,
  'Image preview responses should identify their kind',
);
assert.match(fileHelpersSource, /function isImageFile/, 'Files UI should classify supported image files');
assert.match(fileEditorSource, /className="mdImagePreview"/, 'Files UI should render an image preview');
assert.match(fileEditorSource, /alt=\{filePath\}/, 'Image previews should have an accessible filename');

console.log('image files listing and preview checks passed');
