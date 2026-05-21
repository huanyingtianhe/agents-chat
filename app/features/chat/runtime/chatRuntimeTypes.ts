import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import type { ChatHistoryEntry, ChatMessage, OrchestrationMode, ShareDialog } from '../chatTypes';
import type { PtyPhase } from './chatRunLoop';

export type ComposerRuntime = {
  input: string;
  inputRef: RefObject<string>;
  attachments: ChatAttachment[];
  attachmentError: string | null;
  isDraggingAttachment: boolean;
  mentionSelectedIndex: number;
  setInput: (value: string) => void;
  setInputProgrammatic: (value: string) => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
};

export type ChatRuntime = {
  messages: ChatMessage[];
  chatHistory: ChatHistoryEntry[];
  currentChatId: string;
  activeSidebarChatId: string;
  chatName: string;
  isRunning: boolean;
  ptyPhase: PtyPhase;
  runVersion: number;
  shareDialog: ShareDialog | null;
  sendMessage: () => Promise<void>;
  stopRun: () => Promise<void>;
  retryFailedSend: (messageId: string) => Promise<void>;
  createNewChat: () => Promise<void>;
  loadChat: (chatId: string) => Promise<void>;
};

export type EnsureAgentModelsOptions = {
  currentChatId: string | null;
  currentAgentSessionsRef?: MutableRefObject<Record<string, string>>;
  setChatHistory?: Dispatch<SetStateAction<ChatHistoryEntry[]>>;
};

export type AgentRegistry = {
  agents: Agent[];
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  agentsLoading: boolean;
  setAgentsLoading: Dispatch<SetStateAction<boolean>>;
  selectedAgentFilter: string | null;
  setSelectedAgentFilter: (agentId: string | null) => void;
  selectedAgentModels: Record<string, string>;
  setSelectedAgentModels: Dispatch<SetStateAction<Record<string, string>>>;
  ensuringAgentModels: Record<string, boolean>;
  setEnsuringAgentModels: Dispatch<SetStateAction<Record<string, boolean>>>;
  mergeModelPrefs: (prefs: Record<string, string>) => void;
  setSelectedModelForAgent: (agentId: string, modelId: string) => void;
  rememberedChatAgents: Record<string, string>;
  setRememberedChatAgents: (next: Record<string, string>) => void;
  rememberChatAgent: (chatId: string, agentId: string) => void;
  clearRememberedChatAgent: (chatId: string) => void;
  reloadAgents: () => Promise<void>;
  ensureAgentModels: (agentId: string, opts: EnsureAgentModelsOptions) => Promise<void>;
};

export type OrchestrationRuntime = {
  orchestrationMode: OrchestrationMode;
  discussionRounds: number;
  setOrchestrationMode: (mode: OrchestrationMode) => void;
  setDiscussionRounds: (rounds: number) => void;
};
