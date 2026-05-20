import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function stripComments(content) {
  let result = content.replace(/\/\/.*$/gm, '');
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

function lineCount(relativePath) {
  const content = read(relativePath);
  if (!content) return 0;
  if (content === '\n' || content === '\r\n') return 1;
  const newlineCount = (content.match(/\r?\n/g) || []).length;
  return content.endsWith('\n') || content.endsWith('\r\n') ? newlineCount : newlineCount + 1;
}

function listFiles(relativeDir, predicate) {
  const dir = join(root, relativeDir);
  if (!existsSync(dir)) {
    assert.ok(false, `Directory must exist: ${relativeDir}`);
  }
  const results = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    const relative = join(relativeDir, entry).replaceAll('\\', '/');
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      results.push(...listFiles(relative, predicate));
    } else if (predicate(relative)) {
      results.push(relative);
    }
  }
  return results;
}

const pageSource = read('app/page.tsx');
const pageSourceNoComments = stripComments(pageSource);
const layoutSource = read('app/layout.tsx');
const clientPath = 'app/features/chat/ChatPageClient.tsx';
const pageLineCount = lineCount('app/page.tsx');

assert.ok(pageLineCount < 200, `app/page.tsx must stay below 200 lines; found ${pageLineCount}`);
assert.ok(existsSync(join(root, clientPath)), 'ChatPageClient.tsx must exist as the top-level client composition component');
const clientLineCount = lineCount(clientPath);
assert.ok(clientLineCount < 300, `ChatPageClient.tsx must stay below 300 lines; found ${clientLineCount}`);

assert.match(pageSourceNoComments, /import \{ ChatPageClient \} from '\.\/features\/chat\/ChatPageClient';/);
assert.match(pageSourceNoComments, /<ChatPageClient\s*(?:\/|[^>]*?>)/);
assert.doesNotMatch(pageSourceNoComments, /useState|useEffect|useCallback|useMemo|ReactMarkdown|TurndownService|acpApi|ChatComposer|ChatSidebarList|FailedSendActions/);

const forbiddenReplacementNames = [
  'app/features/chat/ChatApp.tsx',
  'app/features/chat/LegacyPage.tsx',
  'app/features/chat/PageImplementation.tsx',
  'app/features/chat/ChatPageImplementation.tsx',
];

for (const relativePath of forbiddenReplacementNames) {
  assert.equal(existsSync(join(root, relativePath)), false, `${relativePath} would be a giant replacement anti-pattern`);
}

const guardedNewCodeFiles = [
  'app/features/chat/ChatPageClient.tsx',
  'app/features/chat/runtime/chatRuntimeTypes.ts',
  'app/features/chat/runtime/chatRunLoop.ts',
  'app/features/chat/runtime/sessionPersistence.ts',
  'app/features/chat/runtime/useComposerState.ts',
  'app/features/chat/runtime/usePageUIState.ts',
  'app/features/chat/runtime/useAgentRegistry.ts',
  'app/features/chat/runtime/useChatRuntime.ts',
  'app/features/composer/components/ComposerTargetControls.tsx',
  'app/features/messages/messageTypes.ts',
  'app/features/messages/markdownHelpers.tsx',
  'app/features/messages/components/AgentUserRequestCard.tsx',
  'app/features/messages/components/MessageBubble.tsx',
  'app/features/messages/components/MessageContentParts.tsx',
  'app/features/messages/components/MessageList.tsx',
  'app/features/messages/components/MessageToolCall.tsx',
  'app/features/files/hooks/useFileWorkspaceState.ts',
  'app/features/files/hooks/useFileComments.ts',
  'app/features/files/hooks/useLiveEditorSelection.ts',
  'app/features/files/components/FileWorkspacePanel.tsx',
  'app/features/files/components/FileTreePanel.tsx',
  'app/features/files/components/FileEditorPanel.tsx',
  'app/features/files/components/FileCommentSidebar.tsx',
  'app/features/agents/hooks/useAgentPanelState.ts',
  'app/features/agents/components/AgentsPanel.tsx',
  'app/features/nodes/hooks/useNodePanelState.ts',
  'app/features/nodes/components/NodesPanel.tsx',
  'app/features/layout/components/ChatShell.tsx',
  'app/features/layout/components/PageHeader.tsx',
  'app/features/layout/components/StatusBar.tsx',
  'app/features/layout/components/ThemeMenu.tsx',
  'app/features/layout/components/ShareDialog.tsx',
  'app/features/layout/components/ImageLightbox.tsx',
];

for (const relativePath of guardedNewCodeFiles) {
  assert.ok(existsSync(join(root, relativePath)), `${relativePath} must exist`);
  assert.ok(lineCount(relativePath) <= 500, `${relativePath} must stay at or below 500 lines; found ${lineCount(relativePath)}`);
}

const allNewFeatureCode = [
  ...listFiles('app/features/chat/runtime', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/messages', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/files/hooks', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/files/components', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/layout/components', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/agents/hooks', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/agents/components', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/nodes/hooks', (path) => /\.(ts|tsx)$/.test(path)),
  ...listFiles('app/features/nodes/components', (path) => /\.(ts|tsx)$/.test(path)),
];

for (const relativePath of allNewFeatureCode) {
  assert.ok(lineCount(relativePath) <= 500, `${relativePath} must stay at or below 500 lines`);
}

assert.match(layoutSource, /import '\.\/features\/messages\/components\/MessageList\.css';/);
assert.match(layoutSource, /import '\.\/features\/files\/components\/FileWorkspacePanel\.css';/);
assert.match(layoutSource, /import '\.\/features\/agents\/components\/AgentsPanel\.css';/);
assert.match(layoutSource, /import '\.\/features\/nodes\/components\/NodesPanel\.css';/);
assert.match(layoutSource, /import '\.\/features\/layout\/components\/ChatShell\.css';/);

console.log('page under 200 domain refactor checks passed');
