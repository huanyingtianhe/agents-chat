# Layered Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `app/page.tsx` and `app/api/acp/route.ts` into focused vertical frontend slices and backend ACP modules without changing behavior.

**Architecture:** Keep `app/page.tsx` as the client route composition shell and move feature-owned types, helpers, hooks, and components under `app/features/`. Keep `app/api/acp/route.ts` as the App Router HTTP entrypoint and move ACP protocol/runtime/tooling logic under `lib/acp/`, preserving existing global cache keys and API response shapes.

**Tech Stack:** Next.js 16 App Router, React 19 client components/hooks, TypeScript strict mode, Node source-shape tests, Playwright E2E, ACP over NDJSON-RPC.

---

## File structure

Create these frontend feature files:

| Path | Responsibility |
|------|----------------|
| `app/features/agents/agentTypes.ts` | Agent and model types shared by chat/composer/agents UI. |
| `app/features/theme/themes.ts` | Theme definitions and `normalizeThemeId`. |
| `app/features/files/fileWorkspaceTypes.ts` | File workspace, file tree, diff, conflict, and comment-adjacent editor types. |
| `app/features/files/fileWorkspaceHelpers.ts` | File icon, file kind checks, file workspace parsing, simple diff, and file tree building. |
| `app/features/composer/attachmentTypes.ts` | Composer attachment type. |
| `app/features/composer/attachmentHelpers.ts` | Composer attachment validation, MIME inference, labels, reading files, and summary text. |
| `app/features/chat/chatTypes.ts` | Chat message, history, content-part, user request, orchestration, and run context types. |
| `app/features/chat/chatHelpers.ts` | Chat history normalization, mention parsing, default agent selection, persisted session helper, and ACP failure guard. |
| `app/features/chat/chatApi.ts` | Thin `acpApi` and `warmLocalAgentsOnce` wrappers. |
| `app/features/agents/components/AgentModelSelect.tsx` | Composer model selector component. |
| `app/features/composer/components/AttachmentList.tsx` | Attachment list display used by composer and messages. |

Create these backend ACP files:

| Path | Responsibility |
|------|----------------|
| `lib/acp/types.ts` | Shared ACP route types: turns, pending user requests, attachments, RPC interface, agent process/session types. |
| `lib/acp/attachments.ts` | Backend prompt attachment normalization and ACP prompt-part building. |
| `lib/acp/rpc.ts` | Local child-process NDJSON-RPC and Azure Relay NDJSON-RPC transports. |
| `lib/acp/terminalTools.ts` | Terminal tool registry and handlers. |
| `lib/acp/fsTools.ts` | ACP file read/write tool handlers. |
| `lib/acp/runtimeState.ts` | `globalThis` backed ACP process/session/boot/replay/pending-request state. |
| `lib/acp/models.ts` | Session model normalization, sync, validation, and model switching. |

Modify these existing files:

| Path | Change |
|------|--------|
| `app/page.tsx` | Import extracted frontend modules/components and delete moved declarations. |
| `app/api/acp/route.ts` | Import extracted backend modules and delete moved declarations. |
| `test/layered-refactor-structure.test.mjs` | New high-level structure regression. |
| `test/agent-model-ui.test.mjs` | Read model selector/type sources from new files plus `page.tsx`. |
| `test/acp-attachments-api.test.mjs` | Read backend attachment source from `lib/acp/attachments.ts` plus route wiring. |
| `test/agent-user-request-route.test.mjs` | Update source slices to allow extracted user request/runtime modules as implementation proceeds. |
| `test/session-mcp-routing.test.mjs` | Update source target when `buildSessionParams` moves. |
| `test/session-prompt-stop-reason.test.mjs` | Update source target when turn helpers move. |

---

### Task 1: Add structure regression and baseline checks

**Files:**
- Create: `test/layered-refactor-structure.test.mjs`
- Validate: `app/page.tsx`
- Validate: `app/api/acp/route.ts`

- [ ] **Step 1: Write the failing structure test**

Create `test/layered-refactor-structure.test.mjs`:

