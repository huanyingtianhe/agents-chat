'use client';

import { useState } from 'react';
import type { useChatOutbox } from '../runtime/useChatOutbox';
import type { ChatOutboxEntry } from '../runtime/chatOutboxStore';
import './ChatOutboxNotice.css';

type Props = ReturnType<typeof useChatOutbox>['notice'];

export function ChatOutboxNotice({ entries, error, busy, onRetry, onDiscard, onSaveCopy, readChat }: Props) {
  const [remote, setRemote] = useState<Record<string, string>>({});
  if (!entries.length && !error) return null;
  async function compare(entry: ChatOutboxEntry) {
    try {
      const chat = await readChat(entry.operation.chat.id);
      const ids = new Set(entry.operation.chat.messages.map(message => message.id));
      const text = chat ? chat.messages.filter(message => ids.has(message.id)).map(message => message.content).join('\n\n') : 'This conversation was deleted.';
      setRemote(previous => ({ ...previous, [entry.operation.operationId]: text || 'No matching saved message.' }));
    } catch (cause) {
      setRemote(previous => ({ ...previous, [entry.operation.operationId]: `Could not read saved version: ${String(cause)}` }));
    }
  }
  function download(entry: ChatOutboxEntry) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(entry.operation.chat, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `chat-draft-${entry.operation.operationId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <aside className="chatOutbox" data-testid="chat-outbox" aria-label="Unsynced chat drafts">
      <details>
        <summary><strong>{entries.length ? `${entries.length} local draft${entries.length === 1 ? '' : 's'}` : 'Chat sync needs attention'}</strong><span>{busy ? 'Saving...' : 'Review & recover'}</span></summary>
        <p>Drafts stay in this browser until confirmed by the server. Recovery never starts an agent task.</p>
        {error && <p role="status" className="chatOutboxError">{error}</p>}
        <button type="button" disabled={busy} onClick={() => void onRetry()}>Retry saving drafts</button>
        {entries.map(entry => (
          <article key={entry.operation.operationId}>
            <strong>{entry.operation.chat.name}</strong>
            <p>{entry.error || 'Waiting for server confirmation'}</p>
            <details>
              <summary>Local version</summary>
              <pre>{entry.operation.chat.messages.map(message => message.content).join('\n\n')}</pre>
              <p>{entry.operation.chat.messages.reduce((total, message) => total + (message.attachments?.length || 0), 0)} attachments preserved in draft</p>
            </details>
            {remote[entry.operation.operationId] && <details open><summary>Server version</summary><pre>{remote[entry.operation.operationId]}</pre></details>}
            <div className="chatOutboxActions">
              <button type="button" disabled={busy} onClick={() => void compare(entry)}>View server version</button>
              <button type="button" onClick={() => download(entry)}>Download draft</button>
              <button type="button" disabled={busy} onClick={() => void onSaveCopy(entry)}>Save as new message</button>
              <button type="button" disabled={busy} onClick={() => void onDiscard(entry)}>Discard local draft</button>
            </div>
          </article>
        ))}
      </details>
    </aside>
  );
}
