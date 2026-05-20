'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatMessage, AgentUserRequestResponse } from '../../chat/chatTypes';
import type { FailedSendByMessageId } from '../messageTypes';
import { MessageBubble, getMessageCopyText } from './MessageBubble';

export function MessageList({
  messages,
  agents,
  expandedMessages,
  failedSendByMessageId,
  onToggleExpanded,
  onRetryFailedSend,
  onOpenImage,
  onAnswerAgentUserRequest,
  onDismissAgentUserRequest,
}: {
  messages: ChatMessage[];
  agents: Agent[];
  expandedMessages: Record<string, boolean>;
  failedSendByMessageId: FailedSendByMessageId;
  onToggleExpanded: (messageId: string) => void;
  onRetryFailedSend: (messageId: string) => void;
  onOpenImage: (src: string) => void;
  onAnswerAgentUserRequest: (requestId: string, response: AgentUserRequestResponse) => Promise<void>;
  onDismissAgentUserRequest: (requestId: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  function handleCopy(message: ChatMessage) {
    const text = getMessageCopyText(message);
    navigator.clipboard.writeText(text).then(() => {
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === message.id ? null : current);
      }, 1500);
    }).catch((err) => {
      console.error('Failed to copy message', err);
    });
  }

  return (
    <>
      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          agents={agents}
          failedSend={failedSendByMessageId[message.id] ?? null}
          isCollapsed={expandedMessages[message.id] === false}
          mounted={mounted}
          isCopied={copiedMessageId === message.id}
          onCopy={() => handleCopy(message)}
          onToggleExpanded={() => onToggleExpanded(message.id)}
          onRetryFailedSend={() => onRetryFailedSend(message.id)}
          onOpenImage={onOpenImage}
          onAnswerAgentUserRequest={onAnswerAgentUserRequest}
          onDismissAgentUserRequest={onDismissAgentUserRequest}
        />
      ))}
    </>
  );
}
