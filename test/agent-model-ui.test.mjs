import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

function cssBlock(selector) {
  const globalSelector = `:global(${selector})`;
  const escapedSelectors = [globalSelector, selector].map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const match = pageSource.match(new RegExp(`(?:${escapedSelectors.join('|')})\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected CSS block for ${selector}`);
  return match[1];
}

assert.match(
  pageSource,
  /type\s+AgentModel\s*=\s*\{[\s\S]*?modelId:\s*string;[\s\S]*?name\?:\s*string;[\s\S]*?description\?:\s*string;[\s\S]*?\};/,
  'frontend should define AgentModel metadata returned by list-agents',
);

assert.match(
  pageSource,
  /type\s+Agent\s*=\s*\{[\s\S]*?models\?:\s*AgentModel\[\];[\s\S]*?defaultModelId\?:\s*string;[\s\S]*?\};/,
  'Agent type should include persisted models/defaultModelId for selectors',
);

assert.match(
  pageSource,
  /const \[selectedAgentModels, setSelectedAgentModels\] = useState<Record<string, string>>\(\{\}\)/,
  'page should track selected model per agent',
);

assert.match(
  pageSource,
  /function\s+getSelectedModelIdForAgent\(agentId:\s*string\)[\s\S]*?selectedAgentModels\[agentId\][\s\S]*?agent\.defaultModelId/s,
  'frontend should resolve selected model from user choice or agent defaultModelId',
);

assert.match(
  pageSource,
  /sendBody\.modelId\s*=\s*getSelectedModelIdForAgent\(agentId\)/,
  'sendAcpPrompt should include selected modelId in the ACP send request body',
);

assert.match(
  pageSource,
  /async function\s+setSelectedModelForAgent\(agentId:\s*string,\s*modelId:\s*string\)[\s\S]*?action:\s*'update-agent-config'[\s\S]*?updates:\s*\{\s*defaultModelId:\s*modelId\s*\}[\s\S]*?setAgents\(/s,
  'composer model selection should persist the selected model as the agent default and refresh agent state',
);

assert.doesNotMatch(
  pageSource,
  /data-testid="agent-settings-default-model-select"|<span>Default Model<\/span>/,
  'Agent Settings should not expose a separate Default Model selector; users set it from the composer model picker',
);

assert.match(
  pageSource,
  /async function\s+ensureAgentModels\(agentId:\s*string\)[\s\S]*?action:\s*'ensure-agent-models'[\s\S]*?chatId:\s*currentChatIdRef\.current[\s\S]*?setAgents\(/s,
  'composer should ask the backend to ensure empty model lists via session/new bound to the current chat',
);

assert.match(
  pageSource,
  /useEffect\(\(\) => \{[\s\S]*?composerTargetAgentIds[\s\S]*?getAgentModels\(agentId\)\.length === 0[\s\S]*?ensureAgentModels\(agentId\)/s,
  'composer target changes should trigger model discovery for agents with empty cached model lists',
);

assert.doesNotMatch(
  pageSource,
  /async function\s+refreshAgentModels|action:\s*'detect-agent-models'|Refresh models|agentModelsSection|agentModelsHeader|agentModelsList|agentModelRow/s,
  'Agent Settings should not include model discovery/listing functionality; model choice lives in the composer only',
);

assert.doesNotMatch(
  pageSource,
  /models:\s*settingsAgentConfig\.models|defaultModelId:\s*settingsAgentConfig\.defaultModelId/,
  'saveAgentSettings should not persist model fields from Agent Settings',
);

assert.doesNotMatch(
  pageSource,
  /<h3[^>]*>🧠 Models<\/h3>|settingsAgentConfig\.models|settingsAgentConfig\.defaultModelId/s,
  'Agent Settings modal should not render model-related content',
);

assert.match(
  pageSource,
  /data-testid="agent-model-select"/,
  'model selector should expose a stable test id for E2E coverage',
);

assert.match(
  cssBlock('.agentModelSelect'),
  /appearance:\s*none;[\s\S]*?background-image:\s*none;/,
  'model selector should suppress the native/custom arrow so it cannot introduce a mismatched accent color',
);

assert.match(
  cssBlock('.agentModelSelect:hover'),
  /background-color:\s*color-mix\(in srgb, var\(--accent\) 8%, transparent\);[\s\S]*?box-shadow:\s*0 0 0 2px var\(--accent-soft\);/,
  'model selector should have a styled hover state instead of the browser default',
);

assert.match(
  cssBlock('.agentModelSelect:focus'),
  /background-color:\s*color-mix\(in srgb, var\(--accent\) 10%, transparent\);[\s\S]*?box-shadow:\s*0 0 0 2px var\(--accent-soft\), 0 4px 12px color-mix\(in srgb, var\(--accent\) 18%, transparent\);/,
  'model selector should have a visible focus state consistent with existing dropdowns',
);

assert.match(
  pageSource,
  /const selectedModel = models\.find\(\(model\) => model\.modelId === selectedModelId\) \|\| models\[0\];[\s\S]*?const selectedModelLabel = selectedModel\?\.name \|\| selectedModel\?\.modelId \|\| '';[\s\S]*?const modelSelectWidthCh = Math\.max\(6, Math\.min\(18, selectedModelLabel\.length \+ 2\)\);/,
  'model selector should derive a compact width from the currently selected model label',
);

assert.match(
  pageSource,
  /style=\{\{ width: `\$\{modelSelectWidthCh\}ch` \}\}/,
  'model selector should apply a dynamic ch width so short model names render tighter',
);

assert.match(
  cssBlock('.agentModelSelect'),
  /background:\s*transparent;[\s\S]*?color:\s*inherit;[\s\S]*?max-width:\s*18ch;[\s\S]*?min-width:\s*6ch;/,
  'composer model selector should be compact and inherit the surrounding target pill theme background/color',
);

assert.doesNotMatch(
  cssBlock('.agentModelSelect'),
  /%2345d7ff|color:\s*var\(--accent\)/,
  'model selector must not hard-code the Aurora accent or override the target pill color',
);

assert.match(
  cssBlock('.agentModelSelect'),
  /background-image:\s*none;/,
  'model selector should not use a fixed-color SVG arrow that can mismatch the current theme',
);

assert.match(
  cssBlock('.agentModelSelect option'),
  /background:\s*var\(--panel-soft\);[\s\S]*?color:\s*var\(--text\);/,
  'model selector dropdown options should match the current theme dropdown panel color',
);

console.log('agent model UI checks passed');
