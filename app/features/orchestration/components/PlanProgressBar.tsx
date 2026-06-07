'use client';

import { useState } from 'react';
import type { OrchestrationState } from '../../chat/chatTypes';
import type { NodeStatus, WorkflowPlan } from '@/lib/workflow/workflowTypes.mjs';
import './PlanProgressBar.css';

type Props = {
  orchestration: OrchestrationState | null;
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: '○',
  running: '◐',
  ok: '✓',
  failed: '✗',
  skipped: '–',
};

export function PlanProgressBar({ orchestration }: Props) {
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  if (!orchestration || orchestration.mode !== 'workflow' || !orchestration.workflowPlan) return null;

  const plan = orchestration.workflowPlan;
  const statuses = orchestration.nodeStatuses || {};

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
    <div className="planProgressBar">
      <div className="planProgressHeader">
        <span className="planProgressTitle">
          📋 Workflow: <strong>{plan.name || 'plan'}</strong>
        </span>
        <button type="button" className="planProgressSave" onClick={saveAs} disabled={saving} title="Save this plan as a workflow">
          💾 Save as…
        </button>
        {savedMsg && <span className="planProgressMsg">{savedMsg}</span>}
      </div>
      <div className="planProgressNodes">
        {plan.nodes.map((n) => {
          const s = (statuses[n.id] || 'pending') as NodeStatus;
          return (
            <span key={n.id} className={`planNode planNode-${s}`} title={`${n.id} (${n.agent}) — ${s}`}>
              <span className="planNodeIcon">{STATUS_LABEL[s]}</span>
              <span className="planNodeId">{n.id}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function selectActiveWorkflowOrchestration(
  orchestrationsRef: { current: Record<string, OrchestrationState> },
): OrchestrationState | null {
  for (const o of Object.values(orchestrationsRef.current)) {
    if (o.mode === 'workflow' && !o.summaryStarted) return o;
  }
  return null;
}
// reference WorkflowPlan to keep the type import live for consumers
export type { WorkflowPlan };
