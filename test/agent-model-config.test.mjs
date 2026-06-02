import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const configStoreSource = readFileSync(new URL('../lib/configStore.ts', import.meta.url), 'utf8');
const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../lib/acp/types.ts', import.meta.url), 'utf8');
const modelsSource = readFileSync(new URL('../lib/acp/models.ts', import.meta.url), 'utf8');

assert.match(
  configStoreSource,
  /export\s+type\s+AgentModel\s*=\s*\{[\s\S]*?modelId:\s*string;[\s\S]*?name\?:\s*string;[\s\S]*?description\?:\s*string;[\s\S]*?\};/,
  'configStore should define an AgentModel shape for persisted model metadata',
);

assert.match(
  configStoreSource,
  /models:\s*AgentModel\[\];[\s\S]*?defaultModelId:\s*string;/,
  'AgentRecord should expose models and defaultModelId',
);

assert.match(
  configStoreSource,
  /CREATE TABLE IF NOT EXISTS agents[\s\S]*?models\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'\[\]'[\s\S]*?default_model_id\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''/,
  'fresh SQLite agents table should persist models and default_model_id columns',
);

assert.match(
  configStoreSource,
  /ALTER TABLE agents ADD COLUMN models TEXT NOT NULL DEFAULT '\[\]'/,
  'existing SQLite agents tables should migrate in a models column',
);

assert.match(
  configStoreSource,
  /ALTER TABLE agents ADD COLUMN default_model_id TEXT NOT NULL DEFAULT ''/,
  'existing SQLite agents tables should migrate in a default_model_id column',
);

assert.match(
  configStoreSource,
  /function\s+normalizeAgentModels\(input:\s*unknown\):\s*AgentModel\[\][\s\S]*?seen\.has\(modelId\)[\s\S]*?description/,
  'configStore should normalize, trim, and de-duplicate persisted model metadata',
);

assert.match(
  configStoreSource,
  /function\s+parseAgentModels\(raw:\s*unknown\):\s*AgentModel\[\][\s\S]*?JSON\.parse\(raw\)[\s\S]*?catch[\s\S]*?return \[\]/,
  'row parsing should defensively parse model JSON and fall back to []',
);

assert.match(
  configStoreSource,
  /const models = parseAgentModels\(row\.models\);[\s\S]*models,/,
  'rowToAgent should parse stored model JSON into AgentRecord.models',
);

assert.match(
  configStoreSource,
  /defaultModelId:\s*normalizeDefaultModelId\(row\.default_model_id,\s*models\)/,
  'rowToAgent should expose a validated persisted default model id',
);

assert.match(
  configStoreSource,
  /INSERT OR IGNORE INTO agents \([\s\S]*models, default_model_id[\s\S]*normalizeAgentModels\(a\.models\)[\s\S]*normalizeDefaultModelId\(a\.defaultModelId,\s*models\)/,
  'agents.json import should persist supplied models and defaultModelId',
);

assert.match(
  configStoreSource,
  /INSERT INTO agents \([\s\S]*models, default_model_id[\s\S]*JSON\.stringify\(models\)[\s\S]*defaultModelId/,
  'createAgent should persist supplied models and defaultModelId',
);

assert.match(
  configStoreSource,
  /if \(updates\.models !== undefined\) \{[\s\S]*fields\.push\('models = \?'\)[\s\S]*JSON\.stringify\(models\)[\s\S]*\}/,
  'updateAgent should allow updating persisted models',
);

assert.match(
  configStoreSource,
  /if \(updates\.defaultModelId !== undefined\) \{[\s\S]*fields\.push\('default_model_id = \?'\)[\s\S]*normalizeDefaultModelId\(updates\.defaultModelId[\s\S]*\}/,
  'updateAgent should allow updating a validated default model id',
);

assert.match(
  typesSource,
  /type\s+AgentModel\s*=\s*configStore\.AgentModel/,
  'lib/acp/types.ts should export AgentModel type from configStore',
);

assert.match(
  routeSource,
  /models:\s*a\.models,[\s\S]*?defaultModelId:\s*a\.defaultModelId,/,
  'readAgentsConfig/getAgentById should expose models and defaultModelId from SQLite',
);

assert.match(
  routeSource,
  /function\s+readAgentsConfig\([\s\S]*?public:\s*a\.public,[\s\S]*?function\s+getAgentById/,
  'readAgentsConfig should expose the persisted public flag from SQLite',
);

assert.match(
  routeSource,
  /function\s+getAgentById\([\s\S]*?public:\s*a\.public,[\s\S]*?env:/,
  'get-agent-config should expose the persisted public flag from SQLite',
);

assert.match(
  routeSource,
  /const base = \{[\s\S]*?models:\s*a\.models[\s\S]*?defaultModelId:\s*a\.defaultModelId[\s\S]*?\}/,
  'list-agents should return persisted models/defaultModelId for agent selection UI',
);

assert.match(
  routeSource,
  /configStore\.updateAgent\(agentId, \{[\s\S]*?models:\s*updates\.models,[\s\S]*?defaultModelId:\s*updates\.defaultModelId,[\s\S]*?\}\)/,
  'update-agent-config should persist edited models/defaultModelId',
);

assert.match(
  routeSource,
  /configStore\.createAgent\(\{[\s\S]*?models:\s*newAgent\.models,[\s\S]*?defaultModelId:\s*newAgent\.defaultModelId,[\s\S]*?\}\)/,
  'create-agent should persist models/defaultModelId supplied by the add-agent flow',
);

assert.match(
  modelsSource,
  /export\s+function\s+syncAgentModelsFromSessionResult\(agentId:\s*string,\s*sessionResult:\s*unknown\)[\s\S]*?availableModels[\s\S]*?configStore\.updateAgent\(agentId, \{[\s\S]*?models[\s\S]*?defaultModelId/s,
  'lib/acp/models.ts should export syncAgentModelsFromSessionResult to sync availableModels/currentModelId back to SQLite',
);

assert.match(
  routeSource,
  /const result = await proc\.rpc\.send\('session\/new', sessionParams\);[\s\S]*?syncAgentModelsFromSessionResult\(agentId, result\)/,
  'ensureUserSession should refresh persisted models from session/new',
);

assert.match(
  routeSource,
  /if \(action === 'ensure-agent-models'\)[\s\S]*?if \(\(config\.models \|\| \[\]\)\.length > 0\)[\s\S]*?chatId[\s\S]*?session\/new[\s\S]*?syncAgentModelsFromSessionResult\(agentId, session\)[\s\S]*?pushChatSession\(sess, chatId, session\.sessionId\)[\s\S]*?updateChatAgentSession\(userId, chatId, agentId, session\.sessionId\)/s,
  'ensure-agent-models should only create session/new when cached models are empty, sync models, and bind the new session to the current chat',
);

assert.doesNotMatch(
  routeSource,
  /if \(action === 'detect-agent-models'\)/,
  'manual detect-agent-models endpoint should be removed with Agent Settings model UI',
);

assert.match(
  routeSource,
  /requestedModelId\s*=\s*validateRequestedModel\(config,\s*body\?\.modelId\)/,
  'send should read and validate the requested modelId from the request body',
);

assert.match(
  routeSource,
  /await applySessionModelIfRequested\(proc,\s*sess\.sessionId,\s*requestedModelId\)[\s\S]*?const turn = sendPrompt/,
  'send should apply the selected model after session creation/load and before session/prompt',
);

console.log('agent model config persistence checks passed');
