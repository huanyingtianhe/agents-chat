import type { ChatMessage } from '../chatTypes';

type ChatSnapshot = {
  id: string;
  name: string;
  ts: number;
  agentId?: string;
  agentSessions: Record<string, string>;
  messages: ChatMessage[];
};

const MAX_SAVE_BYTES = 512 * 1024;

function clientMessage(message: ChatMessage): ChatMessage {
  // ACP persists full tool/thinking parts directly. Never upload them back
  // through the proxy; delta writes preserve the server's original parts.
  if (message.type === 'agent') {
    const { parts: _parts, ...rest } = message;
    return rest;
  }
  return message;
}

export async function postChatJson(body: unknown, request: typeof fetch = fetch): Promise<void> {
  const response = await request('/api/chats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(response.status === 413
      ? 'Chat save rejected: request too large (HTTP 413). The message has not been sent.'
      : `Chat save failed (HTTP ${response.status}). Please retry.`);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
    const detail = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
      ? result.error : 'Invalid server response';
    throw new Error(`Chat save failed: ${detail}`);
  }
}

export function createIncrementalChatSaver(request: typeof fetch = fetch) {
  const baselines = new Map<string, Map<string, string>>();
  const queues = new Map<string, Promise<void>>();

  function serialize(messages: ChatMessage[]) {
    return new Map(messages
      .filter(message => message.type !== 'system' || message.ts === 0)
      .map(message => [message.id, JSON.stringify(clientMessage(message))]));
  }

  function hydrate(chatId: string, messages: ChatMessage[]) {
    if (!baselines.has(chatId)) baselines.set(chatId, serialize(messages));
  }

  async function save(snapshot: ChatSnapshot): Promise<void> {
    const { messages, ...metadata } = snapshot;
    const current = serialize(messages);
    const previousSave = queues.get(snapshot.id) || Promise.resolve();
    const nextSave = previousSave.then(async () => {
      const baseline = baselines.get(snapshot.id) || new Map<string, string>();
      const changed = [...current].filter(([id, value]) => baseline.get(id) !== value);
      const removedMessageIds = [...baseline.keys()].filter(id => !current.has(id));
      const makeBody = (batch: ChatMessage[]) => ({
        action: 'save-delta',
        chat: { ...metadata, messages: batch, removedMessageIds },
      });
      const byteLength = (batch: ChatMessage[]) => new TextEncoder().encode(JSON.stringify(makeBody(batch))).length;
      const batches: ChatMessage[][] = [];
      let batch: ChatMessage[] = [];
      for (const [, value] of changed) {
        const message: ChatMessage = JSON.parse(value);
        if (batch.length && byteLength([...batch, message]) > MAX_SAVE_BYTES) {
          batches.push(batch);
          batch = [];
        }
        batch.push(message);
      }
      batches.push(batch);
      for (const messages of batches) {
        // A single large attachment still uses the deployment's existing size
        // limit. A 413 is reported, never treated as a successful save.
        await postChatJson(makeBody(messages), request);
        for (const message of messages) baseline.set(message.id, current.get(message.id)!);
        for (const id of removedMessageIds) baseline.delete(id);
        baselines.set(snapshot.id, baseline);
      }
    });
    // Keep the queue usable after a failure; the caller still receives the error.
    const settled = nextSave.catch(() => {});
    queues.set(snapshot.id, settled);
    try {
      await nextSave;
    } finally {
      if (queues.get(snapshot.id) === settled) queues.delete(snapshot.id);
    }
  }

  return { hydrate, save };
}

export type IncrementalChatSaver = ReturnType<typeof createIncrementalChatSaver>;
