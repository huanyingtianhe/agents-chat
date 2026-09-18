'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHistoryEntry, ChatMessage } from '../chatTypes';

export type InitialChatRecord = {
  name?: string;
  ts?: number;
  messages?: ChatMessage[];
  agentSessions?: Record<string, string>;
};

export type InitialChatTarget = {
  chatId: string;
  chatName: string;
};

export type InitialChatRestoreState =
  | { status: 'loading'; chatId: string | null; chatName: string | null }
  | { status: 'failed'; chatId: string | null; chatName: string | null; error: string }
  | { status: 'complete' };

type ChatListResponse = {
  ok?: boolean;
  chats?: ChatHistoryEntry[];
  lastChatId?: string | null;
  error?: string;
};

type ChatDetailResponse = {
  ok?: boolean;
  chat?: InitialChatRecord;
  error?: string;
};

type UseInitialChatRestoreParams = {
  onChatListLoaded: (data: ChatListResponse) => InitialChatTarget | null;
  onChatIdentified: (target: InitialChatTarget) => void;
  onChatLoaded: (
    target: InitialChatTarget,
    chat: InitialChatRecord,
    isCurrent: () => boolean,
  ) => void;
};

function responseError(
  response: Response,
  error: string | undefined,
  fallback: string,
): Error {
  return new Error(error || (response.ok ? fallback : `${fallback} (${response.status})`));
}

export function useInitialChatRestore(params: UseInitialChatRestoreParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const sequenceRef = useRef(0);
  const [state, setState] = useState<InitialChatRestoreState>({
    status: 'loading',
    chatId: null,
    chatName: null,
  });

  const restore = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    const isCurrent = () => sequenceRef.current === sequence;
    let target: InitialChatTarget | null = null;
    setState({ status: 'loading', chatId: null, chatName: null });

    try {
      const listResponse = await fetch('/api/chats');
      const listData = await listResponse.json() as ChatListResponse;
      if (!listResponse.ok || !listData.ok || !Array.isArray(listData.chats)) {
        throw responseError(listResponse, listData.error, 'Failed to load chats');
      }
      if (!isCurrent()) return;

      target = paramsRef.current.onChatListLoaded(listData);
      if (!target) {
        setState({ status: 'complete' });
        return;
      }

      paramsRef.current.onChatIdentified(target);
      setState({
        status: 'loading',
        chatId: target.chatId,
        chatName: target.chatName,
      });

      const detailResponse = await fetch(
        `/api/chats?id=${encodeURIComponent(target.chatId)}`,
      );
      const detailData = await detailResponse.json() as ChatDetailResponse;
      if (!detailResponse.ok || !detailData.ok || !detailData.chat) {
        throw responseError(detailResponse, detailData.error, 'Failed to load chat');
      }
      if (!isCurrent()) return;

      paramsRef.current.onChatLoaded(target, detailData.chat, isCurrent);
      if (isCurrent()) setState({ status: 'complete' });
    } catch (error) {
      if (!isCurrent()) return;
      setState({
        status: 'failed',
        chatId: target?.chatId ?? null,
        chatName: target?.chatName ?? null,
        error: error instanceof Error ? error.message : 'Failed to load chat',
      });
    }
  }, []);

  const cancel = useCallback(() => {
    sequenceRef.current++;
    setState({ status: 'complete' });
  }, []);

  useEffect(() => {
    void restore();
    return () => {
      sequenceRef.current++;
    };
  }, [restore]);

  return {
    state,
    retry: restore,
    cancel,
  };
}