```js
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
const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');

assert.match(pageSource, /from ['"]\.\/features\/agents\/agentTypes['"]/, 'page should import agent types from the agents feature');
assert.match(pageSource, /from ['"]\.\/features\/theme\/themes['"]/, 'page should import themes from the theme feature');
assert.match(pageSource, /from ['"]\.\/features\/files\/fileWorkspaceHelpers['"]/, 'page should import file workspace helpers from the files feature');
assert.match(pageSource, /from ['"]\.\/features\/composer\/attachmentHelpers['"]/, 'page should import attachment helpers from the composer feature');
assert.match(pageSource, /from ['"]\.\/features\/chat\/chatHelpers['"]/, 'page should import chat helpers from the chat feature');
assert.match(pageSource, /from ['"]\.\/features\/agents\/components\/AgentModelSelect['"]/, 'page should use the extracted model selector component');
assert.match(pageSource, /from ['"]\.\/features\/composer\/components\/AttachmentList['"]/, 'page should use the extracted attachment list component');

assert.match(routeSource, /from ['"]@\/lib\/acp\/attachments['"]/, 'ACP route should import attachment helpers from lib/acp/attachments');
assert.match(routeSource, /from ['"]@\/lib\/acp\/rpc['"]/, 'ACP route should import RPC helpers from lib/acp/rpc');
assert.match(routeSource, /from ['"]@\/lib\/acp\/terminalTools['"]/, 'ACP route should import terminal handlers from lib/acp/terminalTools');
assert.match(routeSource, /from ['"]@\/lib\/acp\/fsTools['"]/, 'ACP route should import file tool handlers from lib/acp/fsTools');
assert.match(routeSource, /from ['"]@\/lib\/acp\/runtimeState['"]/, 'ACP route should import runtime state from lib/acp/runtimeState');

const pageLines = pageSource.split(/\r?\n/).length;
const routeLines = routeSource.split(/\r?\n/).length;
assert.ok(pageLines < 9000, `app/page.tsx should be below 9000 lines after first extraction; got ${pageLines}`);
assert.ok(routeLines < 2700, `app/api/acp/route.ts should be below 2700 lines after first extraction; got ${routeLines}`);

console.log('layered refactor structure checks passed');
```

- [ ] **Step 2: Run the structure test to verify it fails**

Run:

```powershell
node test\layered-refactor-structure.test.mjs
```

Expected: FAIL with a message that the first missing feature or ACP module should exist.

- [ ] **Step 3: Run current baseline tests before refactoring**

Run:

```powershell
node test\agent-model-ui.test.mjs
node test\acp-attachments-api.test.mjs
node test\agent-user-request-route.test.mjs
node test\session-mcp-routing.test.mjs
node test\session-prompt-stop-reason.test.mjs
```

Expected: all pass before extraction starts.

- [ ] **Step 4: Commit the failing structure test**

Run:

```powershell
git add test\layered-refactor-structure.test.mjs
git commit -m "test: add layered refactor structure guard" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds. The new test is intentionally failing until later tasks create the expected modules.

---

### Task 2: Extract frontend types, themes, and file workspace helpers

**Files:**
- Create: `app/features/agents/agentTypes.ts`
- Create: `app/features/theme/themes.ts`
- Create: `app/features/files/fileWorkspaceTypes.ts`
- Create: `app/features/files/fileWorkspaceHelpers.ts`
- Modify: `app/page.tsx`

- [ ] **Step 1: Create `agentTypes.ts`**

Move these existing declarations from `app/page.tsx` into `app/features/agents/agentTypes.ts` and export them:

```ts
export type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};

export type Agent = {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  relay?: boolean;
  relayConnectionName?: string;
  relayConnectionLabel?: string;
  owner?: string;
  canModify?: boolean;
  canTalk?: boolean;
  public?: boolean;
  models?: AgentModel[];
  defaultModelId?: string;
};
```

- [ ] **Step 2: Create `fileWorkspaceTypes.ts`**

Move these existing type declarations from `app/page.tsx` into `app/features/files/fileWorkspaceTypes.ts` and export them:

```ts
export type FileTreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
};

export type MdConflictState = {
  path: string;
  baseContent: string;
  mineContent: string;
  serverContent: string;
  serverMtime: string | null;
  mode: 'choice' | 'manual';
};

export type LeftSidebarTab = 'chats' | 'files';
export type MdEditorMode = 'split' | 'live' | 'review';

export type FileWorkspaceState = {
  tab: LeftSidebarTab;
  agentId: string | null;
  filePath: string | null;
  diffOnly: boolean;
  editorMode: MdEditorMode;
  scrollTop?: number;
};

