'use client';

import { useCallback, useRef, useState } from 'react';
import { createChatScrollController, type ChatScrollController, type ChatScrollSnapshot } from './chatScrollController';

export function useChatScroll(chatId: string) {
  const chatContainerRef = useRef<HTMLElement | null>(null);
  const controllerRef = useRef<ChatScrollController | null>(null);
  const snapshotsRef = useRef(new Map<string, ChatScrollSnapshot>());
  const restoreRef = useRef<{ chatId: string; snapshot: ChatScrollSnapshot } | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const attachChatContainer = useCallback((container: HTMLElement | null) => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    chatContainerRef.current = container;
    if (!container) return;
    const restore = restoreRef.current;
    const snapshot = restore?.chatId === chatId ? restore.snapshot : undefined;
    restoreRef.current = null;
    controllerRef.current = createChatScrollController(
      container, (atBottom) => setShowScrollToBottom(!atBottom), snapshot,
    );
  }, [chatId]);

  const handleBeforeFileTabChange = useCallback((tab: 'chats' | 'files') => {
    if (tab === 'files') {
      if (chatId && controllerRef.current) snapshotsRef.current.set(chatId, controllerRef.current.snapshot());
      controllerRef.current?.suspend();
    } else {
      const snapshot = snapshotsRef.current.get(chatId);
      restoreRef.current = snapshot ? { chatId, snapshot } : null;
      if (chatContainerRef.current) attachChatContainer(chatContainerRef.current);
    }
  }, [chatId, attachChatContainer]);

  const prepareChatLoad = useCallback(() => {
    restoreRef.current = null;
    controllerRef.current?.suspend();
    setShowScrollToBottom(false);
  }, []);

  const scrollToLatest = useCallback(() => controllerRef.current?.jumpToLatest(), []);

  return {
    chatContainerRef, attachChatContainer, showScrollToBottom,
    handleBeforeFileTabChange, prepareChatLoad, scrollToLatest,
  };
}
