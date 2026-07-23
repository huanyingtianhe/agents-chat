'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatMessage, AgentUserRequestResponse } from '../../chat/chatTypes';
import { useStableCallback } from '../../chat/hooks/useStableCallback';
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
  const [toasts, setToasts] = useState<Array<{ id: string; text: string }>>([]);
  const [mounted, setMounted] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [copiedFormattedMessageId, setCopiedFormattedMessageId] = useState<string | null>(null);
  const seenSystemMessageIdsRef = useRef<Set<string>>(new Set());
  const toastTimeoutsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    return () => {
      for (const timeoutId of Object.values(toastTimeoutsRef.current)) {
        window.clearTimeout(timeoutId);
      }
      toastTimeoutsRef.current = {};
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    for (const message of messages) {
      if (message.type !== 'system') continue;
      if (message.id === 'welcome') continue;
      if (seenSystemMessageIdsRef.current.has(message.id)) continue;
      seenSystemMessageIdsRef.current.add(message.id);
      if (typeof message.ts === 'number' && now - message.ts > 15000) continue;

      const toastText = (message.content || '').replace(/^✅\s*/, '').trim();
      if (!toastText) continue;

      const toastId = `toast-${message.id}`;
      setToasts((prev) => [...prev, { id: toastId, text: toastText }]);
      const timeoutId = window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== toastId));
        delete toastTimeoutsRef.current[toastId];
      }, 3600);
      toastTimeoutsRef.current[toastId] = timeoutId;
    }
  }, [messages]);

  const chatMessages = useMemo(() => messages.filter((message) => message.type !== 'system'), [messages]);

  const messagesById = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);
  const messagesByIdRef = useRef(messagesById);
  messagesByIdRef.current = messagesById;

  const handleCopy = useStableCallback((messageId: string) => {
    const message = messagesByIdRef.current.get(messageId);
    if (!message) return;
    const text = getMessageCopyText(message);
    navigator.clipboard.writeText(text).then(() => {
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === message.id ? null : current);
      }, 1500);
    }).catch((err) => {
      console.error('Failed to copy message', err);
    });
  });

  const handleCopyFormatted = useStableCallback((messageId: string, html: string, text: string) => {
    const message = messagesByIdRef.current.get(messageId);
    if (!message) return;
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
  });

  // Stabilize callback identities so React.memo on MessageBubble works.
  const stableToggleExpanded = useStableCallback(onToggleExpanded);
  const stableRetryFailedSend = useStableCallback(onRetryFailedSend);
  const stableOpenImage = useStableCallback(onOpenImage);
  const stableAnswerRequest = useStableCallback(onAnswerAgentUserRequest);
  const stableDismissRequest = useStableCallback(onDismissAgentUserRequest);

  return (
    <>
      {toasts.length > 0 ? (
        <div className="chatToastStack" aria-live="polite" aria-atomic="false">
          {toasts.map((toast) => (
            <div key={toast.id} className="chatToast" role="status">{toast.text}</div>
          ))}
        </div>
      ) : null}
      {chatMessages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          agents={agents}
          failedSend={failedSendByMessageId[message.id] ?? null}
          isCollapsed={expandedMessages[message.id] === false}
          mounted={mounted}
          isCopied={copiedMessageId === message.id}
          isCopiedFormatted={copiedFormattedMessageId === message.id}
          onCopy={handleCopy}
          onCopyFormatted={handleCopyFormatted}
          onToggleExpanded={stableToggleExpanded}
          onRetryFailedSend={stableRetryFailedSend}
          onOpenImage={stableOpenImage}
          onAnswerAgentUserRequest={stableAnswerRequest}
          onDismissAgentUserRequest={stableDismissRequest}
        />
      ))}
    </>
  );
}