export type DiffLine = {
  type: 'same' | 'removed' | 'added' | 'changed';
  serverLine?: string;
  mineLine?: string;
  key: string;
};
```

- [ ] **Step 3: Create `fileWorkspaceHelpers.ts`**

Create `app/features/files/fileWorkspaceHelpers.ts` with these imports:

```ts
import type { DiffLine, FileTreeNode, FileWorkspaceState, LeftSidebarTab, MdEditorMode } from './fileWorkspaceTypes';
```

Then move these existing functions from `app/page.tsx` into the file and export them unchanged:

- `getFileIcon`
- `isLeftSidebarTab`
- `isMdEditorMode`
- `normalizeFileEditorMode`
- `parseFileWorkspaceState`
- `buildSimpleLineDiff`
- `isMarkdownFile`
- `isHtmlFile`
- `buildFileTree`

- [ ] **Step 4: Create `themes.ts`**

Move the complete block beginning with the `const THEMES =` declaration and ending after the `normalizeThemeId(value: unknown): ThemeId` function from `app/page.tsx` into `app/features/theme/themes.ts`. Add `export` before the moved `const THEMES`, `type ThemeId`, and `function normalizeThemeId` declarations. The extracted file must preserve all current theme IDs and normalization behavior exactly.

- [ ] **Step 5: Import extracted files in `page.tsx`**

Add these imports to `app/page.tsx` after the existing library imports:

```ts
import type { Agent, AgentModel } from './features/agents/agentTypes';
import { THEMES, normalizeThemeId, type ThemeId } from './features/theme/themes';
import type { DiffLine, FileTreeNode, FileWorkspaceState, LeftSidebarTab, MdConflictState, MdEditorMode } from './features/files/fileWorkspaceTypes';
import { buildFileTree, buildSimpleLineDiff, getFileIcon, isHtmlFile, isLeftSidebarTab, isMarkdownFile, isMdEditorMode, normalizeFileEditorMode, parseFileWorkspaceState } from './features/files/fileWorkspaceHelpers';
```

Delete the moved local declarations from `app/page.tsx`.

- [ ] **Step 6: Run focused validation**

Run:

```powershell
node test\agent-model-ui.test.mjs
npm run build
```

Expected: `agent model UI checks passed`; build exits successfully. If `next-env.d.ts` changes only because the build rewrote route type paths, restore it:

```powershell
git checkout-index -f -- next-env.d.ts
```

- [ ] **Step 7: Commit frontend type/theme/file extraction**

Run:

```powershell
git add app\page.tsx app\features\agents\agentTypes.ts app\features\theme\themes.ts app\features\files\fileWorkspaceTypes.ts app\features\files\fileWorkspaceHelpers.ts
git commit -m "refactor: extract frontend feature helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 3: Extract composer attachment helpers and chat helpers

**Files:**
- Create: `app/features/composer/attachmentTypes.ts`
- Create: `app/features/composer/attachmentHelpers.ts`
- Create: `app/features/chat/chatTypes.ts`
- Create: `app/features/chat/chatHelpers.ts`
- Create: `app/features/chat/chatApi.ts`
- Modify: `app/page.tsx`

- [ ] **Step 1: Create composer attachment files**

Create `app/features/composer/attachmentTypes.ts`:

```ts
export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  kind: 'image' | 'file';
};
```

Create `app/features/composer/attachmentHelpers.ts` and move these existing declarations from `app/page.tsx` into it:

- `MAX_ATTACHMENTS`
- `MAX_ATTACHMENT_BYTES`
- `MAX_TOTAL_ATTACHMENT_BYTES`
- `ATTACHMENT_ACCEPT`
- `formatBytes`
- `getAttachmentKind`
- `getAttachmentFileKey`
- `getAttachmentMimeType`
- `withAttachmentDataUrlMimeType`
- `getAttachmentTypeLabel`
- `getAttachmentIconLabel`
- `readFileAsDataUrl`
- `filesToAttachments`
- `getAttachmentSummaryText`

Use this import at the top:

```ts
import type { ChatAttachment } from './attachmentTypes';
```

Keep the existing MIME maps and function bodies unchanged.

- [ ] **Step 2: Create chat type and helper files**

Create `app/features/chat/chatTypes.ts` and move these existing declarations from `app/page.tsx` into it:

