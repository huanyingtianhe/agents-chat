'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type SharedMessage = {
  id: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  agentId?: string;
  ts: number;
  parts?: { kind: string; text?: string; toolName?: string; args?: string; result?: string; done?: boolean }[];
};

type SharedChat = {
  shareId: string;
  sharedBy: string;
  sharedAt: number;
  name: string;
  messages: SharedMessage[];
};

function formatTime(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function SharedChatPage() {
  const params = useParams();
  const router = useRouter();
  const shareId = params.id as string;
  const [chat, setChat] = useState<SharedChat | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    fetch(`/api/share?id=${encodeURIComponent(shareId)}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok && data.chat) setChat(data.chat);
        else setError(data.error || 'Not found');
      })
      .catch(() => setError('Failed to load'))
      .finally(() => setLoading(false));
  }, [shareId]);

  async function handleContinue() {
    if (!chat || importing) return;
    setImporting(true);
    try {
      const res = await fetch('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', shareId: chat.shareId }),
      });
      const data = await res.json();
      if (data.ok && data.chatId) {
        // Store the chat ID so the main page picks it up
        window.localStorage.setItem('acp_chat_current_id_v1', data.chatId);
        router.push('/');
      } else {
        setError(data.error || 'Import failed');
      }
    } catch {
      setError('Failed to import chat');
    } finally {
      setImporting(false);
    }
  }

  if (loading) return <div className="sharePage"><div className="shareLoading">Loading shared chat…</div></div>;
  if (error || !chat) return <div className="sharePage"><div className="shareError">{error || 'Chat not found'}</div></div>;

  return (
    <div className="sharePage">
      <header className="shareHeader">
        <h1>🤖 {chat.name}</h1>
        <div className="shareMeta">
          Shared by {chat.sharedBy} · {new Date(chat.sharedAt).toLocaleDateString()} · {chat.messages.length} messages
        </div>
      </header>
      <div className="shareMessages">
        {chat.messages.map((msg) => (
          <div key={msg.id} className={`shareMsg ${msg.type}`}>
            {msg.type !== 'user' && (
              <div className="shareMsgHeader">
                <span className="shareMsgAgent">{msg.type === 'system' ? 'System' : (msg.agentId || 'Agent')}</span>
                <span className="shareMsgTime">{formatTime(msg.ts)}</span>
              </div>
            )}
            {msg.type === 'user' && (
              <div className="shareMsgHeader" style={{ justifyContent: 'flex-end' }}>
                <span className="shareMsgTime">{formatTime(msg.ts)}</span>
                <span className="shareMsgUser">You</span>
              </div>
            )}
            {msg.parts && msg.parts.length > 0 ? (
              <div className="shareMsgParts">
                {msg.parts.map((part, i) => {
                  if (part.kind === 'thinking' && part.text) {
                    return <div key={i} className="shareThinking">{part.text}</div>;
                  }
                  if (part.kind === 'tool') {
                    return (
                      <details key={i} className="shareTool">
                        <summary>🔧 {part.toolName}{part.done ? ' ✓' : ' …'}</summary>
                        {part.args && <pre className="shareToolArgs">{part.args}</pre>}
                        {part.result && <pre className="shareToolResult">{part.result}</pre>}
                      </details>
                    );
                  }
                  if (part.kind === 'text' && part.text) {
                    return (
                      <div key={i} className="shareMarkdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            ) : msg.content ? (
              <div className="shareMarkdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <footer className="shareFooter">
        <button className="continueBtn" onClick={handleContinue} disabled={importing}>
          {importing ? 'Importing…' : '💬 Continue this conversation'}
        </button>
        <a href="/">← Back to Agents Chat</a>
      </footer>

      <style jsx>{`
        .sharePage {
          min-height: 100vh;
          background: #07111f;
          color: #e8f4ff;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          padding: 0;
        }
        .shareLoading, .shareError {
          padding: 60px 40px;
          text-align: center;
          color: #9fb4d9;
          font-size: 16px;
        }
        .shareError { color: #f87171; }
        .shareHeader {
          padding: 28px 32px 20px;
          border-bottom: 1px solid rgba(103, 232, 249, 0.16);
          background: rgba(8, 14, 27, 0.88);
          backdrop-filter: blur(16px);
          position: sticky;
          top: 0;
          z-index: 10;
        }
        .shareHeader h1 {
          margin: 0 0 6px;
          font-size: 20px;
          font-weight: 700;
        }
        .shareMeta {
          font-size: 13px;
          color: #9fb4d9;
        }
        .shareMessages {
          max-width: 820px;
          margin: 0 auto;
          padding: 24px 16px 80px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .shareMsg {
          padding: 14px 16px;
          border-radius: 18px;
          line-height: 1.58;
          border: 1px solid rgba(103, 232, 249, 0.16);
          max-width: 85%;
        }
        .shareMsg.user {
          align-self: flex-end;
          background: linear-gradient(135deg, rgba(69, 215, 255, 0.14), rgba(155, 107, 255, 0.14));
          border-color: rgba(103, 232, 249, 0.3);
        }
        .shareMsg.agent {
          align-self: flex-start;
          background: rgba(9, 15, 29, 0.9);
          border-left: 3px solid #45d7ff;
        }
        .shareMsg.system {
          align-self: flex-start;
          background: rgba(9, 15, 29, 0.9);
          border-left: 3px solid #45d7ff;
          font-size: 13px;
          color: #9fb4d9;
        }
        .shareMsgHeader {
          display: flex;
          gap: 8px;
          align-items: center;
          font-size: 12px;
          color: #9fb4d9;
          margin-bottom: 6px;
        }
        .shareMsgAgent {
          font-weight: 700;
          color: #45d7ff;
        }
        .shareMsgUser {
          font-weight: 700;
          color: #9b6bff;
        }
        .shareMsgTime {
          color: #7083a8;
        }
        .shareMarkdown :global(p) { margin: 0 0 0.75em; }
        .shareMarkdown :global(p:last-child) { margin-bottom: 0; }
        .shareMarkdown :global(code) {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 0.92em;
          background: #0b1426;
          border: 1px solid rgba(103, 232, 249, 0.16);
          border-radius: 6px;
          padding: 0.12em 0.35em;
        }
        .shareMarkdown :global(pre) {
          background: #0b1426;
          border: 1px solid rgba(103, 232, 249, 0.16);
          border-radius: 14px;
          padding: 12px 14px;
          overflow-x: auto;
          margin: 0.75em 0;
        }
        .shareMarkdown :global(pre code) { background: transparent; border: 0; padding: 0; }
        .shareMarkdown :global(ul), .shareMarkdown :global(ol) { margin: 0.5em 0 0.75em 1.25em; }
        .shareMarkdown :global(blockquote) { margin: 0.75em 0; padding: 0.1em 0 0.1em 0.9em; border-left: 3px solid #45d7ff; color: #9fb4d9; }
        .shareMarkdown :global(a) { color: #45d7ff; text-decoration: underline; }
        .shareMarkdown :global(table) { width: 100%; border-collapse: collapse; margin: 0.75em 0; font-size: 0.95em; }
        .shareMarkdown :global(th), .shareMarkdown :global(td) { border: 1px solid rgba(103, 232, 249, 0.16); padding: 8px 10px; }
        .shareMarkdown :global(th) { background: #131f39; }
        .shareMarkdown :global(h1), .shareMarkdown :global(h2), .shareMarkdown :global(h3) { margin: 0.8em 0 0.45em; }
        .shareThinking {
          font-style: italic;
          color: #7083a8;
          font-size: 13px;
          padding: 6px 0;
          border-bottom: 1px dashed rgba(103, 232, 249, 0.1);
          margin-bottom: 6px;
        }
        .shareTool {
          margin: 6px 0;
          font-size: 13px;
          color: #9fb4d9;
        }
        .shareTool summary {
          cursor: pointer;
          padding: 4px 0;
        }
        .shareToolArgs, .shareToolResult {
          background: #0b1426;
          border: 1px solid rgba(103, 232, 249, 0.12);
          border-radius: 8px;
          padding: 8px 10px;
          margin: 4px 0;
          font-size: 12px;
          overflow-x: auto;
          max-height: 200px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-all;
        }
        .shareFooter {
          padding: 20px 32px;
          border-top: 1px solid rgba(103, 232, 249, 0.16);
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
          position: sticky;
          bottom: 0;
          background: rgba(7, 17, 31, 0.95);
          backdrop-filter: blur(16px);
        }
        .continueBtn {
          padding: 12px 28px;
          border-radius: 12px;
          border: 1px solid rgba(69, 215, 255, 0.3);
          background: linear-gradient(135deg, rgba(69, 215, 255, 0.14), rgba(155, 107, 255, 0.14));
          color: #e8f4ff;
          font-size: 15px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .continueBtn:hover {
          background: linear-gradient(135deg, rgba(69, 215, 255, 0.25), rgba(155, 107, 255, 0.25));
          border-color: rgba(69, 215, 255, 0.5);
          box-shadow: 0 0 20px rgba(69, 215, 255, 0.15);
        }
        .continueBtn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .shareFooter a {
          color: #45d7ff;
          text-decoration: none;
          font-size: 14px;
        }
        .shareFooter a:hover {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
}
