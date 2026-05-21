import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const setupTemplateModuleUrl = new URL('../lib/setupNodeTemplate.mjs', import.meta.url);
const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../lib/acp/types.ts', import.meta.url), 'utf8');
const runtimeStateSource = readFileSync(new URL('../lib/acp/runtimeState.ts', import.meta.url), 'utf8');
const routeAndRuntimeSource = `${routeSource}\n${runtimeStateSource}`;
const setupRouteSource = readFileSync(new URL('../app/api/nodes/setup/route.ts', import.meta.url), 'utf8');
const setupTemplateSource = existsSync(setupTemplateModuleUrl) ? readFileSync(setupTemplateModuleUrl, 'utf8') : '';
const setupNodeScriptSource = readFileSync(new URL('../setup-files/setup-node.ps1', import.meta.url), 'utf8');
const agentsConfigSource = readFileSync(new URL('../agents.json', import.meta.url), 'utf8');
const envExampleSource = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const readmeSource = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const agentsConfig = JSON.parse(agentsConfigSource);
const publicSetupSources = [
  setupNodeScriptSource,
  readFileSync(new URL('../test/test-node-owner.spec.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../test/test-setup-node.spec.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../docs/superpowers/specs/2026-05-18-setup-key-vault-template-design.md', import.meta.url), 'utf8'),
  readFileSync(new URL('../docs/superpowers/plans/2026-05-18-setup-key-vault-template.md', import.meta.url), 'utf8'),
].join('\n');
const concreteSetupDefaults = [
  ['7f31cba8', 'b597', '4129', 'b158', '8f21a7395bd0'].join('-'),
  ['wulei', 'test'].join('-'),
  ['agents', 'chat', 'kv'].join('-'),
  ['relay', 'connection', 'string'].join('-'),
].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
assert.ok(existsSync(setupTemplateModuleUrl), 'setup template rendering helpers should be in a runtime-testable module');
const {
  escapePowerShellDoubleQuotedString,
  renderSetupNodeScript,
} = await import(setupTemplateModuleUrl.href);
const combinedAcpSource = `${routeSource}\n${typesSource}`;
const findTurnBySessionIdSource = routeSource.slice(
  routeSource.indexOf('function findTurnBySessionId'),
  routeSource.indexOf('/* ─────────────── ACP Lifecycle ─────────────── */'),
);
const findTurnForSessionSource = routeSource.slice(
  routeSource.indexOf('function findTurnForSession'),
  routeSource.indexOf('function normalizePermissionOptions'),
);
const noToolsBranchStart = routeSource.indexOf('if (config.noTools) {');
const noToolsBranchEnd = noToolsBranchStart >= 0 ? routeSource.indexOf('return;', noToolsBranchStart) : -1;
const noToolsBranchSource = noToolsBranchStart >= 0 && noToolsBranchEnd >= 0
  ? routeSource.slice(noToolsBranchStart, noToolsBranchEnd)
  : '';
