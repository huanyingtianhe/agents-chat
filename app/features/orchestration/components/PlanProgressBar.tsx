'use client';

import { useState } from 'react';
import type { OrchestrationState } from '../../chat/chatTypes';
import type { NodeStatus, WorkflowPlan } from '@/lib/workflow/workflowTypes.mjs';
import './PlanProgressBar.css';

type Props = {
  orchestration: OrchestrationState | null;
  variant?: 'bar' | 'inline';
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'pending',
  running: 'running',
  'awaiting-input': 'waiting',
  ok: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

export function PlanProgressBar({ orchestration, variant = 'bar' }: Props) {
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  if (!orchestration || orchestration.mode !== 'workflow' || !orchestration.workflowPlan) return null;

  const plan = orchestration.workflowPlan;
  const statuses = orchestration.nodeStatuses || {};
  const total = plan.nodes.length;
  const done = plan.nodes.filter((n) => {
    const s = statuses[n.id];
    return s === 'ok' || s === 'failed' || s === 'skipped';
  }).length;

  async function saveAs() {
    const name = window.prompt('Save workflow as:', plan.name || 'my-workflow');
    if (!name) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, plan: { ...plan, name } }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'save failed');
      setSavedMsg('Saved');
      setTimeout(() => setSavedMsg(null), 2000);
    } catch (e) {
      setSavedMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={variant === 'inline' ? 'planProgressBar planProgressBar-inline' : 'planProgressBar'}>
      <span className="planProgressTitle">
        📋 Workflow{plan.name && plan.name !== 'plan' ? <>: <strong>{plan.name}</strong></> : null} <span className="planProgressCount">{done}/{total}</span>
      </span>
      {variant !== 'inline' && (
        <>
          <button type="button" className="planProgressSave" onClick={saveAs} disabled={saving} title="Save this plan as a workflow">
            💾 Save as…
          </button>
          {savedMsg && <span className="planProgressMsg">{savedMsg}</span>}
        </>
      )}
      <span className="planProgressSep" aria-hidden="true" />
      <div className="planProgressNodes">
        {plan.nodes.map((n) => {
          const s = (statuses[n.id] || 'pending') as NodeStatus;
          return (
            <span key={n.id} className={`planNode planNode-${s}`} title={`${n.id} (${n.agent}) — ${STATUS_LABEL[s]}`}>
              <span className="planNodeDot" aria-hidden="true" />
              <span className="planNodeId">{n.id}</span>
              <span className="planNodeStatus">{STATUS_LABEL[s]}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function selectActiveWorkflowOrchestration(
  orchestrationsRef: { current: Record<string, OrchestrationState> },
  currentChatId?: string | null,
  dismissedOrchId?: string | null,
): OrchestrationState | null {
  // Among workflow orchestrations in the current chat, prefer an in-progress one;
  // otherwise return the most recently-created completed one so final statuses stay visible.
  // A completed orchestration the user has "moved on from" (dismissed) is hidden,
  // but an in-progress one is never hidden — running/awaiting-input must stay visible.
  const all = Object.values(orchestrationsRef.current).filter((o) => {
    if (o.mode !== 'workflow' || !o.workflowPlan) return false;
    if (currentChatId && o.sourceChatId && o.sourceChatId !== currentChatId) return false;
    return true;
  });
  const running = all.filter((o) => !o.summaryStarted);
  if (running.length > 0) return running[running.length - 1];
  const completed = dismissedOrchId ? all.filter((o) => o.id !== dismissedOrchId) : all;
  return completed.length > 0 ? completed[completed.length - 1] : null;
}
// reference WorkflowPlan to keep the type import live for consumers
export type { WorkflowPlan };
