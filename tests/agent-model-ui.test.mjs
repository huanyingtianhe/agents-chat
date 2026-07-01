import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// After Tasks 7 & 8, agent model logic was extracted from page.tsx into focused modules.
const agentTypesSource = readFileSync(new URL('../app/features/agents/agentTypes.ts', import.meta.url), 'utf8');
const agentRegistrySource = readFileSync(new URL('../app/features/chat/runtime/useAgentRegistry.ts', import.meta.url), 'utf8');
const chatAcpServiceSource = readFileSync(new URL('../app/features/chat/runtime/chatAcpService.ts', import.meta.url), 'utf8');
const chatPageClientSource = readFileSync(new URL('../app/features/chat/ChatPageClient.tsx', import.meta.url), 'utf8');
const modelSelectSource = readFileSync(new URL('../app/features/agents/components/AgentModelSelect.tsx', import.meta.url), 'utf8');
const agentsPanelSource = readFileSync(new URL('../app/features/agents/components/AgentsPanel.tsx', import.meta.url), 'utf8');
const agentsPanelCssSource = readFileSync(new URL('../app/features/agents/components/AgentsPanel.css', import.meta.url), 'utf8');
const combinedSource = `${chatPageClientSource}\n${modelSelectSource}\n${agentTypesSource}`;

