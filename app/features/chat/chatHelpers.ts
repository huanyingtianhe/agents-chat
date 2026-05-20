import type { Agent } from '../agents/agentTypes';
import type { ChatHistoryEntry, AgentUserRequestOption, AgentUserRequest, ChatMessage } from './chatTypes';

export const SCHEDULER_AGENT_ID = 'scheduler';

export function getAgentUserRequestOptionLabel(option: AgentUserRequestOption): string {
  if (option.kind === 'allow_always' || option.optionId === 'allow_always') {
    return 'Always allow in current session';
  }
  return option.label;
}

export function getAcpTurnProgressSignature(turn: {
  fullText?: string;
  done?: boolean;
  phase?: string;
  statusText?: string;
  error?: string;
  userRequest?: AgentUserRequest;
  events?: { type: string; toolName?: string; toolCallId?: string; toolArgs?: string; toolResult?: string; text?: string }[];
}): string {
  const events = Array.isArray(turn.events) ? turn.events : [];
  const lastEvent = events[events.length - 1];
  const lastEventSignature = lastEvent
    ? [
        lastEvent.type,
        lastEvent.toolCallId || '',
        lastEvent.toolName || '',
        lastEvent.toolArgs?.length || 0,
        lastEvent.toolResult?.length || 0,
        lastEvent.text?.length || 0,
      ].join(':')
    : '';
  return [
    turn.done ? 'done' : 'active',
    turn.phase || '',
    turn.statusText || '',
    turn.error || '',
    turn.userRequest?.id || '',
    turn.fullText?.length || 0,
    events.length,
    lastEventSignature,
  ].join('|');
}

export function normalizeChatHistory(chats: ChatHistoryEntry[]): ChatHistoryEntry[] {
  const byId = new Map<string, ChatHistoryEntry>();
  for (const chat of chats) {
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return Array.from(byId.values());
}

export function formatMessageTime(ts: number) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

export function getMentionedAgentIds(text: string, agents: Agent[]) {
  const matches = [...text.matchAll(/@(\S+)/g)];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const match of matches) {
    const rawId = match[1];
    const agent = agents.find((a) => a.id.toLowerCase() === rawId.toLowerCase());
    if (agent && !seen.has(agent.id)) {
      seen.add(agent.id);
      selected.push(agent.id);
    }
  }
  return selected;
}

export function getDefaultAgentId(agents: Agent[]): string | null {
  return (agents.find((agent) => agent.id !== SCHEDULER_AGENT_ID) || agents[0] || null)?.id || null;
}

export function getExistingAgentId(agentId: string | null | undefined, agents: Agent[]): string | null {
  if (!agentId) return null;
  return agents.some((agent) => agent.id === agentId) ? agentId : null;
}

export function parseAgents(text: string, agents: Agent[], preferredAgentId?: string | null) {
  const agentIds = getMentionedAgentIds(text, agents);
  if (agentIds.length === 0) {
    // Use preferred agent (from chat's agentId) if available, otherwise fall back to first non-scheduler
    const fallbackId = getExistingAgentId(preferredAgentId, agents) || getDefaultAgentId(agents) || 'main';
    return { agentIds: [fallbackId], message: text };
  }
  const message = text.replace(/(?:^|\s)@(\S+)/g, '').trim();
  return { agentIds, message: message || text };
}

/** Extract the current (last) session ID — handles both string and string[] from SQLite. */
export function lastSessionId(val: unknown): string | null {
  if (Array.isArray(val)) return val.length > 0 ? val[val.length - 1] : null;
  if (typeof val === 'string' && val) return val;
  return null;
}

export function isAcpFailureResult(value: unknown): value is { ok?: unknown; error?: unknown } {
  return !!value && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok !== true;
}

export function isSendFailureMessage(message: ChatMessage): boolean {
  if (message.type !== 'agent' && message.type !== 'system') return false;
  const text = message.content.trim();
  if (message.type === 'system') {
    return /^(?:⚠️\s*)?Send failed:/i.test(text);
  }
  return text.startsWith('⚠️') && (
    text.includes('Failed to send prompt to agent') ||
    text.includes('Send failed')
  );
}

export function getSendFailureError(message: ChatMessage): string {
  const text = message.content.trim();
  return text.replace(/^⚠️\s*/, '').replace(/^Send failed:\s*/i, '') || 'Failed to send prompt to agent';
}

export function shouldInferFailedTargetFromWarning(userMessage: ChatMessage): boolean {
  return !/(?:^|\s)@\S+/.test(userMessage.content);
}

export function hasPersistedAgentSession(agentSessions?: Record<string, string>): boolean {
  return Object.values(agentSessions || {}).some((session) => !!lastSessionId(session));
}

export function hasVisibleMessageText(message: ChatMessage): boolean {
  return Boolean(
    message.content.trim() ||
    message.parts?.some((part) => part.kind === 'text' && part.text.trim())
  );
}

export function getLatestUserWithoutSavedResponseIndex(chatMessages: ChatMessage[]): number {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const message = chatMessages[i];
    if (message.type === 'system') continue;
    if (message.type === 'user') return i;
    if (hasVisibleMessageText(message)) return -1;
  }
  return -1;
}

export function migrateFailedSendWarnings(
  chatMessages: ChatMessage[],
  agentSessions?: Record<string, string>,
  options?: { inferLatestUserFailure?: boolean },
): { messages: ChatMessage[]; changed: boolean } {
  const inferLatestUserFailure = options?.inferLatestUserFailure !== false;
  const migrated: ChatMessage[] = [];
  let changed = false;
  for (const message of chatMessages) {
    if (isSendFailureMessage(message)) {
      const previous = migrated[migrated.length - 1];
      if (previous?.type === 'user') {
        const shouldInferTarget = shouldInferFailedTargetFromWarning(previous);
        const resendAgentIds = shouldInferTarget && message.agentId ? [message.agentId] : previous.resendAgentIds;
        migrated[migrated.length - 1] = {
          ...previous,
          sendStatus: 'failed',
          sendError: getSendFailureError(message),
          resendAgentIds,
          resendMessage: shouldInferTarget ? (previous.resendMessage || previous.content) : previous.resendMessage,
        };
        changed = true;
        continue;
      }
    }
    migrated.push(message);
  }
  if (inferLatestUserFailure && !hasPersistedAgentSession(agentSessions)) {
    const userIndex = getLatestUserWithoutSavedResponseIndex(migrated);
    const userMessage = userIndex >= 0 ? migrated[userIndex] : null;
    if (userMessage?.type === 'user' && userMessage.sendStatus !== 'failed') {
      migrated[userIndex] = {
        ...userMessage,
        sendStatus: 'failed',
        sendError: userMessage.sendError || 'Failed to send prompt to agent',
      };
      changed = true;
    }
  }
  return { messages: migrated, changed };
}

export function getPersistableMessages(chatMessages: ChatMessage[]): ChatMessage[] {
  return chatMessages.filter(m => !(m.type === 'system' && m.ts !== 0));
}

export function getMessageCopyText(message: ChatMessage): string {
  if (message.parts && message.parts.length > 0) {
    return message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('') || message.content || '';
  }
  return message.content || '';
}
