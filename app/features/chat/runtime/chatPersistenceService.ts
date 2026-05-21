import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ChatHistoryEntry, ChatMessage, ShareDialog } from '../chatTypes';
import { getPersistableMessages, migrateFailedSendWarnings, normalizeChatHistory, lastSessionId } from '../chatHelpers';
import { STORAGE_INPUT_HISTORY } from './sessionPersistence';

export type PersistenceContext = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  currentChatIdRef: MutableRefObject<string>;
  currentAgentSessionsRef: MutableRefObject<Record<string, string>>;
  needsContextRestoreRef: MutableRefObject<boolean>;
  chatMessagesRef: MutableRefObject<Record<string, ChatMessage[]>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  chatNameRef: MutableRefObject<string>;
  chatAgentFilterRef: MutableRefObject<string | null>;
  chatHistoryRef: MutableRefObject<ChatHistoryEntry[]>;
  setChatHistory: Dispatch<SetStateAction<ChatHistoryEntry[]>>;
  setChatName: Dispatch<SetStateAction<string>>;
  setChatCounter: Dispatch<SetStateAction<number>>;
  setCurrentChatId: Dispatch<SetStateAction<string>>;
  setActiveSidebarChatId: Dispatch<SetStateAction<string>>;
  setShareDialog: Dispatch<SetStateAction<ShareDialog | null>>;
  setExpandedMessages: Dispatch<SetStateAction<Record<string, boolean>>>;
  setMessagesForChat: (chatId: string, messages: ChatMessage[]) => void;
  addMessage: (msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }, chatId?: string) => string;
  resumeActiveTurn: (agentId: string, turn: any) => void;
  onClearInput?: () => void;
  onClearAgentFilter?: () => void;
  onCloseChatsPanel?: () => void;
  onCloseAgentsPanel?: () => void;
  inputHistoryRef?: MutableRefObject<Record<string, string[]>>;
};