- `ContentPart`
- `AgentUserRequestOption`
- `AgentUserRequestQuestion`
- `AgentUserRequestAnswer`
- `AgentUserRequest`
- `AgentUserRequestResponse`
- `AgentUserRequestSubmission`
- `ChatMessage`
- `ChatHistoryEntry`
- `ShareDialog`
- `OrchestrationMode`
- `SessionRunContext`
- `DispatchToAgentOptions`
- `OrchestrationState`

Import `Agent` and `ChatAttachment` where needed:

```ts
import type { Agent } from '../agents/agentTypes';
import type { ChatAttachment } from '../composer/attachmentTypes';
```

Create `app/features/chat/chatHelpers.ts` and move these existing functions from `app/page.tsx` into it:

- `getAgentUserRequestOptionLabel`
- `getAcpTurnProgressSignature`
- `normalizeChatHistory`
- `formatMessageTime`
- `getMentionedAgentIds`
- `getDefaultAgentId`
- `getExistingAgentId`
- `parseAgents`
- `lastSessionId`
- `isAcpFailureResult`

Use imports:

```ts
import type { Agent } from '../agents/agentTypes';
import type { ChatHistoryEntry } from './chatTypes';
```

- [ ] **Step 3: Create `chatApi.ts`**

Create `app/features/chat/chatApi.ts`:

```ts
import type { Agent } from '../agents/agentTypes';

let warmLocalAgentsPromise: Promise<void> | null = null;

export async function acpApi(body: Record<string, unknown>) {
  const res = await fetch('/api/acp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function warmLocalAgentsOnce(
  acp: (body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  agents: Agent[],
) {
  if (warmLocalAgentsPromise) return warmLocalAgentsPromise;
  if (!agents.some((agent) => agent.relay !== true)) {
    warmLocalAgentsPromise = Promise.resolve();
    return warmLocalAgentsPromise;
  }
  warmLocalAgentsPromise = acp({ action: 'warm-local-agents' })
    .then((result) => {
      if (result && typeof result === 'object' && result.ok === false) {
        console.warn('[ACP warmup] Failed to warm local agents', result);
      }
    })
    .catch((err) => {
      console.warn('[ACP warmup] Failed to warm local agents', err);
    });
  return warmLocalAgentsPromise;
}
```

If the current `warmLocalAgentsOnce` body differs, preserve the current behavior exactly and only move it into this module.

- [ ] **Step 4: Import extracted chat/composer helpers in `page.tsx`**

Add imports to `app/page.tsx`:

```ts
import type { ChatAttachment } from './features/composer/attachmentTypes';
import { ATTACHMENT_ACCEPT, filesToAttachments, formatBytes, getAttachmentIconLabel, getAttachmentKind, getAttachmentSummaryText, getAttachmentTypeLabel, getAttachmentMimeType, getAttachmentFileKey, readFileAsDataUrl, withAttachmentDataUrlMimeType } from './features/composer/attachmentHelpers';
import type { AgentUserRequest, AgentUserRequestResponse, AgentUserRequestSubmission, ChatHistoryEntry, ChatMessage, DispatchToAgentOptions, OrchestrationMode, OrchestrationState, SessionRunContext, ShareDialog } from './features/chat/chatTypes';
import { getAcpTurnProgressSignature, getAgentUserRequestOptionLabel, getDefaultAgentId, getExistingAgentId, getMentionedAgentIds, isAcpFailureResult, lastSessionId, normalizeChatHistory, parseAgents, formatMessageTime } from './features/chat/chatHelpers';
import { acpApi, warmLocalAgentsOnce } from './features/chat/chatApi';
```

Delete the moved local declarations from `app/page.tsx`. Keep the route-local `const acp = useCallback(...)` wrapper, but have it call imported `acpApi`.

- [ ] **Step 5: Run focused validation**

Run:

```powershell
node test\agent-model-ui.test.mjs
npm run build
```

Expected: `agent model UI checks passed`; build exits successfully. Restore generated `next-env.d.ts` if needed:

```powershell
git checkout-index -f -- next-env.d.ts
```

- [ ] **Step 6: Commit composer/chat helper extraction**

Run:

```powershell
git add app\page.tsx app\features\composer app\features\chat
git commit -m "refactor: extract chat and composer helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 4: Extract small frontend components

**Files:**
- Create: `app/features/agents/components/AgentModelSelect.tsx`
- Create: `app/features/composer/components/AttachmentList.tsx`
- Modify: `app/page.tsx`
- Modify: `test/agent-model-ui.test.mjs`

- [ ] **Step 1: Extract `AgentModelSelect`**

Create `app/features/agents/components/AgentModelSelect.tsx`:

```tsx
'use client';