// CSS in AgentsPanel.css uses .chatPageRoot-prefixed selectors (not styled-jsx :global()).
function cssBlock(selector) {
  const prefixedSelector = `.chatPageRoot ${selector}`;
  const escaped = prefixedSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = agentsPanelCssSource.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected CSS block for ${selector} in AgentsPanel.css`);
  return match[1];
}

// 1. Agent/AgentModel types include model metadata.
assert.match(
  agentTypesSource,
  /type\s+AgentModel\s*=\s*\{[\s\S]*?modelId:\s*string;[\s\S]*?name\?:\s*string;[\s\S]*?description\?:\s*string;[\s\S]*?\};/,
  'frontend should define AgentModel metadata returned by list-agents',
);

assert.match(
  agentTypesSource,
  /type\s+Agent\s*=\s*\{[\s\S]*?models\?:\s*AgentModel\[\];[\s\S]*?defaultModelId\?:\s*string;[\s\S]*?\};/,
  'Agent type should include persisted models/defaultModelId for selectors',
);

// 2. Selected model state is per-agent, lives in useAgentRegistry.
assert.match(
  agentRegistrySource,
  /const \[selectedAgentModels, setSelectedAgentModels\] = useState<Record<string, string>>\(\{\}\)/,
  'useAgentRegistry should track selected model per agent',
);

// 3. Selected model resolves from user choice or agent default/model fallback (ChatPageClient wires the resolver).
assert.match(
  chatPageClientSource,
  /getSelectedModelIdRef\.current\s*=[\s\S]*?selectedAgentModels\[agentId\][\s\S]*?agent\.defaultModelId/s,
  'ChatPageClient should resolve selected model from user choice or agent defaultModelId',
);

// 4. ACP send request includes selected modelId (chatAcpService builds the send body).
assert.match(
  chatAcpServiceSource,
  /sendBody\.modelId\s*=\s*ctx\.getSelectedModelIdForAgent\(agentId\)/,
  'sendAcpPrompt should include selected modelId in the ACP send request body',
);

// 5. Selecting a model updates state and persists via set-model-pref (useAgentRegistry).
assert.match(
  agentRegistrySource,
  /function\s+setSelectedModelForAgent\(agentId:\s*string,\s*modelId:\s*string\)[\s\S]*?setSelectedAgentModels[\s\S]*?action:\s*'set-model-pref'[\s\S]*?agentId[\s\S]*?modelId/s,
  'composer model selection should update local state and persist via per-user model preference',
);

// 6. Agent Settings does NOT expose a separate Default Model selector.
assert.doesNotMatch(
  agentsPanelSource,
  /data-testid="agent-settings-default-model-select"|<span>Default Model<\/span>/,
  'Agent Settings should not expose a separate Default Model selector; users set it from the composer model picker',
);

// 7. ensure-agent-models is called with current chat/session (useAgentRegistry).
assert.match(
  agentRegistrySource,
  /async function\s+ensureAgentModels\(agentId:\s*string,\s*opts:\s*EnsureAgentModelsOptions\)[\s\S]*?currentChatId[\s\S]*?action:\s*'ensure-agent-models'[\s\S]*?agentId[\s\S]*?chatId[\s\S]*?setAgents\(/s,
  'useAgentRegistry should ask the backend to ensure empty model lists via session/new bound to the current chat',
);

// 8. Composer target changes trigger model discovery (ChatPageClient useEffect).
assert.match(
  chatPageClientSource,
  /useEffect\(\(\) => \{[\s\S]*?composerTargetAgentIds[\s\S]*?\.models[\s\S]*?\.length === 0[\s\S]*?ensureAgentModels\(agentId/s,
  'composer target changes should trigger model discovery for agents with empty cached model lists',
);

// 9. Agent Settings does NOT include model discovery/listing functionality.
assert.doesNotMatch(
  agentsPanelSource,
  /async function\s+refreshAgentModels|action:\s*'detect-agent-models'|Refresh models|agentModelsSection|agentModelsHeader|agentModelsList|agentModelRow/s,
  'Agent Settings should not include model discovery/listing functionality; model choice lives in the composer only',
);

assert.doesNotMatch(
  agentsPanelSource,
  /models:\s*settingsAgentConfig\.models|defaultModelId:\s*settingsAgentConfig\.defaultModelId/,
  'saveAgentSettings should not persist model fields from Agent Settings',
);

assert.doesNotMatch(
  agentsPanelSource,
  /<h3[^>]*>🧠 Models<\/h3>|settingsAgentConfig\.models|settingsAgentConfig\.defaultModelId/s,
  'Agent Settings modal should not render model-related content',
);

// 10. Model selector exposes stable test id for E2E coverage.
assert.match(
  combinedSource,
  /data-testid="agent-model-select"/,
  'model selector should expose a stable test id for E2E coverage',
);

// 10b. Model dropdown is portaled so mobile horizontal pill scrolling cannot clip it.
assert.match(
  modelSelectSource,
  /import \{ createPortal \} from 'react-dom';/,
  'model dropdown should use a portal instead of rendering inside the scrollable target pills row',
);
assert.match(
  modelSelectSource,
  /const portalHost = typeof document !== 'undefined' \? localWrapRef\.current\?\.closest\('\.page'\) \|\| document\.querySelector\('\.chatPageRoot \.page'\) \|\| document\.body : null;/,
  'model dropdown portal should render inside the current themed .page so theme variables still apply',
);
assert.match(
  modelSelectSource,
  /createPortal\(dropdown, portalHost\)/,
  'model dropdown portal should render the dropdown into the resolved portal host',
);
assert.match(
  modelSelectSource,
  /onMouseDown=\{\(event\) => event\.stopPropagation\(\)\}/,
  'portaled model dropdown should stop mousedown propagation so outside-click handling does not close it before option clicks',
);

// 11. Model selector CSS — base styles (border, background, cursor).
assert.match(
  cssBlock('.agentModelSelect'),
  /border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?cursor:\s*pointer;/,
  'model selector should be a styled button with transparent background',
);

// 12. Model selector CSS — hover state (AgentsPanel.css uses .chatPageRoot prefix, not :global()).
assert.match(
  agentsPanelCssSource,
  /\.chatPageRoot \.agentModelSelect:hover[^{]*\{[^}]*background-color:\s*color-mix\(in srgb, var\(--accent\) 8%, transparent\);[^}]*box-shadow:\s*0 0 0 2px var\(--accent-soft\);/s,
  'model selector should have a styled hover state instead of the browser default',
);

// 13. Model selector CSS — focus-visible state.
assert.match(
  cssBlock('.agentModelSelect:focus-visible'),
  /background-color:\s*color-mix\(in srgb, var\(--accent\) 10%, transparent\);[\s\S]*?box-shadow:\s*0 0 0 2px var\(--accent-soft\), 0 4px 12px color-mix\(in srgb, var\(--accent\) 18%, transparent\);/,
  'model selector should have a visible focus state consistent with existing dropdowns',
);

// 14. Model selector label derived from selected model (AgentModelSelect.tsx).
assert.match(
  combinedSource,
  /const selectedModel = models\.find\(\(model\) => model\.modelId === selectedModelId\) \|\| models\[0\];[\s\S]*?const selectedModelLabel = selectedModel\?\.name \|\| selectedModel\?\.modelId \|\| '';/,
  'model selector should derive a label from the currently selected model',
);

// 15. Model selector CSS — compact and inherits surrounding target pill theme.
assert.match(
  cssBlock('.agentModelSelect'),
  /background:\s*transparent;[\s\S]*?color:\s*inherit;[\s\S]*?max-width:\s*28ch;/,
  'composer model selector should be compact and inherit the surrounding target pill theme background/color',
);

// 16. Model selector CSS — must not hard-code Aurora accent.
assert.doesNotMatch(
  cssBlock('.agentModelSelect'),
  /%2345d7ff|color:\s*var\(--accent\)/,
  'model selector must not hard-code the Aurora accent or override the target pill color',
);

// 17. Portaled dropdown CSS — fixed positioning escapes mobile overflow clipping.
assert.match(
  cssBlock('.agentModelDropdownPortal'),
  /position:\s*fixed;[\s\S]*?bottom:\s*auto;/,
  'portaled model dropdown should use fixed positioning and avoid inherited absolute bottom placement',
);

console.log('agent model UI checks passed');
