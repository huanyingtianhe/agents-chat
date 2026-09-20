'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../chatTypes';
import { createIndexedDbChatOutbox, type ChatOutboxEntry } from './chatOutboxStore';
import { createIncrementalChatSaver } from './incrementalChatSaver';
import { newOperationId } from '@/lib/chatSyncProtocol';
import { migrateFailedSendWarnings } from '../chatHelpers';

export type OutboxRemoteChat = { id: string; name: string; ts: number; messages: ChatMessage[]; agentSessions: Record<string, string> };

export function useChatOutbox(
  userId: string, authStatus: string,
  onRecovered: (chat: OutboxRemoteChat | null, replaceIds?: string[], deletedChatId?: string) => void,
) {
  const [entries, setEntries] = useState<ChatOutboxEntry[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const recovered = useRef(onRecovered);
  recovered.current = onRecovered;
  const saver = useMemo(() => createIncrementalChatSaver(fetch, {
    userId, outbox: createIndexedDbChatOutbox(userId), onChange: () => setRevision(value => value + 1),
  }), [userId]);
  const working = useRef(false);
  const scope = useRef(userId);
  scope.current = userId;

  const readChat = useCallback(async (chatId: string): Promise<OutboxRemoteChat | null> => {
    const response = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return null;
    const data = await response.json();
    if (!response.ok || !data.ok || !data.chat) throw new Error(data.error || 'Failed to read the saved conversation');
    return data.chat;
  }, []);

  const retry = useCallback(async () => {
    if (working.current || authStatus !== 'authenticated') return;
    working.current = true;
    setBusy(true);
    try {
      const before = await saver.list();
      let failure = '';
      try { await saver.retryPending(); }
      catch (cause) { failure = cause instanceof Error ? cause.message : String(cause); }
      for (const id of new Set(before.map(entry => entry.operation.chat.id))) {
        const chat = await readChat(id);
        if (scope.current !== userId) return;
        if (chat) {
          const confirmedIds = await saver.refreshFromServer(chat.id, chat.messages);
          const replayedIds = new Set(before.filter(entry => entry.operation.chat.id === id)
            .flatMap(entry => entry.operation.chat.messages.filter(message => message.type === 'user').map(message => message.id)));
          const messages = chat.messages.map(message => replayedIds.has(message.id)
            ? migrateFailedSendWarnings([message], chat.agentSessions, { inferLatestUserFailure: false }).messages[0]
            : message);
          if (scope.current === userId) recovered.current({ ...chat, messages }, confirmedIds);
        }
      }
      if (scope.current === userId) setError(failure);
    } catch (cause) {
      if (scope.current === userId) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.current = false;
      setBusy(false);
      setRevision(value => value + 1);
    }
  }, [authStatus, readChat, saver, userId]);

  useEffect(() => {
    if (authStatus !== 'authenticated') { setEntries([]); return; }
    let active = true;
    void saver.list().then(rows => { if (active) setEntries(rows); })
      .catch(cause => { if (active) setError(`Local draft storage failed: ${String(cause)}`); });
    return () => { active = false; };
  }, [saver, authStatus, revision]);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void retry();
    const online = () => { void retry(); };
    window.addEventListener('online', online);
    const interval = setInterval(online, 60_000);
    return () => { clearInterval(interval); window.removeEventListener('online', online); };
  }, [authStatus, retry]);

  async function discard(entry: ChatOutboxEntry) {
    setBusy(true);
    try {
      const chat = await readChat(entry.operation.chat.id);
      if (scope.current !== userId) throw new Error('Account changed. Reopen the draft using its original account.');
      const discarded = await saver.discard(entry.operation.operationId);
      if (scope.current !== userId) return;
      if (chat) {
        await saver.refreshFromServer(chat.id, chat.messages);
        if (scope.current !== userId) return;
        recovered.current(chat, discarded.flatMap(item => item.operation.chat.messages.map(message => message.id)));
      } else recovered.current(null, undefined, entry.operation.chat.id);
      setError('');
    } catch (cause) { if (scope.current === userId) setError(String(cause)); }
    finally { setBusy(false); }
  }

  async function saveCopy(entry: ChatOutboxEntry) {
    setBusy(true);
    try {
      const original = await readChat(entry.operation.chat.id);
      if (scope.current !== userId) throw new Error('Account changed. Reopen the draft using its original account.');
      const chatId = original?.id || `chat-${newOperationId()}`;
      const savedChatId = await saver.saveCopy(entry, {
        id: chatId, name: original?.name || 'Recovered drafts',
        agentSessions: original?.agentSessions || {},
      });
      if (scope.current !== userId) return;
      const discarded = await saver.discard(entry.operation.operationId);
      if (scope.current !== userId) return;
      if (!original) recovered.current(null, undefined, entry.operation.chat.id);
      const chat = await readChat(savedChatId);
      if (scope.current !== userId) return;
      if (chat) {
        await saver.refreshFromServer(chat.id, chat.messages);
        if (scope.current !== userId) return;
        recovered.current(chat, discarded.flatMap(item => item.operation.chat.messages.map(message => message.id)));
      }
      setError('');
    } catch (cause) { if (scope.current === userId) setError(String(cause)); }
    finally { setBusy(false); }
  }

  return {
    saver,
    notice: {
      entries: entries.filter(entry => entry.userId === userId
        && !(entry.recoveryOf && entries.some(source => source.operation.operationId === entry.recoveryOf))
        && !Object.values(entry.operation.dependencies || {}).some(id =>
          entries.some(parent => parent.operation.operationId === id))), error, busy,
      onRetry: retry, onDiscard: discard, onSaveCopy: saveCopy, readChat,
    },
  };
}
