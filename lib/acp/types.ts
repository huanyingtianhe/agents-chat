import type * as configStore from '@/lib/configStore';

export type AgentModel = configStore.AgentModel;

export type TurnPhase = 'booting' | 'thinking' | 'tool_exec' | 'replying' | 'done';

export type TurnEvent = {
  type: 'thinking' | 'tool_start' | 'tool_complete' | 'text_chunk' | 'user_response';
  ts: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: string;
  toolResult?: string;
  text?: string;
};

export type PendingUserRequestOption = {
  optionId: string;
  kind?: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type PendingUserRequestQuestion = {
  id: string;
  header: string;
  question: string;
  message?: string;
  inputKind: 'options' | 'text';
  multiSelect?: boolean;
  allowFreeformInput?: boolean;
  options: PendingUserRequestOption[];
};

export type PendingUserRequestAnswer = {
  selected: string[];
  freeText: string | null;
  skipped: boolean;
};

export type PendingUserRequest = {
  id: string;
  method: string;
  agentId: string;
  chatId?: string;
  sessionId?: string;
  title: string;
  prompt: string;
  inputKind: 'options' | 'text';
  options: PendingUserRequestOption[];
  questions?: PendingUserRequestQuestion[];
  createdAt: number;
};

export type TurnState = {
  id: string;
  messageId: string;
  agentId: string;
  userId: string;
  chatId?: string;
  sessionId?: string;
  prompt: string;
  startedAt: number;
  fullText: string;
  done: boolean;
  phase: TurnPhase;
  statusText: string;
  error?: string;
  events: TurnEvent[];
  userRequest?: PendingUserRequest;
  syntheticQuestionParseOffset?: number;
  lastPersistedAt: number;
  persistTimer?: ReturnType<typeof setTimeout>;
};

export type StoredContentPart =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolName: string; args?: string; result?: string; done: boolean }
  | { kind: 'user_answer'; text: string }
  | { kind: 'text'; text: string };

export type PromptAttachment = {
  id?: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  kind?: 'image' | 'file';
};

export type AcpPromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; name?: string };

export type AgentConfig = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  yolo: boolean;
  noTools?: boolean;
  relay?: boolean;
  relayConnectionName?: string;
  models?: AgentModel[];
  defaultModelId?: string;
};

export type PendingRequest = {
  resolve: (result: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  reject: (err: Error) => void;
};

export type NdjsonRpc = {
  kind: 'local' | 'relay';
  send: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  respond: (id: number | string, result: Record<string, unknown>) => void;
  /** Write a raw NDJSON line (for fallback cancel). */
  writeRaw: (line: string) => void;
  onNotification: ((method: string, params: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onRequest: ((method: string, params: any, id: number | string) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onClose: ((reason: string) => void) | null;
  destroy: () => void;
};

export type AgentProcess = {
  rpc: NdjsonRpc | null;
  ready: boolean;
  booting: boolean;
  error: string | null;
  config: AgentConfig;
  cachedCwd: string;
  supportsLoadSession: boolean;
  knownSessions: Set<string>; // sessions active in agent memory (no need to session/load)
};

// Per-user per-agent: isolated session and turn state
export type UserSession = {
  sessionId: string | null;
  /** Map of chatId → list of sessionIds (append-only). Last element is the current session. */
  chatSessions: Map<string, string[]>;
  /** Map of chatId → active turn for that chat. Allows concurrent turns across different chats. */
  activeTurns: Map<string, TurnState>;
  alwaysAllowedPermissionSessions: Set<string>;
  phase: 'idle' | 'busy' | 'booting';
  turnCount: number;
  lastActive: number;
};

export type WarmLocalAgentStatus = 'ready' | 'booting' | 'started' | 'failed' | 'skipped_remote';

export type WarmLocalAgentResult = {
  agentId: string;
  status: WarmLocalAgentStatus;
  error?: string;
};