import type { AgentModel } from '../agentTypes';

type AgentModelSelectProps = {
  agentId: string;
  models: AgentModel[];
  selectedModelId: string;
  disabled?: boolean;
  onChange: (agentId: string, modelId: string) => void;
};

export function AgentModelSelect({ agentId, models, selectedModelId, disabled = false, onChange }: AgentModelSelectProps) {
  if (models.length === 0) return null;

  const selectedModel = models.find((model) => model.modelId === selectedModelId) || models[0];
  const selectedModelLabel = selectedModel?.name || selectedModel?.modelId || '';
  const modelSelectWidthCh = Math.max(6, Math.min(18, selectedModelLabel.length + 2));

  return (
    <select
      className="agentModelSelect"
      data-testid="agent-model-select"
      value={selectedModel?.modelId || ''}
      disabled={disabled}
      style={{ width: `${modelSelectWidthCh}ch` }}
      onChange={(event) => onChange(agentId, event.target.value)}
      title={selectedModel?.description || selectedModel?.name || selectedModel?.modelId || 'Model'}
    >
      {models.map((model) => (
        <option key={model.modelId} value={model.modelId}>
          {model.name || model.modelId}
        </option>
      ))}
    </select>
  );
}
```

If the current `renderAgentModelSelect` uses additional disabled/loading text, pass that state as props and preserve the current JSX and attributes exactly.

- [ ] **Step 2: Use `AgentModelSelect` from `page.tsx`**

Add this import:

```ts
import { AgentModelSelect } from './features/agents/components/AgentModelSelect';
```

Replace the body of `renderAgentModelSelect(agentId: string)` with:

```tsx
function renderAgentModelSelect(agentId: string) {
  const models = getAgentModels(agentId);
  if (models.length === 0) return null;

  return (
    <AgentModelSelect
      agentId={agentId}
      models={models}
      selectedModelId={getSelectedModelIdForAgent(agentId)}
      disabled={ensuringAgentModels[agentId] === true}
      onChange={setSelectedModelForAgent}
    />
  );
}
```

- [ ] **Step 3: Extract `AttachmentList`**

Create `app/features/composer/components/AttachmentList.tsx`:

```tsx
'use client';

import type { ChatAttachment } from '../attachmentTypes';
import { formatBytes, getAttachmentIconLabel, getAttachmentTypeLabel } from '../attachmentHelpers';

type AttachmentListProps = {
  list?: ChatAttachment[];
  mode?: 'composer' | 'message';
  onRemove?: (id: string) => void;
};

