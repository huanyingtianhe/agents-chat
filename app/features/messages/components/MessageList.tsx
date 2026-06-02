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
  const [copiedFormattedMessageId, setCopiedFormattedMessageId] = useState<string | null>(null);

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

  function handleCopyFormatted(message: ChatMessage, html: string, text: string) {
    const flagCopied = () => {
      setCopiedFormattedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedFormattedMessageId((current) => current === message.id ? null : current);
      }, 1500);
    };
    const fallbackText = text || getMessageCopyText(message);
    const ClipboardItemCtor = typeof window !== 'undefined' ? (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem : undefined;
    if (ClipboardItemCtor && navigator.clipboard && typeof navigator.clipboard.write === 'function') {
      const item = new ClipboardItemCtor({
        'text/html': new Blob([html || `<pre>${fallbackText}</pre>`], { type: 'text/html' }),
        'text/plain': new Blob([fallbackText], { type: 'text/plain' }),
      });
      navigator.clipboard.write([item]).then(flagCopied).catch((err) => {
        console.error('Failed to copy formatted message, falling back to plain text', err);
        navigator.clipboard.writeText(fallbackText).then(flagCopied).catch((err2) => {
          console.error('Failed to copy message', err2);
        });
      });
    } else {
      navigator.clipboard.writeText(fallbackText).then(flagCopied).catch((err) => {
        console.error('Failed to copy message', err);
      });
    }
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
          isCopiedFormatted={copiedFormattedMessageId === message.id}
          onCopy={() => handleCopy(message)}
          onCopyFormatted={(html, text) => handleCopyFormatted(message, html, text)}
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
