import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'app/features/agents/agentTypes.ts',
  'app/features/theme/themes.ts',
  'app/features/files/fileWorkspaceTypes.ts',
  'app/features/files/fileWorkspaceHelpers.ts',
  'app/features/composer/attachmentTypes.ts',
  'app/features/composer/attachmentHelpers.ts',
  'app/features/chat/chatTypes.ts',
  'app/features/chat/chatHelpers.ts',
  'app/features/chat/chatApi.ts',
  'app/features/agents/components/AgentModelSelect.tsx',
  'app/features/composer/components/AttachmentList.tsx',
  'lib/acp/types.ts',
  'lib/acp/attachments.ts',
  'lib/acp/rpc.ts',
  'lib/acp/terminalTools.ts',
  'lib/acp/fsTools.ts',
  'lib/acp/runtimeState.ts',
  'lib/acp/models.ts',
];

for (const file of requiredFiles) {
  assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} should exist`);
}

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../app/features/chat/ChatPageClient.tsx', import.meta.url), 'utf8');
const useComposerStateSource = readFileSync(new URL('../app/features/chat/runtime/useComposerState.ts', import.meta.url), 'utf8');
const usePageUIStateSource = readFileSync(new URL('../app/features/chat/runtime/usePageUIState.ts', import.meta.url), 'utf8');
const composerTargetControlsSource = readFileSync(new URL('../app/features/composer/components/ComposerTargetControls.tsx', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');
const useFileWorkspaceStateSource = readFileSync(new URL('../app/features/files/hooks/useFileWorkspaceState.ts', import.meta.url), 'utf8');

assert.match(pageSource, /from ['"]\.\/features\/chat\/ChatPageClient['"]/, 'page should import the chat page client shell');
assert.match(clientSource, /from ['"]\.\.\/agents\/hooks\/useAgentPanelState['"]/, 'ChatPageClient should import agents feature hooks through feature-relative paths');
assert.match(clientSource, /from ['"]\.\/chatHelpers['"]/, 'ChatPageClient should import chat helpers from the chat feature');
assert.match(usePageUIStateSource, /from ['"]\.\.\/\.\.\/theme\/themes['"]/, 'usePageUIState should import themes from the theme feature');
assert.match(useComposerStateSource, /from ['"]\.\.\/\.\.\/composer\/attachmentHelpers['"]/, 'useComposerState should import attachment helpers from the composer feature');
assert.match(composerTargetControlsSource, /from ['"]\.\.\/\.\.\/agents\/components\/AgentModelSelect['"]/, 'ComposerTargetControls should use the extracted model selector component');
assert.match(clientSource, /from ['"]\.\.\/composer\/components\/ChatComposer['"]/, 'ChatPageClient should render the extracted composer component');

assert.match(useFileWorkspaceStateSource, /from ['"]\.\.\/fileWorkspaceHelpers['"]/, 'useFileWorkspaceState should import file workspace helpers from the files feature');

assert.match(routeSource, /from ['"]@\/lib\/acp\/attachments['"]/, 'ACP route should import attachment helpers from lib/acp/attachments');
assert.match(routeSource, /from ['"]@\/lib\/acp\/rpc['"]/, 'ACP route should import RPC helpers from lib/acp/rpc');
assert.match(routeSource, /from ['"]@\/lib\/acp\/terminalTools['"]/, 'ACP route should import terminal handlers from lib/acp/terminalTools');
assert.match(routeSource, /from ['"]@\/lib\/acp\/fsTools['"]/, 'ACP route should import file tool handlers from lib/acp/fsTools');
assert.match(routeSource, /from ['"]@\/lib\/acp\/runtimeState['"]/, 'ACP route should import runtime state from lib/acp/runtimeState');
assert.match(routeSource, /from ['"]@\/lib\/acp\/models['"]/, 'ACP route should import model helpers from lib/acp/models');

const pageLines = pageSource.split(/\r?\n/).length;
const routeLines = routeSource.split(/\r?\n/).length;
assert.ok(pageLines < 9000, `app/page.tsx should be below 9000 lines after first extraction; got ${pageLines}`);
assert.ok(routeLines < 2700, `app/api/acp/route.ts should be below 2700 lines after first extraction; got ${routeLines}`);

console.log('layered refactor structure checks passed');
