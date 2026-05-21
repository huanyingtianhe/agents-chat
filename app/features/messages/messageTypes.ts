import type { AgentUserRequestResponse, ChatMessage, ContentPart } from '../chat/chatTypes';
import type { FailedSendState } from '../chat/components/FailedSendControls';

export type MessageActionHandlers = {
  onToggleExpanded: (messageId: string) => void;
  onRetryFailedSend: (messageId: string) => void;
};

export type AgentRequestHandlers = {
  onAnswerAgentUserRequest: (requestId: string, response: AgentUserRequestResponse) => Promise<void>;
  onDismissAgentUserRequest: (requestId: string) => void;
};

export type RenderableContentPart = ContentPart;

export type FailedSendByMessageId = Record<string, FailedSendState | undefined>;
