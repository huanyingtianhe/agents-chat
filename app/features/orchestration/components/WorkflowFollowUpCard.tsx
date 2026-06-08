'use client';

import { useEffect, useRef, useState } from 'react';
import type { Agent } from '../../agents/agentTypes';

export function WorkflowFollowUpCard({
  agentIds,
  agents,
  disabled,
  onReply,
  onDismiss,
}: {
  agentIds: string[];
  agents: Agent[];
  disabled?: boolean;
  onReply: (text: string) => Promise<void> | void;
  onDismiss: () => void;
}) {
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { taRef.current?.focus(); }, []);

  const labels = agentIds.map((id) => {
    const name = agents.find((a) => a.id === id)?.name || id;
    return `@${name}`;
  });
  const who = labels.length <= 1
    ? labels[0] || '@agent'
    : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];

  async function submit() {
    const text = value.trim();
    if (!text || submitting || disabled) return;
    setSubmitting(true);
    setError(null);
    try {
      await onReply(text);
      setValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reply');
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="workflowFollowUpCard" role="note">
      <div className="workflowFollowUpCardHeader">
        <span className="workflowFollowUpCardIcon" aria-hidden>↩</span>
        <span className="workflowFollowUpCardTitle">
          Workflow follow-up — {who} {agentIds.length <= 1 ? 'is' : 'are'} waiting for your reply
        </span>
        <button
          type="button"
          className="workflowFollowUpCardDismiss"
          aria-label="Dismiss follow-up"
          title="Dismiss"
          onClick={onDismiss}
          disabled={submitting}
        >✕</button>
      </div>
      <div className="workflowFollowUpCardHint">
        Reply goes only to {who}. @-mention someone else in the main composer to spawn a new run instead.
      </div>
      <textarea
        ref={taRef}
        className="workflowFollowUpCardInput"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type your reply… (Enter to send, Shift+Enter for newline)"
        rows={2}
        disabled={submitting || disabled}
      />
      {error ? <div className="workflowFollowUpCardError">{error}</div> : null}
      <div className="workflowFollowUpCardActions">
        <button
          type="button"
          className="workflowFollowUpCardSkip"
          onClick={onDismiss}
          disabled={submitting}
        >Skip</button>
        <button
          type="button"
          className="workflowFollowUpCardSend"
          onClick={() => void submit()}
          disabled={submitting || disabled || !value.trim()}
        >{submitting ? 'Sending…' : 'Send reply'}</button>
      </div>
    </div>
  );
}