export function createPersistenceHandlers(ctx: PersistenceContext) {
  async function persistLoadedChatMigration(
    chatId: string, name: string, ts: number,
    chatMessages: ChatMessage[], agentSessions: Record<string, string>,
  ) {
    const chatData = {
      id: chatId, name: name || chatId, ts: ts || Date.now(),
      messages: getPersistableMessages(chatMessages), agentSessions,
    };
    try {
      await fetch('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatData }),
      });
    } catch { /* ignore */ }
  }

  async function loadChatIntoCache(chatId: string) {
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (data.ok && data.chat) {
        const agentSessions = data.chat.agentSessions || {};
        const isReviewChat = typeof chatId === 'string' && chatId.startsWith('comment-review:');
        const migration = migrateFailedSendWarnings(data.chat.messages || [], agentSessions, {
          inferLatestUserFailure: !isReviewChat,
        });
        ctx.setMessagesForChat(chatId, migration.messages);
        if (migration.changed) {
          void persistLoadedChatMigration(chatId, data.chat.name || chatId, data.chat.ts || Date.now(), migration.messages, agentSessions);
        }
        ctx.setChatHistory(prev => {
          const entry = {
            id: data.chat.id,
            name: data.chat.name || chatId,
            ts: data.chat.ts || Date.now(),
            agentSessions,
          };
          if (prev.some(c => c.id === chatId)) return prev.map(c => c.id === chatId ? entry : c);
          return normalizeChatHistory([entry, ...prev]);
        });
      }
    } catch (err) {
      console.error('Failed to load review chat', err);
    }
  }

  async function saveChatToHistory(chatId: string, _preserveOrder = false) {
    if (!chatId) return Date.now();
    const currentMessages = ctx.chatMessagesRef.current[chatId]
      || (chatId === ctx.currentChatIdRef.current ? ctx.messagesRef.current : []);
    const existingHistoryEntry = ctx.chatHistoryRef.current.find(c => c.id === chatId);
    const currentName = chatId === ctx.currentChatIdRef.current
      ? ctx.chatNameRef.current
      : (existingHistoryEntry?.name || chatId);
    const userMsgs = currentMessages.filter(m => m.type === 'user');
    const firstUser = userMsgs[0];
    const attachmentName = firstUser?.attachments?.[0]?.name;
    const hasCustomName = existingHistoryEntry?.name && existingHistoryEntry.name !== 'New Chat';
    const autoName = firstUser
      ? (firstUser.content.trim().slice(0, 50) || (attachmentName ? `Attached file: ${attachmentName}`.slice(0, 50) : currentName))
      : currentName;
    const name = hasCustomName ? existingHistoryEntry!.name : autoName;
    const persistable = getPersistableMessages(currentMessages);
    const agentSessions = chatId === ctx.currentChatIdRef.current
      ? ctx.currentAgentSessionsRef.current
      : (existingHistoryEntry?.agentSessions || {});
    const agentId = existingHistoryEntry?.agentId || '';
    const savedAt = existingHistoryEntry?.ts ?? Date.now();
    const chatData = { id: chatId, name, ts: savedAt, messages: persistable, agentSessions, agentId };
    try {
      await fetch('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: chatData }),
      });
      if (chatId === ctx.currentChatIdRef.current) {
        await fetch('/api/chats', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set-last-chat', chatId }),
        });
      }
    } catch { /* ignore */ }
    ctx.setChatHistory(prev => {
      const entry = { id: chatId, name, ts: savedAt, agentSessions, agentId };
      if (prev.some(c => c.id === chatId)) return prev.map(c => c.id === chatId ? entry : c);
      return normalizeChatHistory([entry, ...prev]);
    });
    return savedAt;
  }

  async function saveCurrentChatToHistory(preserveOrder = false) {
    return saveChatToHistory(ctx.currentChatIdRef.current, preserveOrder);
  }

  function clearChatMessages(opts?: { clearAgentFilter?: boolean }) {
    const initial: ChatMessage[] = [{
      id: 'welcome', type: 'system',
      content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.',
      ts: 0,
    }];
    ctx.setMessagesForChat(ctx.currentChatIdRef.current, initial);
    ctx.setExpandedMessages({});
    ctx.onClearInput?.();
    if (opts?.clearAgentFilter !== false) ctx.onClearAgentFilter?.();
  }

  async function loadChat(chatId: string) {
    const currentChatId = ctx.currentChatIdRef.current;
    if (chatId === currentChatId) return;

    ctx.setActiveSidebarChatId(chatId);
    await saveCurrentChatToHistory(true);

    let targetMessages: ChatMessage[] = [];
    let targetName = ctx.chatHistoryRef.current.find(c => c.id === chatId)?.name || chatId;
    let agentSessions: Record<string, string> = {};
    let migratedFailedSendState = false;
    let targetTs = Date.now();
    try {
      const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok || !data.chat) {
        ctx.addMessage({ type: 'system', content: `Failed to load chat: ${data.error || 'not found'}` });
        return;
      }
      if (data.ok && data.chat) {
        agentSessions = data.chat.agentSessions || {};
        const cachedMessages = ctx.chatMessagesRef.current[chatId];
        if (cachedMessages) {
          targetMessages = cachedMessages;
        } else {
          const isReviewChat = typeof chatId === 'string' && chatId.startsWith('comment-review:');
          const migration = migrateFailedSendWarnings(data.chat.messages || [], agentSessions, {
            inferLatestUserFailure: !isReviewChat,
          });
          targetMessages = migration.messages;
          migratedFailedSendState = migration.changed;
        }
        targetName = data.chat.name || targetName;
        targetTs = data.chat.ts || targetTs;
        ctx.currentAgentSessionsRef.current = agentSessions;
      }
    } catch {
      ctx.addMessage({ type: 'system', content: 'Failed to load chat. Please try again.' });
      return;
    }

    if (targetMessages.length === 0) {
      targetMessages = [{
        id: 'welcome', type: 'system',
        content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.',
        ts: 0,
      }];
    }

    ctx.currentChatIdRef.current = chatId;
    ctx.setMessagesForChat(chatId, targetMessages);
    ctx.setChatName(targetName);
    ctx.setCurrentChatId(chatId);
    ctx.setExpandedMessages({});
    ctx.onClearInput?.();

    // Backfill input history from loaded messages if none exists for this chat
    if (ctx.inputHistoryRef && !ctx.inputHistoryRef.current[chatId]) {
      const userTexts = targetMessages
        .filter(m => m.type === 'user' && m.content)
        .map(m => m.content as string)
        .filter(t => t.trim().length > 0);
      if (userTexts.length > 0) {
        ctx.inputHistoryRef.current[chatId] = userTexts.slice(-100);
        try { window.localStorage.setItem(STORAGE_INPUT_HISTORY, JSON.stringify(ctx.inputHistoryRef.current)); } catch { /* ignore */ }
      }
    }
    if (migratedFailedSendState) {
      void persistLoadedChatMigration(chatId, targetName, targetTs, targetMessages, agentSessions);
    }
    ctx.setChatHistory(prev => {
      if (prev.some(c => c.id === chatId)) return prev.map(c => c.id === chatId ? { ...c, name: targetName, agentSessions } : c);
      return [...prev, { id: chatId, name: targetName, ts: Date.now(), agentSessions }];
    });

    // Persist last active chat AFTER all state updates to fix lastChatId race
    void fetch('/api/chats', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set-last-chat', chatId }),
    }).catch(() => { /* ignore */ });

    const hasAnySessions = Object.values(agentSessions).some(s => !!lastSessionId(s));
    ctx.needsContextRestoreRef.current = true;
    if (hasAnySessions) {
      const sessionEntries = Object.entries(agentSessions)
        .map(([agentId, raw]) => [agentId, lastSessionId(raw)] as [string, string | null])
        .filter(([, sid]) => !!sid) as [string, string][];
      const resumeResults = await Promise.allSettled(
        sessionEntries.map(([agentId, sessionId]) =>
          ctx.acp({ action: 'resume-session', agentId, sessionId, chatId }),
        ),
      );
      const allLoaded = resumeResults.every(r => r.status === 'fulfilled' && (r as any).value?.loaded === true);
      if (allLoaded) ctx.needsContextRestoreRef.current = false;
      for (const [index, r] of resumeResults.entries()) {
        if (r.status !== 'fulfilled') continue;
        const agentId = sessionEntries[index]?.[0];
        const val = (r as any).value;
        if (agentId && val?.sessionId) {
          ctx.currentAgentSessionsRef.current = { ...ctx.currentAgentSessionsRef.current, [agentId]: val.sessionId };
        }
        if (agentId && val?.activeTurn && !val.activeTurn.done) {
          ctx.resumeActiveTurn(agentId, val.activeTurn);
        }
        if (val?.recoveredMessages?.length > 0) {
          for (const rm of val.recoveredMessages) {
            ctx.addMessage({ type: 'agent', content: rm.content, agentId: rm.agentId, ts: rm.ts });
          }
          ctx.addMessage({ type: 'system', content: `✅ Recovered ${val.recoveredMessages.length} message(s) from previous session.` });
        }
      }
    }
    ctx.onCloseChatsPanel?.();
    ctx.onCloseAgentsPanel?.();
  }

  async function createNewChat(chatAgentFilter?: string | null) {
    await saveCurrentChatToHistory();
    const newName = 'New Chat';
    const newId = `chat-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    ctx.currentChatIdRef.current = newId;
    clearChatMessages();
    ctx.setChatName(newName);
    ctx.setChatCounter(prev => prev + 1);
    ctx.currentAgentSessionsRef.current = {};
    ctx.setCurrentChatId(newId);
    ctx.setActiveSidebarChatId(newId);
    try {
      await fetch('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-last-chat', chatId: newId }),
      });
    } catch { /* ignore */ }
    const newEntry: ChatHistoryEntry = { id: newId, name: newName, ts: Date.now(), agentId: chatAgentFilter || undefined };
    ctx.setChatHistory(prev => {
      if (prev.some(c => c.id === newId)) return prev;
      return normalizeChatHistory([newEntry, ...prev]);
    });
    try {
      await fetch('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: { ...newEntry, messages: [], agentSessions: {} } }),
      });
    } catch { /* ignore */ }
    ctx.addMessage({ type: 'system', content: `✅ New chat "${newName}" created.` });
    ctx.onCloseChatsPanel?.();
    ctx.onCloseAgentsPanel?.();
    fetch('/api/chats').then(r => r.json()).then(data => {
      if (data.ok && Array.isArray(data.chats)) ctx.setChatHistory(normalizeChatHistory(data.chats));
    }).catch(() => { /* ignore */ });
    return newId;
  }

  async function shareCurrentChat(chatId: string) {
    await saveCurrentChatToHistory();
    try {
      const res = await fetch('/api/share', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        const fullUrl = `${window.location.origin}${data.url}`;
        ctx.setShareDialog({ variant: 'link', title: 'Share this conversation', url: fullUrl });
      } else {
        ctx.setShareDialog({ variant: 'error', title: 'Share failed', detail: data.error || 'unknown error' });
      }
    } catch {
      ctx.setShareDialog({ variant: 'error', title: 'Failed to create share link' });
    }
  }

  async function renameChatById(chatId: string, newName: string, onDone?: () => void) {
    if (!newName.trim()) return;
    const trimmed = newName.trim();
    try {
      await fetch('/api/chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', chatId, name: trimmed }),
      });
      ctx.setChatHistory(prev => prev.map(c => c.id === chatId ? { ...c, name: trimmed } : c));
      if (chatId === ctx.currentChatIdRef.current) ctx.setChatName(trimmed);
    } catch { /* ignore */ }
    onDone?.();
  }

  async function deleteChatById(chatId: string, onDone?: () => void) {
    try {
      await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { method: 'DELETE' });
      ctx.setChatHistory(prev => prev.filter(c => c.id !== chatId));
      if (chatId === ctx.currentChatIdRef.current) {
        ctx.currentChatIdRef.current = '';
        ctx.setCurrentChatId('');
        ctx.setActiveSidebarChatId('');
        ctx.setChatName('New Chat');
        clearChatMessages();
        ctx.currentAgentSessionsRef.current = {};
      }
    } catch { /* ignore */ }
    onDone?.();
  }

  return {
    loadChatIntoCache, persistLoadedChatMigration, saveChatToHistory, saveCurrentChatToHistory,
    clearChatMessages, loadChat, createNewChat, shareCurrentChat, renameChatById, deleteChatById,
  };
}