const freeformRequestHandlerIndex = routeSource.indexOf(
  "if (method === 'session/request_input' || method === 'session/request_user_input')",
);
const freeformQueuedInNoToolsBranch = /method\s*===\s*['"]session\/request_input['"]\s*\|\|\s*method\s*===\s*['"]session\/request_user_input['"][\s\S]*?queueUserRequestForTurn/.test(noToolsBranchSource);
const warmLocalAgentsActionStart = routeSource.indexOf("if (action === 'warm-local-agents')");
const warmLocalAgentsActionEnd = warmLocalAgentsActionStart >= 0
  ? routeSource.indexOf("if (action === 'get-agent-config')", warmLocalAgentsActionStart)
  : -1;
const warmLocalAgentsActionSource = warmLocalAgentsActionStart >= 0 && warmLocalAgentsActionEnd >= 0
  ? routeSource.slice(warmLocalAgentsActionStart, warmLocalAgentsActionEnd)
  : '';
const runtimeActionsStart = routeSource.indexOf('// ─── Agent runtime actions (require agentId + userId) ───');

assert.match(
  combinedAcpSource,
  /type\s+PendingUserRequest\s*=/,
  'ACP types should define a serializable PendingUserRequest type',
);

assert.match(
  combinedAcpSource,
  /type\s+PendingUserRequestQuestion\s*=/,
  'ACP types should define structured user request questions',
);

assert.match(
  combinedAcpSource,
  /questions\??:\s*PendingUserRequestQuestion\[\]/,
  'PendingUserRequest should preserve structured questions from ACP user-input requests',
);

assert.match(
  combinedAcpSource,
  /userRequest\??:\s*PendingUserRequest/,
  'TurnState should expose the pending user request through active turn state',
);

assert.match(
  routeSource,
  /sessionId\??:\s*string/,
  'TurnState should persist immutable session identity for active turns',
);

assert.match(
  routeSource,
  /userRequest:\s*turn\.userRequest/,
  'serializeTurn should include pending userRequest data for polling clients',
);

assert.match(
  routeSource,
  /function\s+persistTurnSnapshot[\s\S]*?userRequest:\s*turn\.done\s*\?\s*undefined\s*:\s*turn\.userRequest/,
  'persistTurnSnapshot should preserve pending userRequest data so waiting chats can render answer cards after reload',
);

assert.match(
  routeSource,
  /function\s+queueUserRequestForTurn[\s\S]*?turn\.userRequest\s*=\s*request;[\s\S]*?turn\.statusText\s*=\s*['"]Waiting for your response['"];[\s\S]*?scheduleTurnPersist\(turn\);/,
  'queueUserRequestForTurn should persist pending request state when the agent starts waiting for user input',
);

assert.match(
  routeSource,
  /function\s+normalizeUserRequestQuestions[\s\S]*?params\?\.questions[\s\S]*?params\?\.input\?\.questions/,
  'queueUserRequestForTurn should normalize structured questions from common ACP request shapes',
);

assert.match(
  routeSource,
  /function\s+normalizePermissionOptions[\s\S]*?params\?\.choices/,
  'user-input requests should normalize ACP choices as selectable options',
);

assert.match(
  routeSource,
  /function\s+queueUserRequestForTurn[\s\S]*?const\s+questions\s*=\s*normalizeUserRequestQuestions\(params\)[\s\S]*?questions,/,
  'queueUserRequestForTurn should attach normalized structured questions to the pending request',
);

assert.match(
  routeAndRuntimeSource,
  /type\s+PendingUserRequestResponder\s*=\s*\{[\s\S]*?createdAt:\s*number;[\s\S]*?\};[\s\S]*?const\s+pendingUserRequestGlobal\s*=\s*globalThis\s+as\s+typeof\s+globalThis\s*&\s*\{[\s\S]*?__acpPendingUserRequestResponders\?:\s*Map<string,\s*PendingUserRequestResponder>;[\s\S]*?\};[\s\S]*?function\s+getPendingUserRequestResponders\(\):\s*Map<string,\s*PendingUserRequestResponder>\s*\{[\s\S]*?pendingUserRequestGlobal\.__acpPendingUserRequestResponders\s*=\s*new\s+Map\(\);[\s\S]*?return\s+pendingUserRequestGlobal\.__acpPendingUserRequestResponders;[\s\S]*?\}[\s\S]*?const\s+pendingUserRequestResponders\s*=\s*getPendingUserRequestResponders\(\);/s,
  'route.ts should persist pending user request responders on globalThis across route reloads',
);

assert.match(
  routeAndRuntimeSource,
  /const\s+PENDING_USER_REQUEST_TIMEOUT_MS\s*=\s*10\s*\*\s*60_000;/,
  'route.ts should bound pending user requests with a timeout constant',
);

assert.match(
  routeAndRuntimeSource,
  /type\s+PendingUserRequestResponder\s*=\s*\{[\s\S]*?timeout\?:\s*ReturnType<typeof\s+setTimeout>;[\s\S]*?\}/s,
  'PendingUserRequestResponder should track the timeout handle for cleanup',
);

assert.match(
  combinedAcpSource,
  /type\s+UserSession\s*=\s*\{[\s\S]*?alwaysAllowedPermissionSessions:\s*Set<string>;/,
  'UserSession should remember ACP sessions where the user selected Always allow',
);

assert.match(
  routeSource,
  /method\s*===\s*['"]session\/request_permission['"][\s\S]*?queueUserRequestForTurn/,
  'session/request_permission should queue a user request instead of immediately approving',
);

assert.ok(
  (freeformRequestHandlerIndex >= 0 && noToolsBranchStart >= 0 && freeformRequestHandlerIndex < noToolsBranchStart)
  || freeformQueuedInNoToolsBranch,
  'session/request_input and session/request_user_input should bypass the noTools early return or be explicitly queued there',
);

assert.match(
  routeSource,
  /if\s*\(method\s*===\s*['"]session\/request_permission['"]\)\s*\{[\s\S]*?getAlwaysAllowedPermissionOption\(agentId,\s*params\s*\?\?\s*\{\}\)[\s\S]*?rpc\.respond\(id,\s*\{\s*outcome:\s*\{\s*outcome:\s*['"]selected['"],\s*optionId:\s*autoAllowOption\.optionId\s*\}\s*\}\)[\s\S]*?return;[\s\S]*?queueUserRequestForTurn/,
  'session/request_permission should auto-approve only after an Always allow grant exists, otherwise it should queue the request',
);

assert.doesNotMatch(
  routeSource,
  /method\s*===\s*['"]session\/request_input['"]\s*\|\|\s*method\s*===\s*['"]session\/request_user_input['"][\s\S]*?queueUserRequestForTurn[\s\S]*?rpc\.respond\(id,\s*\{\s*answer:\s*''\s*\}\s*\)/,
  'session/request_input and session/request_user_input should not auto-answer empty when queueing fails',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?pendingUserRequestResponders\.get/,
  'route.ts should expose a respond-user-request action that resolves the stored JSON-RPC request',
);

assert.match(
  routeSource,
  /function\s+buildUserRequestResponse[\s\S]*?request\.questions\?\.length[\s\S]*?return\s+\{\s*answers\s*\}/,
  'respond-user-request should resolve structured questions with VS Code-compatible answers',
);

assert.match(
  routeSource,
  /function\s+buildAbandonedUserRequestResponse[\s\S]*?request\.questions\?\.length[\s\S]*?skipped:\s*true/,
  'abandoned structured questions should be returned as skipped answers',
);

assert.match(
  routeSource,
  /const\s+SYNTHETIC_USER_REQUEST_METHOD\s*=\s*['"]client\/text_question['"]/,
  'route.ts should define a synthetic user request method for plain agent question prompts',
);

assert.match(
  routeSource,
  /function\s+parseTextQuestionUserRequest[\s\S]*?Please[\s\S]*?Question\s*\$\{index\s*\+\s*1\}/,
  'route.ts should parse plain agent question prompts into structured request fields',
);

assert.match(
  routeSource,
  /function\s+finishTurnAfterPromptResult[\s\S]*?queueSyntheticUserRequestFromText\(turn\)[\s\S]*?return;/,
  'finishTurnAfterPromptResult should keep the turn active when the agent output is a plain question prompt',
);

assert.match(
  routeSource,
  /function\s+buildSyntheticUserRequestFollowupPrompt[\s\S]*?User answered the questions/,
  'route.ts should build a follow-up prompt from synthetic user request answers',
);

assert.match(
  routeSource,
  /function\s+buildSyntheticUserRequestAnswerText[\s\S]*?You answered/,
  'route.ts should build visible inline answer text for synthetic user request responses',
);

assert.match(
  routeSource,
  /function\s+handleSyntheticUserRequestResponse[\s\S]*?events\.push\(\{\s*type:\s*['"]user_response['"]/,
  'synthetic user request responses should record the submitted answers in the turn event stream',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?handleSyntheticUserRequestResponse/,
  'respond-user-request should handle synthetic text-question requests even without a JSON-RPC responder',
);

assert.doesNotMatch(
  routeSource,
  /function\s+handleSyntheticUserRequestResponse[\s\S]*?turn\.fullText\s*=\s*['"][\s\S]*?turn\.events\s*=\s*\[\]/,
  'synthetic user request responses should preserve existing turn text and events so prior thinking/tool history stays visible',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?pending\.turn\.userId\s*!==\s*userId/,
  'respond-user-request should reject responses from a different user',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?(request\.agentId|pending\.agentId)\s*!==\s*agentId/,
  'respond-user-request should reject responses posted to the wrong agent',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?canTalkTo\(token,\s*requestAgent\.owner,\s*(requestAgentId|request\.agentId),\s*requestAgent\.public,\s*configStore\.hasAgentAccess\)/,
  'respond-user-request should reuse agent access checks before resolving the RPC request',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?!request\s*\|\|\s*request\.id\s*!==\s*requestId[\s\S]*?clearPendingUserRequestForTurn\(pending\.turn,\s*['"][^'"]+['"](?:,\s*pending\.request)?\)/,
  'stale respond-user-request should safely clear the pending responder through the helper',
);

assert.match(
  routeSource,
  /function\s+clearPendingUserRequestForTurn\s*\(/,
  'route.ts should define a helper that safely clears pending user requests for a turn',
);

assert.match(
  routeSource,
  /function\s+clearPendingUserRequestsForSession\s*\(/,
  'route.ts should define a helper that safely clears pending user requests for a session',
);

assert.match(
  routeSource,
  /function\s+getAlwaysAllowedPermissionOption\s*\(\s*agentId:\s*string,\s*params:\s*any\s*\)[\s\S]*?alwaysAllowedPermissionSessions\.has\(sessionId\)[\s\S]*?getAllowPermissionOption\(normalizePermissionOptions\(params\)\)/,
  'getAlwaysAllowedPermissionOption should select an allow option for later permission requests in an Always-allowed session',
);

assert.match(
  routeSource,
  /function\s+rememberAlwaysAllowedPermission\s*\(\s*turn:\s*TurnState,\s*request:\s*PendingUserRequest,\s*body:\s*any\s*\)[\s\S]*?selectedOption[\s\S]*?allow_always[\s\S]*?alwaysAllowedPermissionSessions\.add\(sessionId\)/,
  'respond-user-request should remember the session when the selected permission option is allow_always',
);

assert.match(
  routeSource,
  /queueUserRequestForTurn[\s\S]*?clearPendingUserRequestForTurn\(turn,\s*['"]replaced['"]/,
  'replacing a pending user request should safely resolve and clear the previous responder',
);

assert.match(
  routeSource,
  /function\s+queueUserRequestForTurn[\s\S]*?const\s+responder:\s*PendingUserRequestResponder\s*=\s*\{[\s\S]*?timeout:\s*setTimeout\(\(\)\s*=>\s*\{[\s\S]*?pendingUserRequestResponders\.get\(requestId\)\s*!==\s*responder[\s\S]*?clearPendingUserRequestForTurn\(turn,\s*['"]timed out['"]\s*,\s*responder\.request\)[\s\S]*?\},\s*PENDING_USER_REQUEST_TIMEOUT_MS\)[\s\S]*?\};[\s\S]*?pendingUserRequestResponders\.set\(requestId,\s*responder\);/s,
  'queueUserRequestForTurn should schedule timeout cleanup through clearPendingUserRequestForTurn',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]turn-clear['"][\s\S]*?clearPendingUserRequestForTurn\(turn,\s*['"]cleared['"]/,
  'turn-clear should safely clear any pending user request responder',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]interrupt['"][\s\S]*?clearPendingUserRequestForTurn\(turn,\s*['"]interrupted['"]/,
  'interrupt should safely clear any pending user request responder',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]reset['"][\s\S]*?clearPendingUserRequestsForSession\(agentId,\s*sess,\s*['"]reset['"]/,
  'reset should safely clear any pending user request responders for the session',
);

assert.match(
  routeSource,
  /rpc\.onClose\s*=\s*\(reason\)\s*=>[\s\S]*?clearPendingUserRequestsForSession\(agentId,\s*sess,\s*['"]relay disconnected['"]/,
  'relay disconnect cleanup should safely resolve pending user request responders',
);

assert.match(
  routeSource,
  /cp\.on\('exit',\s*\(code\)\s*=>[\s\S]*?clearPendingUserRequestsForSession\(agentId,\s*sess,\s*['"]process exited['"]/,
  'process exit cleanup should safely resolve pending user request responders',
);

assert.match(
  findTurnForSessionSource,
  /function\s+findTurnForSession\s*\(\s*agentId:\s*string,\s*sessionId:\s*string\s*\|\s*undefined\s*\):\s*TurnState\s*\|\s*null\s*\{[\s\S]*?if\s*\(!sessionId\)\s*return\s+null;[\s\S]*?return\s+findTurnBySessionId\(agentId,\s*sessionId\)\s*\?\?\s*null;/,
  'findTurnForSession should delegate to agent-scoped findTurnBySessionId for immutable session routing',
);

assert.match(
  findTurnBySessionIdSource,
  /function\s+findTurnBySessionId\s*\(\s*agentId:\s*string,\s*sessionId:\s*string\s*\):\s*TurnState\s*\|\s*undefined\s*\{[\s\S]*?for\s*\(const\s+\[key,\s*sess\]\s+of\s+getUserSessions\(\)\.entries\(\)\)\s*\{[\s\S]*?if\s*\(!key\.startsWith\(`\$\{agentId\}:`\)\)\s*continue;[\s\S]*?for\s*\(const\s+turn\s+of\s+sess\.activeTurns\.values\(\)\)\s*\{[\s\S]*?turn\.agentId\s*===\s*agentId[\s\S]*?turn\.sessionId\s*===\s*sessionId[\s\S]*?return\s+turn;/,
  'findTurnBySessionId should scope active-turn lookup to the matching agent and immutable session id',
);

assert.match(
  findTurnBySessionIdSource,
  /function\s+findTurnBySessionId[\s\S]*?sess\.activeTurns\.values\(\)/,
  'findTurnBySessionId should iterate sess.activeTurns.values()',
);

assert.match(
  findTurnBySessionIdSource,
  /function\s+findTurnBySessionId[\s\S]*?(key\.startsWith\(`\$\{agentId\}:`\)|turn\.agentId\s*===\s*agentId)/,
  'findTurnBySessionId should skip non-matching agent sessions or explicitly check turn.agentId',
);

assert.match(
  routeSource,
  /rpc\.onNotification\s*=\s*\(method,\s*params\)\s*=>[\s\S]*?findTurnBySessionId\(agentId,\s*notifSessionId\)/,
  'session/update notifications should route through agent-scoped session lookup',
);

assert.match(
  routeSource,
  /function\s+queueUserRequestForTurn[\s\S]*?findTurnForUserRequest\(agentId,\s*typeof\s+params\?\.sessionId\s*===\s*['"]string['"]\s*\?\s*params\.sessionId\s*:\s*undefined\)/,
  'queueUserRequestForTurn should resolve turns through agent-scoped session lookup',
);

assert.match(
  routeSource,
  /function\s+findTurnForUserRequest[\s\S]*?findSingleActiveTurnForAgent\(agentId\)[\s\S]*?function\s+queueUserRequestForTurn[\s\S]*?findTurnForUserRequest\(agentId,/,
  'queueUserRequestForTurn should safely fall back for ACP user-input requests that omit sessionId',
);

assert.match(
  routeSource,
  /const\s+prompt\s*=\s*firstString\(params\?\.prompt,\s*params\?\.message,\s*params\?\.question\)/,
  'queueUserRequestForTurn should derive prompt text from params.prompt, params.message, or params.question',
);

assert.match(
  routeSource,
  /async\s+function\s+cancelTurnPrompt\s*\(\s*proc:\s*AgentProcess,\s*turn:\s*TurnState\s*\):\s*Promise<void>\s*\{[\s\S]*?if\s*\(turn\.done\s*\|\|\s*!turn\.sessionId\s*\|\|\s*!proc\.rpc\)\s*return;[\s\S]*?await\s+proc\.rpc\.send\('session\/cancel',\s*\{\s*sessionId:\s*turn\.sessionId\s*\},\s*5000\)[\s\S]*?proc\.rpc\.writeRaw\([\s\S]*?session\/cancel[\s\S]*?turn\.sessionId[\s\S]*?\)/,
  'route.ts should define cancelTurnPrompt to cancel unfinished prompts before cleanup',
);

assert.match(
  routeSource,
  /function\s+findActiveTurnKeyForSession\s*\(\s*sess:\s*UserSession,\s*sessionId:\s*string,\s*exceptKey\?:\s*string\s*\):\s*string\s*\|\s*null\s*\{[\s\S]*?for\s*\(const\s*\[key,\s*turn\]\s*of\s*sess\.activeTurns\)\s*\{[\s\S]*?key\s*!==\s*exceptKey[\s\S]*?!turn\.done[\s\S]*?turn\.sessionId\s*===\s*sessionId[\s\S]*?return\s+key;[\s\S]*?return\s+null;/,
  'findActiveTurnKeyForSession should scan active turns by immutable session id while excluding the requested key',
);

assert.match(
  routeSource,
  /sessionId:\s*sess\.sessionId\s*\?\?\s*undefined/,
  'sendPrompt should initialize each turn with the current session id',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]send['"][\s\S]*?const\s+turnChatKey\s*=\s*chatId\s*\|\|\s*['"]__default['"][\s\S]*?const\s+existingTurn\s*=\s*sess\.activeTurns\.get\(turnChatKey\);[\s\S]*?if\s*\(existingTurn\s*&&\s*!existingTurn\.done\)\s*\{[\s\S]*?error:\s*['"]turn_in_progress['"][\s\S]*?\}[\s\S]*?if\s*\(sess\.sessionId\s*&&\s*findActiveTurnKeyForSession\(sess,\s*sess\.sessionId,\s*turnChatKey\)\)\s*\{[\s\S]*?error:\s*['"]turn_in_progress['"][\s\S]*?\}[\s\S]*?sendPrompt\(/,
  'send should reject when the current session id is already owned by another unfinished turn before sending the prompt',
);

assert.match(
  routeSource,
  /turn\.sessionId\s*=\s*sess\.sessionId\s*\?\?\s*undefined;/,
  'session recovery should update the active turn session id before retrying',
);

assert.doesNotMatch(
  findTurnBySessionIdSource,
  /function\s+findTurnBySessionId[\s\S]*?findUserSessionBySessionId\s*\(/,
  'findTurnBySessionId should not call findUserSessionBySessionId',
);

assert.doesNotMatch(
  findTurnBySessionIdSource,
  /function\s+findTurnBySessionId[\s\S]*?findChatIdBySessionId\s*\(/,
  'findTurnBySessionId should not call findChatIdBySessionId',
);

assert.doesNotMatch(
  findTurnBySessionIdSource,
  /function\s+findTurnBySessionId[\s\S]*?getChatSession\s*\(/,
  'findTurnBySessionId should not call getChatSession',
);

assert.doesNotMatch(
  findTurnForSessionSource,
  /function\s+findTurnForSession[\s\S]*?getChatSession\s*\(/,
  'findTurnForSession should not call getChatSession',
);

assert.doesNotMatch(
  findTurnForSessionSource,
  /function\s+findTurnForSession[\s\S]*?for\s*\(const\s+sess\s+of\s+getUserSessions\(\)\.values\(\)\)\s*\{/,
  'findTurnForSession should not iterate chat sessions directly',
);

assert.match(
  routeSource,
  /function\s+clearPendingUserRequestForTurn[\s\S]*?pending\.rpc\.respond\(pending\.rpcRequestId,\s*buildAbandonedUserRequestResponse\(request\)\);[\s\S]*?finally\s*\{[\s\S]*?pendingUserRequestResponders\.delete\(request\.id\);[\s\S]*?\}/,
  'clearPendingUserRequestForTurn should respond before deleting the pending responder',
);

assert.match(
  routeSource,
  /function\s+clearPendingUserRequestForTurn[\s\S]*?if\s*\(pending\.timeout\)\s*clearTimeout\(pending\.timeout\);[\s\S]*?pending\.rpc\.respond/s,
  'clearPendingUserRequestForTurn should clear the responder timeout before responding',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]new-session['"][\s\S]*?const\s+turnChatKey\s*=\s*chatId\s*\|\|\s*['"]__default['"][\s\S]*?const\s+turn\s*=\s*sess\.activeTurns\.get\(turnChatKey\);[\s\S]*?if\s*\(turn\)\s*\{[\s\S]*?clearPendingUserRequestForTurn\(turn,\s*['"]new session['"]\);[\s\S]*?await\s+cancelTurnPrompt\(proc,\s*turn\);[\s\S]*?\}[\s\S]*?sess\.activeTurns\.delete\(turnChatKey\)/,
  'new-session should clear pending requests before canceling the matching turn',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?try\s*\{[\s\S]*?pending\.rpc\.respond\(pending\.rpcRequestId,\s*result\);[\s\S]*?\}\s*finally\s*\{[\s\S]*?pending\.turn\.userRequest\s*=\s*undefined;[\s\S]*?if\s*\(pending\.timeout\)\s*clearTimeout\(pending\.timeout\);[\s\S]*?pendingUserRequestResponders\.delete\(requestId\);[\s\S]*?\}/s,
  'respond-user-request should clean up the timeout and responder in finally if rpc respond throws',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]respond-user-request['"][\s\S]*?request\.options\.length\s*>\s*0[\s\S]*?typeof\s+body\?\.optionId\s*!==\s*['"]string['"][\s\S]*?request\.options\.some\(\s*option\s*=>\s*option\.optionId\s*===\s*body\.optionId\s*\)[\s\S]*?invalid_option/,
  'respond-user-request should reject unknown option ids for any option-backed user request before responding',
);

assert.match(
  routeSource,
  /function\s+buildUserRequestResponse[\s\S]*?const\s+selectedOption\s*=[\s\S]*?request\.options\.find\(\s*option\s*=>\s*option\.optionId\s*===\s*body\?\.optionId\s*\)[\s\S]*?return\s+\{\s*answer:\s*selectedOption\.label[\s\S]*?optionId:\s*selectedOption\.optionId[\s\S]*?\}/,
  'buildUserRequestResponse should convert option-backed non-permission choices into an answer and preserve optionId',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]interrupt['"][\s\S]*?clearPendingUserRequestForTurn\(turn,\s*['"]interrupted['"]\)[\s\S]*?await\s+cancelTurnPrompt\(proc,\s*turn\);/,
  'interrupt should use cancelTurnPrompt for prompt cancellation',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]new-session['"][\s\S]*?const\s+previousSessionId\s*=\s*chatId\s*\?\s*getChatSession\(sess,\s*chatId\)\s*:\s*sess\.sessionId;[\s\S]*?if\s*\(chatId\)\s*sess\.chatSessions\.delete\(chatId\);[\s\S]*?if\s*\(!chatId\s*\|\|\s*\(previousSessionId\s*&&\s*sess\.sessionId\s*===\s*previousSessionId\)\)\s*sess\.sessionId\s*=\s*null;[\s\S]*?if\s*\(!proc\.ready\s*\|\|\s*!proc\.rpc\)\s*\{[\s\S]*?skipped:\s*true/,
  'new-session should abandon the current session identity before returning skipped',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]reset['"][\s\S]*?clearPendingUserRequestsForSession\(agentId,\s*sess,\s*['"]reset['"][\s\S]*?for\s*\(const\s+turn\s+of\s+sess\.activeTurns\.values\(\)\)\s*\{[\s\S]*?if\s*\(turn\.agentId\s*!==\s*agentId\s*\|\|\s*turn\.done\)\s*continue;[\s\S]*?await\s+cancelTurnPrompt\(proc,\s*turn\);[\s\S]*?\}[\s\S]*?getUserSessions\(\)\.delete\(userSessionKey\(agentId,\s*userId\)\)/,
  'reset should clear pending responders before canceling unfinished prompts and deleting the user session',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]resume-session['"][\s\S]*?const\s+turnChatKey\s*=\s*chatId\s*\|\|\s*['"]__default['"];[\s\S]*?const\s+chatTurn\s*=\s*sess\.activeTurns\.get\(turnChatKey\);[\s\S]*?if\s*\(chatTurn\s*&&\s*!chatTurn\.done\s*&&\s*chatTurn\.sessionId\s*&&\s*chatTurn\.sessionId\s*!==\s*savedSessionId\)\s*\{[\s\S]*?error:\s*['"]turn_in_progress['"][\s\S]*?status:\s*409[\s\S]*?\}[\s\S]*?if\s*\(findActiveTurnKeyForSession\(sess,\s*savedSessionId,\s*turnChatKey\)\)\s*\{[\s\S]*?error:\s*['"]turn_in_progress['"][\s\S]*?status:\s*409[\s\S]*?\}[\s\S]*?sess\.sessionId\s*=\s*savedSessionId/s,
  'resume-session should reject resuming a session id already backing another unfinished turn before changing session state',
);

assert.match(
  routeSource,
  /function\s+getActiveTurnForResume\([\s\S]*?chatTurn[\s\S]*?savedSessionId[\s\S]*?\)[\s\S]*?if\s*\(!chatTurn\s*\|\|\s*chatTurn\.done\)\s*return\s+null;[\s\S]*?if\s*\(chatTurn\.sessionId\s*&&\s*chatTurn\.sessionId\s*!==\s*savedSessionId\)\s*return\s+null;[\s\S]*?if\s*\(!chatTurn\.sessionId\)\s*chatTurn\.sessionId\s*=\s*savedSessionId;[\s\S]*?return\s+chatTurn;/,
  'resume-session should restore the matching active turn even before the mutable session id is reassigned',
);

assert.match(
  routeSource,
  /sess\.sessionId\s*===\s*savedSessionId\s*\|\|\s*proc\.knownSessions\.has\(savedSessionId\)[\s\S]*?const\s+activeTurn\s*=\s*getActiveTurnForResume\(chatTurn,\s*savedSessionId\)[\s\S]*?return\s+NextResponse\.json\(\{\s*ok:\s*true,\s*sessionId:\s*savedSessionId,\s*loaded:\s*true,\s*activeTurn:\s*serializeTurn\(activeTurn\)\s*\}\)/,
  'known-session resume should return the matching active turn even when sess.sessionId was stale',
);

assert.match(
  routeSource,
  /if\s*\(proc\.supportsLoadSession\)\s*\{[\s\S]*?await\s+proc\.rpc!\.send\('session\/load'[\s\S]*?const\s+activeTurn\s*=\s*getActiveTurnForResume\(chatTurn,\s*savedSessionId\)[\s\S]*?return\s+NextResponse\.json\(\{\s*ok:\s*true,\s*sessionId:\s*savedSessionId,\s*loaded:\s*true,\s*activeTurn:\s*serializeTurn\(activeTurn\),\s*\.\.\.recovery\s*\}\)/,
  'successful session/load resume should return the matching active turn so the frontend keeps polling pending requests',
);

assert.match(
  routeSource,
  /function\s+logSessionLoadFallback\([\s\S]*?console\.log\(\s*`\[ACP:\$\{agentId\}\]\s+session\/load fallback:[\s\S]*?chat=\$\{chatId\s*\|\|\s*['"]\(none\)['"]\}[\s\S]*?savedSession=\$\{savedSessionId\}[\s\S]*?reason=\$\{reason\};\s+falling back to session\/new/,
  'route.ts should log chat/session/reason to stdout whenever session/load falls back to session/new',
);

assert.match(
  routeSource,
  /catch\s*\(loadErr:[\s\S]*?const\s+alreadyLoaded[\s\S]*?if\s*\(alreadyLoaded\)[\s\S]*?return\s+NextResponse\.json[\s\S]*?logSessionLoadFallback\(agentId,\s*userId,\s*chatId,\s*savedSessionId,[\s\S]*?errStr[\s\S]*?\);[\s\S]*?\}[\s\S]*?else\s*\{[\s\S]*?logSessionLoadFallback\(agentId,\s*userId,\s*chatId,\s*savedSessionId,\s*['"]agent does not support loadSession['"]\);/,
  'resume-session should log both failed session/load and unsupported loadSession fallback paths',
);

assert.match(
  routeSource,
  /function\s+getLastStoredSessionId\([\s\S]*?Array\.isArray\(value\)[\s\S]*?for\s*\(let\s+i\s*=\s*value\.length\s*-\s*1[\s\S]*?typeof\s+item\s*===\s*['"]string['"][\s\S]*?return\s+item/,
  'route.ts should read the latest session id from either legacy string or append-only session arrays',
);

assert.match(
  routeSource,
  /async\s+function\s+getStoredChatAgentSessionId\([\s\S]*?await\s+getChat\(userId,\s*chatId\)[\s\S]*?getLastStoredSessionId\(chat\?\.agentSessions\?\.\[agentId\]\)/,
  'route.ts should be able to read a saved chat agent session from SQLite before sending',
);

assert.match(
  routeSource,
  /async\s+function\s+loadSavedChatSessionForSend\([\s\S]*?proc\.knownSessions\.has\(savedSessionId\)[\s\S]*?proc\.supportsLoadSession[\s\S]*?await\s+proc\.rpc!\.send\('session\/load',\s*\{\s*sessionId:\s*savedSessionId[\s\S]*?logSessionLoadFallback\(agentId,\s*userId,\s*chatId,\s*savedSessionId/,
  'send should load a saved chat session before falling back to session/new',
);

assert.match(
  routeSource,
  /action\s*===\s*['"]send['"][\s\S]*?const\s+chatSessionId\s*=\s*getChatSession\(sess,\s*chatId\);[\s\S]*?const\s+savedSessionId\s*=\s*await\s+getStoredChatAgentSessionId\(userId,\s*chatId,\s*agentId\);[\s\S]*?if\s*\(savedSessionId\)\s*\{[\s\S]*?await\s+loadSavedChatSessionForSend\(proc,\s*sess,\s*agentId,\s*userId,\s*chatId,\s*savedSessionId,\s*isAdmin\)[\s\S]*?await\s+ensureUserSession\(proc,\s*sess,\s*agentId,\s*userId,\s*isAdmin\)/,
  'send should try the saved SQLite session for this chat before ensureUserSession creates a new session',
);

assert.match(
  routeSource,
  /const\s+alreadyLoaded\s*=[\s\S]*?if\s*\(alreadyLoaded\)\s*\{[\s\S]*?const\s+activeTurn\s*=\s*getActiveTurnForResume\(chatTurn,\s*savedSessionId\)[\s\S]*?return\s+NextResponse\.json\(\{\s*ok:\s*true,\s*sessionId:\s*savedSessionId,\s*loaded:\s*true,\s*activeTurn:\s*serializeTurn\(activeTurn\)\s*\}\)/,
  'already-loaded resume should return the matching active turn even when sess.sessionId was stale',
);

assert.match(
  combinedAcpSource,
  /type\s+WarmLocalAgentStatus\s*=\s*[\s\S]*?['"]ready['"][\s\S]*?['"]booting['"][\s\S]*?['"]started['"][\s\S]*?['"]failed['"][\s\S]*?['"]skipped_remote['"]/,
  'route.ts should define explicit warmup status values for local agent warmup summaries',
);

assert.match(
  routeSource,
  /async\s+function\s+warmLocalAgents\(\):\s*Promise<WarmLocalAgentResult\[]>[\s\S]*?readAgentsConfig\(\)[\s\S]*?if\s*\(agent\.relay\)[\s\S]*?status:\s*['"]skipped_remote['"][\s\S]*?getAgentProcess\(agent\.id,\s*agent\)[\s\S]*?proc\.ready[\s\S]*?status:\s*['"]ready['"][\s\S]*?proc\.booting[\s\S]*?status:\s*['"]booting['"][\s\S]*?await\s+bootAgent\(agent\.id\)[\s\S]*?status:\s*['"]started['"][\s\S]*?catch[\s\S]*?console\.error[\s\S]*?status:\s*['"]failed['"]/,
  'warmLocalAgents should skip relay/ready/booting agents, boot unready local agents, and report failures per agent',
);

assert.ok(
  warmLocalAgentsActionStart >= 0 && runtimeActionsStart >= 0 && warmLocalAgentsActionStart < runtimeActionsStart,
  'warm-local-agents should be handled before the shared runtime action guard that requires agentId',
);

assert.match(
  warmLocalAgentsActionSource,
  /const\s+agents\s*=\s*await\s+warmLocalAgents\(\);[\s\S]*?const\s+warmed\s*=\s*agents\.filter\([\s\S]*?status\s*===\s*['"]started['"][\s\S]*?NextResponse\.json\(\{\s*ok:\s*true,\s*warmed,\s*agents\s*\}\)/,
  'warm-local-agents action should return an ok response with warmed count and per-agent summary',
);

assert.doesNotMatch(
  warmLocalAgentsActionSource,
  /session\/new|session\/load|getUserSession|ensureUserSession/,
  'warm-local-agents action should not create, load, or attach chat sessions',
);

assert.match(
  setupNodeScriptSource,
  /\[string\]\$KeyVaultName\s*=\s*"__RELAY_KEY_VAULT_NAME__"/,
  'setup-node.ps1 should use a Key Vault name placeholder instead of a committed deployment value',
);

assert.match(
  setupNodeScriptSource,
  /\[string\]\$SecretName\s*=\s*"__RELAY_KEY_VAULT_SECRET_NAME__"/,
  'setup-node.ps1 should use a Key Vault secret-name placeholder instead of a committed deployment value',
);

assert.match(
  setupNodeScriptSource,
  /\[string\]\$RelaySubscriptionId\s*=\s*"__RELAY_SUBSCRIPTION_ID__"/,
  'setup-node.ps1 should use a Relay subscription placeholder instead of a committed deployment value',
);

assert.match(
  setupNodeScriptSource,
  /\[string\]\$RelayResourceGroup\s*=\s*"__RELAY_RESOURCE_GROUP__"/,
  'setup-node.ps1 should use a Relay resource group placeholder instead of a committed deployment value',
);

assert.doesNotMatch(
  setupNodeScriptSource,
  new RegExp(concreteSetupDefaults),
  'setup-node.ps1 should not commit concrete setup deployment defaults',
);

assert.doesNotMatch(
  publicSetupSources,
  new RegExp(concreteSetupDefaults),
  'public setup files, docs, and tests should not commit concrete setup deployment defaults',
);

assert.match(
  setupNodeScriptSource,
  /function\s+Test-IsTemplatePlaceholder[\s\S]*?\^__\.\*__\$[\s\S]*?function\s+Get-RelayAzureScopeArguments[\s\S]*?Test-IsTemplatePlaceholder\s+\$RelaySubscriptionId[\s\S]*?Test-IsTemplatePlaceholder\s+\$RelayResourceGroup/,
  'setup-node.ps1 should treat unresolved template placeholders as missing relay Azure scope values',
);

assert.match(
  setupNodeScriptSource,
  /function\s+Test-CanUseKeyVaultLookup[\s\S]*?Test-IsTemplatePlaceholder\s+\$VaultName[\s\S]*?Test-IsTemplatePlaceholder\s+\$VaultSecretName[\s\S]*?function\s+Remove-AzureRelayHybridConnection[\s\S]*?Test-CanUseKeyVaultLookup\s+\$VaultName\s+\$VaultSecretName[\s\S]*?Download a rendered setup ZIP or pass -RelayConnectionString[\s\S]*?# If no connection string provided[\s\S]*?Test-CanUseKeyVaultLookup\s+\$KeyVaultName\s+\$SecretName[\s\S]*?Download a rendered setup ZIP or pass -RelayConnectionString/,
  'setup-node.ps1 should treat unresolved Key Vault placeholders as missing before fetching secrets',
);

assert.match(
  setupNodeScriptSource,
  /\$scriptArguments\s*\+=\s*Format-TaskArgument\s+["']RelaySubscriptionId["']\s+\$RelaySubscriptionId[\s\S]*?\$scriptArguments\s*\+=\s*Format-TaskArgument\s+["']RelayResourceGroup["']\s+\$RelayResourceGroup/,
  'setup-node.ps1 scheduled task reruns should preserve explicit RelaySubscriptionId and RelayResourceGroup values',
);

assert.match(
  setupTemplateSource,
  /const\s+SETUP_KEY_VAULT_NAME_PLACEHOLDER\s*=\s*['"]__RELAY_KEY_VAULT_NAME__['"]/,
  'setup template helper should define the Key Vault name placeholder',
);

assert.match(
  setupTemplateSource,
  /const\s+SETUP_KEY_VAULT_SECRET_PLACEHOLDER\s*=\s*['"]__RELAY_KEY_VAULT_SECRET_NAME__['"]/,
  'setup template helper should define the Key Vault secret-name placeholder',
);

assert.match(
  setupTemplateSource,
  /const\s+SETUP_SUBSCRIPTION_ID_PLACEHOLDER\s*=\s*['"]__RELAY_SUBSCRIPTION_ID__['"]/,
  'setup template helper should define the Relay subscription placeholder',
);

assert.match(
  setupTemplateSource,
  /const\s+SETUP_RESOURCE_GROUP_PLACEHOLDER\s*=\s*['"]__RELAY_RESOURCE_GROUP__['"]/,
  'setup template helper should define the Relay resource group placeholder',
);

assert.match(
  setupTemplateSource,
  /function\s+escapePowerShellDoubleQuotedString[\s\S]*?replace\([\s\S]*?`\/g[\s\S]*?replace\([\s\S]*?\$\/g[\s\S]*?replace\([\s\S]*?"\/g/,
  'setup template helper should escape env values before embedding them in a PowerShell double-quoted string',
);

assert.match(
  setupTemplateSource,
  /function\s+renderSetupNodeScript\(source,\s*env\s*=\s*process\.env\)[\s\S]*?env\.RELAY_KEY_VAULT_NAME[\s\S]*?env\.RELAY_KEY_VAULT_SECRET_NAME[\s\S]*?env\.RELAY_SUBSCRIPTION_ID[\s\S]*?env\.RELAY_RESOURCE_GROUP[\s\S]*?SETUP_KEY_VAULT_NAME_PLACEHOLDER[\s\S]*?SETUP_KEY_VAULT_SECRET_PLACEHOLDER[\s\S]*?SETUP_SUBSCRIPTION_ID_PLACEHOLDER[\s\S]*?SETUP_RESOURCE_GROUP_PLACEHOLDER/,
  'setup template helper should render setup-node.ps1 placeholders from deployment environment variables',
);

assert.match(
  setupTemplateSource,
  /env\.RELAY_KEY_VAULT_NAME\s*(?:\|\||\?\?)\s*['"]['"][\s\S]*?env\.RELAY_KEY_VAULT_SECRET_NAME\s*(?:\|\||\?\?)\s*['"]['"][\s\S]*?env\.RELAY_SUBSCRIPTION_ID\s*(?:\|\||\?\?)\s*['"]['"][\s\S]*?env\.RELAY_RESOURCE_GROUP\s*(?:\|\||\?\?)\s*['"]['"]/,
  'setup template helper should render empty Key Vault defaults when deployment environment variables are missing',
);

assert.match(
  setupRouteSource,
  /import\s+\{[\s\S]*renderSetupNodeScript[\s\S]*\}\s+from\s+['"]\.\.\/\.\.\/\.\.\/\.\.\/lib\/setupNodeTemplate\.mjs['"]/,
  'setup ZIP route should use the runtime-tested setup template helper',
);

assert.match(
  setupRouteSource,
  /const\s+stagedPs1Path\s*=\s*path\.join\(tempDir,\s*['"]setup-node\.ps1['"]\)[\s\S]*?await\s+fs\.writeFile\(stagedPs1Path,\s*renderSetupNodeScript\(setupNodeScript\),\s*['"]utf-8['"]\)[\s\S]*?Compress-Archive[\s\S]*?stagedPs1Path/,
  'setup ZIP route should zip a rendered temporary setup-node.ps1 instead of the tracked template file',
);

assert.match(
  setupRouteSource,
  /const\s+compressScriptPath\s*=\s*path\.join\(tempDir,\s*['"]compress-setup-zip\.ps1['"]\)[\s\S]*?await\s+fs\.writeFile\([\s\S]*?compressScriptPath,[\s\S]*?await\s+execFileAsync\([\s\S]*?['"]-File['"][\s\S]*?compressScriptPath[\s\S]*?stagedPs1Path[\s\S]*?jsPath[\s\S]*?zipPath/,
  'setup ZIP route should pass archive paths through a temporary PowerShell script instead of interpolating paths into a command string',
);

assert.match(
  setupRouteSource,
  /import\s+\{\s*execFile\s*\}\s+from\s+['"]child_process['"][\s\S]*?import\s+\{\s*promisify\s*\}\s+from\s+['"]util['"][\s\S]*?const\s+execFileAsync\s*=\s*promisify\(execFile\)[\s\S]*?await\s+execFileAsync\(/,
  'setup ZIP route should run PowerShell compression asynchronously instead of blocking the Node.js event loop',
);

assert.doesNotMatch(
  setupRouteSource,
  /execFileSync|execSync/,
  'setup ZIP route should not use synchronous child_process compression',
);

assert.match(
  setupRouteSource,
  /Compress-Archive -LiteralPath @\(\$SetupScript, \$RelayListener\) -DestinationPath \$ZipPath -Force/,
  'setup ZIP route should use PowerShell LiteralPath parameters in the temporary compression script',
);

const setupTemplateFixture = [
  '[string]$KeyVaultName = "__RELAY_KEY_VAULT_NAME__"',
  '[string]$SecretName = "__RELAY_KEY_VAULT_SECRET_NAME__"',
  '[string]$RelaySubscriptionId = "__RELAY_SUBSCRIPTION_ID__"',
  '[string]$RelayResourceGroup = "__RELAY_RESOURCE_GROUP__"',
].join('\n');

assert.equal(
  escapePowerShellDoubleQuotedString('vault`$"name'),
  'vault```$`"name',
  'setup template helper should escape backticks, dollars, and double quotes for PowerShell strings',
);

assert.match(
  renderSetupNodeScript(setupTemplateFixture, {
    RELAY_KEY_VAULT_NAME: 'vault`$"name',
    RELAY_KEY_VAULT_SECRET_NAME: 'secret`$"name',
    RELAY_SUBSCRIPTION_ID: 'sub`$"id',
    RELAY_RESOURCE_GROUP: 'rg`$"name',
  }),
  /\[string\]\$KeyVaultName = "vault```\$`"name"[\s\S]*\[string\]\$SecretName = "secret```\$`"name"[\s\S]*\[string\]\$RelaySubscriptionId = "sub```\$`"id"[\s\S]*\[string\]\$RelayResourceGroup = "rg```\$`"name"/,
  'setup template helper should render escaped env values into the setup script',
);

assert.match(
  renderSetupNodeScript(setupTemplateFixture, {}),
  /\[string\]\$KeyVaultName = ""[\s\S]*\[string\]\$SecretName = ""[\s\S]*\[string\]\$RelaySubscriptionId = ""[\s\S]*\[string\]\$RelayResourceGroup = ""/,
  'setup template helper should render empty defaults when deployment env values are missing',
);

assert.match(
  setupRouteSource,
  /const\s+zipBuffer\s*=\s*await\s*\(async\s*\(\)\s*=>\s*\{[\s\S]*?try\s*\{[\s\S]*?const\s+setupNodeScript\s*=\s*await\s+fs\.readFile\(ps1Path,\s*['"]utf-8['"]\)[\s\S]*?await\s+fs\.writeFile\(stagedPs1Path,\s*renderSetupNodeScript\(setupNodeScript\),\s*['"]utf-8['"]/,
  'setup ZIP route should read and render the setup template inside the cleanup-protected block',
);

assert.match(
  setupRouteSource,
  /try\s*\{[\s\S]*?await\s+fs\.writeFile\(stagedPs1Path,\s*renderSetupNodeScript\(setupNodeScript\),\s*['"]utf-8['"]\)[\s\S]*?Compress-Archive[\s\S]*?await\s+fs\.readFile\(zipPath\)[\s\S]*?\}\s*finally\s*\{[\s\S]*?await\s+fs\.rm\(tempDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/,
  'setup ZIP route should clean up temporary setup artifacts in a finally block after zipping and reading',
);

assert.match(
  setupRouteSource,
  /finally\s*\{[\s\S]*?try\s*\{[\s\S]*?await\s+fs\.rm\(tempDir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)[\s\S]*?\}\s*catch\s*\(cleanupErr\)[\s\S]*?console\.warn/,
  'setup ZIP route should not fail a successful download when temporary cleanup fails',
);

assert.deepEqual(
  agentsConfig,
  { agents: [] },
  'tracked agents.json should be public-safe and empty',
);

assert.match(
  envExampleSource,
  /RELAY_KEY_VAULT_NAME=/,
  '.env.example should document RELAY_KEY_VAULT_NAME',
);

assert.match(
  envExampleSource,
  /RELAY_KEY_VAULT_SECRET_NAME=/,
  '.env.example should document RELAY_KEY_VAULT_SECRET_NAME',
);

assert.match(
  envExampleSource,
  /restart or redeploy[\s\S]*download a new copilot-node-setup\.zip/i,
  '.env.example should explain that setup ZIP env changes require restart/redeploy and a fresh download',
);

assert.match(
  readmeSource,
  /RELAY_KEY_VAULT_NAME[\s\S]*Key Vault name used when generating the node setup ZIP/,
  'README should document RELAY_KEY_VAULT_NAME setup ZIP behavior',
);

assert.match(
  readmeSource,
  /RELAY_KEY_VAULT_SECRET_NAME[\s\S]*Key Vault secret name used when generating the node setup ZIP/,
  'README should document RELAY_KEY_VAULT_SECRET_NAME setup ZIP behavior',
);

assert.match(
  readmeSource,
  /download a new `copilot-node-setup\.zip` after changing these environment variables/,
  'README should explain that setup ZIPs are generated from current deployment env values',
);

console.log('agent user request route shape checks passed');
