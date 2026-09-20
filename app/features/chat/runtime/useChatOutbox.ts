'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../chatTypes';
import { createIndexedDbChatOutbox, type ChatOutboxEntry } from './chatOutboxStore';
import { createIncrementalChatSaver } from './incrementalChatSaver';
import { newOperationId } from '@/lib/chatSyncProtocol';

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
      await saver.retryPending();
      for (const id of new Set(before.map(entry => entry.operation.chat.id))) {
        const chat = await readChat(id);
        if (chat) recovered.current(chat);
      }
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      working.current = false;
      setBusy(false);
      setRevision(value => value + 1);
    }
  }, [authStatus, readChat, saver]);

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
      const discarded = await saver.discard(entry.operation.operationId);
      if (chat) {
        saver.hydrate(chat.id, chat.messages);
        recovered.current(chat, discarded.flatMap(item => item.operation.chat.messages.map(message => message.id)));
      } else recovered.current(null, undefined, entry.operation.chat.id);
      setError('');
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  async function saveCopy(entry: ChatOutboxEntry) {
    setBusy(true);
    try {
      const original = await readChat(entry.operation.chat.id);
      const chatId = original?.id || `chat-${newOperationId()}`;
      await saver.saveCopy(entry, {
        id: chatId, name: original?.name || 'Recovered drafts',
        agentSessions: original?.agentSessions || {},
      });
      const discarded = await saver.discard(entry.operation.operationId);
      if (!original) recovered.current(null, undefined, entry.operation.chat.id);
      const chat = await readChat(chatId);
      if (chat) {
        saver.hydrate(chat.id, chat.messages);
        recovered.current(chat, discarded.flatMap(item => item.operation.chat.messages.map(message => message.id)));
      }
      setError('');
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }

  return {
    saver,
    notice: {
      entries: entries.filter(entry => entry.userId === userId
        && !Object.values(entry.operation.dependencies || {}).some(id =>
          entries.some(parent => parent.operation.operationId === id))), error, busy,
      onRetry: retry, onDiscard: discard, onSaveCopy: saveCopy, readChat,
    },
  };
}
