import { hasPersistedAgentSession } from './chatHelpers';
import type { ChatGitContext, ChatGitContextOptions } from './chatGitContextTypes';

export async function fetchChatGitContext(chatId: string, signal?: AbortSignal): Promise<{ options: ChatGitContextOptions | null; selected: ChatGitContext | null; locked: boolean; error: string | null }> {
  const res = await fetch(`/api/chats?id=${encodeURIComponent(chatId)}`, { signal });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    return { options: null, selected: null, locked: false, error: data?.error || 'Failed to load git context' };
  }
  const options = (data.gitContextOptions || null) as ChatGitContextOptions | null;
  const selected = ((data.chat?.gitContext as ChatGitContext | undefined) || options?.effective || null);
  const locked = hasPersistedAgentSession(data.chat?.agentSessions);
  return { options, selected, locked, error: null };
}

export async function saveChatGitContext(chatId: string, gitContext: ChatGitContext): Promise<{ ok: boolean; gitContext?: ChatGitContext; error?: string }> {
  const res = await fetch('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update-git-context', chatId, gitContext }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) {
    return { ok: false, error: data?.error || 'Failed to update git context' };
  }
  return { ok: true, gitContext: data.gitContext as ChatGitContext };
}
