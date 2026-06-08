import type { Agent } from '../agents/agentTypes';
import type { ChatAttachment } from '../composer/attachmentTypes';

export type ContentPart =
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolName: string; args?: string; result?: string; done: boolean }
  | { kind: 'user_answer'; text: string }
  | { kind: 'text'; text: string };

export type AgentUserRequestOption = {
  optionId: string;
  kind?: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type AgentUserRequestQuestion = {
  id: string;
  header: string;
  question: string;
  message?: string;
  inputKind: 'options' | 'text';
  multiSelect?: boolean;
  allowFreeformInput?: boolean;
  options: AgentUserRequestOption[];
};

export type AgentUserRequestAnswer = {
  selected: string[];
  freeText: string | null;
  skipped: boolean;
};

export type AgentUserRequest = {
  id: string;
  method: string;
  agentId: string;
  title: string;
  prompt: string;
  inputKind: 'options' | 'text';
  options: AgentUserRequestOption[];
  questions?: AgentUserRequestQuestion[];
  createdAt: number;
};

export type AgentUserRequestResponse = {
  optionId?: string;
  answer?: string;
  answers?: Record<string, AgentUserRequestAnswer>;
};

export type AgentUserRequestSubmission = {
  pending: boolean;
  error?: string;
};

export type ChatMessage = {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  agentId?: string;
  ts: number;
  pending?: boolean;
  round?: number;
  relation?: string;
  summary?: boolean;
  statusText?: string;
  ptyPhase?: 'booting' | 'loading-environment' | 'idle-ready' | 'thinking' | 'replying';
  parts?: ContentPart[];
  userRequest?: AgentUserRequest;
  attachments?: ChatAttachment[];
  sendStatus?: 'failed';
  sendError?: string;
  resendAgentIds?: string[];
  resendMessage?: string;
};

export type ChatHistoryEntry = {
  id: string;
  name: string;
  ts: number;
  agentId?: string;
  agentSessions?: Record<string, string>;
};

export type ShareDialog = {
  variant: 'link' | 'error';
  title: string;
  url?: string;
  detail?: string;
  copied?: boolean;
};

export type OrchestrationMode = 'pipeline' | 'auto' | 'workflow';

export type SessionRunContext = {
  agentId: string;
  pendingId: string;
  orchestrationId: string;
  kind: 'worker' | 'summary';
  currentText: string;
  chatId: string;
  commentId?: string;
  round?: number;
  relation?: string;
  ptyTurnId?: string;
  ptySendStarted?: boolean;
  workflowNodeId?: string;
};

export type DispatchToAgentOptions = {
  round?: number;
  relation?: string;
  summary?: boolean;
  chatId?: string;
  commentId?: string;
  attachments?: ChatAttachment[];
  workflowNodeId?: string;
};

export type OrchestrationState = {
  id: string;
  mode: OrchestrationMode;
  agentIds: string[];
  originalTask: string;
  results: Record<string, string>;
  nextIndex: number;
  summaryStarted: boolean;
  round: number;
  maxRounds: number;
  sourceUserMessageId?: string;
  sourceChatId?: string;
  sourceAgentIds?: string[];
  sourceMessage?: string;
  sourceAttachments?: ChatAttachment[];
  /** Workflow-mode fields */
  workflowPlan?: import('@/lib/workflow/workflowTypes.mjs').WorkflowPlan;
  nodeStatuses?: Record<string, import('@/lib/workflow/workflowTypes.mjs').NodeStatus>;
  replanCount?: number;
};