export function AttachmentList({ list = [], mode = 'message', onRemove }: AttachmentListProps) {
  if (!list.length) return null;
  return (
    <div className={`attachmentsList ${mode === 'composer' ? 'composerAttachments' : ''}`}>
      {list.map((attachment) => (
        <div className="attachmentChip" key={attachment.id}>
          <span className="attachmentIcon" aria-hidden="true">{getAttachmentIconLabel(attachment)}</span>
          <span className="attachmentMeta">
            <span className="attachmentName">{attachment.name}</span>
            <span className="attachmentDetails">{getAttachmentTypeLabel(attachment)} - {formatBytes(attachment.size)}</span>
          </span>
          {mode === 'composer' && onRemove ? (
            <button type="button" className="attachmentRemove" onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}>
              x
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

If current attachment rendering includes image thumbnails or lightbox behavior, add props for the existing click handler and preserve the exact thumbnail JSX.

- [ ] **Step 4: Use `AttachmentList` from `page.tsx`**

Add this import:

```ts
import { AttachmentList } from './features/composer/components/AttachmentList';
```

Replace `renderAttachmentsList(...)` calls with `<AttachmentList ... />` and delete the local `renderAttachmentsList` function once all usages are updated.

- [ ] **Step 5: Update `agent-model-ui` source test**

Modify `test/agent-model-ui.test.mjs` so it reads both `page.tsx` and the model component:

```js
const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const modelSelectSource = readFileSync(new URL('../app/features/agents/components/AgentModelSelect.tsx', import.meta.url), 'utf8');
const agentTypesSource = readFileSync(new URL('../app/features/agents/agentTypes.ts', import.meta.url), 'utf8');
const combinedSource = `${pageSource}\n${modelSelectSource}\n${agentTypesSource}`;
```

Change assertions that currently inspect `pageSource` for moved model selector code to inspect `combinedSource` or `modelSelectSource` as appropriate. Keep CSS assertions reading `pageSource` because styled-jsx stays in `page.tsx`.

- [ ] **Step 6: Run focused validation**

Run:

```powershell
node test\agent-model-ui.test.mjs
node test\layered-refactor-structure.test.mjs
npm run build
```

Expected: `agent model UI checks passed`; structure test may still fail only on backend modules until Task 7; build exits successfully. Restore generated `next-env.d.ts` if needed.

- [ ] **Step 7: Commit component extraction**

Run:

```powershell
git add app\page.tsx app\features\agents\components\AgentModelSelect.tsx app\features\composer\components\AttachmentList.tsx test\agent-model-ui.test.mjs
git commit -m "refactor: extract frontend components" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 5: Extract backend attachment helpers

**Files:**
- Create: `lib/acp/types.ts`
- Create: `lib/acp/attachments.ts`
- Modify: `app/api/acp/route.ts`
- Modify: `test/acp-attachments-api.test.mjs`

- [ ] **Step 1: Create `lib/acp/types.ts`**

Move and export these existing types from `app/api/acp/route.ts`:

- `TurnPhase`
- `TurnEvent`
- `PendingUserRequestOption`
- `PendingUserRequestQuestion`
- `PendingUserRequestAnswer`
- `PendingUserRequest`
- `TurnState`
- `StoredContentPart`
- `PromptAttachment`
- `AcpPromptPart`
- `AgentConfig`
- `PendingRequest`
- `NdjsonRpc`
- `AgentProcess`
- `UserSession`
- `WarmLocalAgentStatus`
- `WarmLocalAgentResult`

Keep type property names unchanged.

- [ ] **Step 2: Create `lib/acp/attachments.ts`**

Create `lib/acp/attachments.ts` with:

```ts
import type { AcpPromptPart, PromptAttachment } from './types';
```

Move these existing declarations from `app/api/acp/route.ts` into this file and export them:

- `MAX_ATTACHMENTS`
- `MAX_ATTACHMENT_BYTES`
- `MAX_TOTAL_ATTACHMENT_BYTES`
- `MAX_INLINE_ATTACHMENT_CHARS`
- `AttachmentValidationError`
- `formatAttachmentBytes`
- `isAllowedAttachmentMimeType`
- `ATTACHMENT_MIME_BY_EXTENSION`
- `ATTACHMENT_MIME_BY_BASENAME`
- `getAttachmentFileKey`
- `inferAttachmentMimeType`
- `rewriteDataUrlMimeType`
- `splitDataUrl`
- `normalizePromptAttachments`
- `buildAttachmentSummary`
- `isInlineTextAttachmentMimeType`
- `buildAttachmentTextBlocks`
- `buildPromptParts`

Preserve function bodies and error messages exactly.

- [ ] **Step 3: Import backend attachments in `route.ts`**

Add imports to `app/api/acp/route.ts`:

```ts
import type { AcpPromptPart, AgentConfig, AgentProcess, PendingRequest, PromptAttachment, StoredContentPart, TurnEvent, TurnPhase, TurnState, UserSession, WarmLocalAgentResult } from '@/lib/acp/types';
import { AttachmentValidationError, buildPromptParts, normalizePromptAttachments } from '@/lib/acp/attachments';
```

Delete the moved local types and attachment helper declarations from `route.ts`. Keep any route-only types in `route.ts` until a later task moves them.

- [ ] **Step 4: Update `acp-attachments-api` test**

Modify `test/acp-attachments-api.test.mjs` so it reads both route and attachment module sources:

```js
const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');
const attachmentSource = readFileSync(new URL('../lib/acp/attachments.ts', import.meta.url), 'utf8');
const combinedSource = `${routeSource}\n${attachmentSource}`;
```

Change helper/constant assertions to inspect `attachmentSource` or `combinedSource`. Keep route wiring assertions on `routeSource` for `normalizePromptAttachments(body?.attachments)` and `sendPrompt(... attachments ...)`.

- [ ] **Step 5: Run focused validation**

Run:

```powershell
node test\acp-attachments-api.test.mjs
node test\agent-user-request-route.test.mjs
npm run build
```

Expected: attachment checks pass, user request source checks pass, build exits successfully. Restore generated `next-env.d.ts` if needed.

- [ ] **Step 6: Commit backend attachment extraction**

Run:

```powershell
git add app\api\acp\route.ts lib\acp\types.ts lib\acp\attachments.ts test\acp-attachments-api.test.mjs
git commit -m "refactor: extract acp attachment helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 6: Extract ACP RPC, terminal, file tool, and runtime state modules

**Files:**
- Create: `lib/acp/rpc.ts`
- Create: `lib/acp/terminalTools.ts`
- Create: `lib/acp/fsTools.ts`
- Create: `lib/acp/runtimeState.ts`
- Modify: `app/api/acp/route.ts`

- [ ] **Step 1: Extract RPC transport**

Create `lib/acp/rpc.ts` and move these existing functions from `app/api/acp/route.ts` unchanged:

- `createNdjsonRpc`
- `createRelayNdjsonRpc`

Use imports:

```ts
import type { ChildProcess } from 'child_process';
import type { NdjsonRpc, PendingRequest } from './types';
```

Keep `RELAY_SEND_CONNECTION_STRING` in this module if it is only used by `createRelayNdjsonRpc`.

- [ ] **Step 2: Extract terminal handlers**

Create `lib/acp/terminalTools.ts` and move these existing declarations from `app/api/acp/route.ts` unchanged:

- `ManagedTerminal`
- `globalTerminals`
- `getTerminals`
- `handleTerminalCreate`
- `handleTerminalOutput`
- `handleTerminalWaitForExit`
- `handleTerminalRelease`
- `handleTerminalKill`

Preserve global cache keys `__acpTerminals` and `__acpNextTermId`.

- [ ] **Step 3: Extract file tool handlers**

Create `lib/acp/fsTools.ts` and move these existing functions from `app/api/acp/route.ts` unchanged:

- `handleReadTextFile`
- `handleWriteTextFile`

Use:

```ts
import * as fs from 'fs/promises';
```

- [ ] **Step 4: Extract runtime state accessors**

Create `lib/acp/runtimeState.ts` and move these existing declarations/functions from `app/api/acp/route.ts` unchanged:

- `pendingUserRequestGlobal`
- `getPendingUserRequestResponders`
- `pendingUserRequestResponders`
- `globalStore`
- `getAgentProcesses`
- `getUserSessions`
- `STALE_SESSION_MS`
- `PENDING_USER_REQUEST_TIMEOUT_MS`
- `cleanupStaleSessions`
- `getBootPromises`
- `getReplayBuffers`
- `userSessionKey`
- `getAgentProcess`
- `getUserSession`

Preserve all `globalThis` property names exactly.

- [ ] **Step 5: Wire extracted modules into `route.ts`**

Add imports to `app/api/acp/route.ts`:

```ts
import { createNdjsonRpc, createRelayNdjsonRpc } from '@/lib/acp/rpc';
import { handleTerminalCreate, handleTerminalKill, handleTerminalOutput, handleTerminalRelease, handleTerminalWaitForExit } from '@/lib/acp/terminalTools';
import { handleReadTextFile, handleWriteTextFile } from '@/lib/acp/fsTools';
import { cleanupStaleSessions, getAgentProcess, getAgentProcesses, getBootPromises, getPendingUserRequestResponders, getReplayBuffers, getUserSession, getUserSessions, pendingUserRequestResponders, userSessionKey } from '@/lib/acp/runtimeState';
```

Delete moved local declarations from `route.ts`. Fix imports for `spawn`, `path`, `os`, and `fs` so only still-used imports remain.

- [ ] **Step 6: Run focused validation**

Run:

```powershell
node test\agent-user-request-route.test.mjs
node test\session-mcp-routing.test.mjs
node test\session-prompt-stop-reason.test.mjs
npm run build
```

Expected: source checks pass; build exits successfully. Restore generated `next-env.d.ts` if needed.

- [ ] **Step 7: Commit runtime/tool extraction**

Run:

```powershell
git add app\api\acp\route.ts lib\acp\rpc.ts lib\acp\terminalTools.ts lib\acp\fsTools.ts lib\acp\runtimeState.ts
git commit -m "refactor: extract acp runtime utilities" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 7: Extract ACP model/session pure helpers and finish structure guard

**Files:**
- Create: `lib/acp/models.ts`
- Modify: `app/api/acp/route.ts`
- Modify: `test/session-mcp-routing.test.mjs`
- Modify: `test/session-prompt-stop-reason.test.mjs`
- Modify: `test/layered-refactor-structure.test.mjs`

- [ ] **Step 1: Create `lib/acp/models.ts`**

Move these existing functions from `app/api/acp/route.ts` into `lib/acp/models.ts` and export them:

- `normalizeSessionModels`
- `syncAgentModelsFromSessionResult`
- `validateRequestedModel`
- `applySessionModelIfRequested`

Use imports:

```ts
import * as configStore from '@/lib/configStore';
import type { AgentConfig, AgentModel, AgentProcess } from './types';
```

If `AgentModel` is still declared as `type AgentModel = configStore.AgentModel`, move that alias into `lib/acp/types.ts`:

```ts
import type * as configStore from '@/lib/configStore';
export type AgentModel = configStore.AgentModel;
```

- [ ] **Step 2: Import model helpers in `route.ts`**

Add:

```ts
import { applySessionModelIfRequested, normalizeSessionModels, syncAgentModelsFromSessionResult, validateRequestedModel } from '@/lib/acp/models';
```

Delete the moved model helper functions from `route.ts`.

- [ ] **Step 3: Update source tests for moved helpers**

Modify `test/session-prompt-stop-reason.test.mjs` so it reads the route plus `lib/acp/turns.ts` only after `finishTurnAfterPromptResult` moves in a later plan. For this first plan, keep the test reading `route.ts`.

Modify `test/session-mcp-routing.test.mjs` only if `buildSessionParams` is moved during this task. If it remains in `route.ts`, leave the test unchanged.

- [ ] **Step 4: Run structure and focused validation**

Run:

```powershell
node test\layered-refactor-structure.test.mjs
node test\agent-user-request-route.test.mjs
node test\agent-model-config.test.mjs
npm run build
```

Expected: structure checks pass, source checks pass, build exits successfully. Restore generated `next-env.d.ts` if needed.

- [ ] **Step 5: Commit model helper extraction**

Run:

```powershell
git add app\api\acp\route.ts lib\acp\models.ts lib\acp\types.ts test\layered-refactor-structure.test.mjs test\session-mcp-routing.test.mjs test\session-prompt-stop-reason.test.mjs
git commit -m "refactor: extract acp model helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 8: Final validation and review

**Files:**
- Validate all files modified by Tasks 1-7.

- [ ] **Step 1: Run source regression checks**

Run:

```powershell
node test\layered-refactor-structure.test.mjs
node test\agent-model-ui.test.mjs
node test\acp-attachments-api.test.mjs
node test\agent-user-request-route.test.mjs
node test\agent-model-config.test.mjs
node test\session-mcp-routing.test.mjs
node test\session-prompt-stop-reason.test.mjs
```

Expected: every command exits with code 0 and prints its success message.

- [ ] **Step 2: Run production build**

Run:

```powershell
npm run build
```

Expected: build exits with code 0. Existing warnings about middleware/proxy or Turbopack tracing are acceptable if unchanged. Restore generated `next-env.d.ts` if needed:

```powershell
git checkout-index -f -- next-env.d.ts
```

- [ ] **Step 3: Inspect size reduction**

Run:

```powershell
foreach ($f in @('app\page.tsx','app\api\acp\route.ts')) {
  $count = [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $f)).Length
  Write-Host "$f`t$count lines"
}
```

Expected: `app/page.tsx` is below 9000 lines and `app/api/acp/route.ts` is below 2700 lines.

- [ ] **Step 4: Inspect git status and diff**

Run:

```powershell
git --no-pager status --short
git --no-pager diff --stat origin/main...HEAD
```

Expected: working tree is clean. Diff shows the design commit plus focused refactor commits and tests.

- [ ] **Step 5: Request final code review**

Use the code-review subagent with:

```text
Description: Behavior-preserving vertical-slice refactor of app/page.tsx and app/api/acp/route.ts into frontend feature modules and backend lib/acp modules.
Requirements: docs/superpowers/specs/2026-05-18-layered-refactor-design.md and this plan.
Base: origin/main
Head: HEAD
```

Expected: reviewer reports no Critical or Important issues. Fix any Critical or Important issues before opening a PR.

- [ ] **Step 6: Commit any review fixes**

If review fixes are needed, run focused tests for the affected area and commit:

```powershell
git add app\page.tsx app\api\acp\route.ts app\features lib\acp test
git commit -m "fix: address layered refactor review" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds and final validation from Steps 1-4 still passes.
