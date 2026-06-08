import type { OrchestrationState } from '../chat/chatTypes';

/**
 * Persist a single orchestration to SQLite. Fire-and-forget: callers should
 * not await unless they need to know about failure. We intentionally swallow
 * network errors to avoid disrupting orchestration progress.
 */
export function persistOrchestration(state: OrchestrationState): void {
  if (!state.sourceChatId) return;
  // Strip non-serializable bits if any (currently none — state is plain data).
  const payload = {
    id: state.id,
    chatId: state.sourceChatId,
    state,
  };
  void fetch('/api/orchestrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => { /* ignore */ });
}

export function deletePersistedOrchestration(id: string): void {
  void fetch(`/api/orchestrations?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    .catch(() => { /* ignore */ });
}

export async function loadPersistedOrchestrations(chatId: string): Promise<OrchestrationState[]> {
  try {
    const res = await fetch(`/api/orchestrations?chatId=${encodeURIComponent(chatId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.items)) return [];
    return data.items
      .map((it: { state: OrchestrationState }) => it.state)
      .filter((s: OrchestrationState | null | undefined): s is OrchestrationState => !!s && !!s.id);
  } catch {
    return [];
  }
}
