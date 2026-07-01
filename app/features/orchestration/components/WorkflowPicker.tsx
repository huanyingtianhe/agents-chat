'use client';

import { useEffect, useState } from 'react';
import type { WorkflowPlan } from '@/lib/workflow/workflowTypes.mjs';
import './WorkflowPicker.css';

type RepoWf = { name: string; source: 'repo'; filePath: string; plan: WorkflowPlan };
type UserWf = { id: string; name: string; plan: WorkflowPlan; createdAt: number; updatedAt: number };

type Props = {
  open: boolean;
  onClose: () => void;
  onPicked: (plan: WorkflowPlan) => void;
  agentIds: string[];
};

export function WorkflowPicker({ open, onClose, onPicked, agentIds }: Props) {
  const [repo, setRepo] = useState<RepoWf[]>([]);
  const [user, setUser] = useState<UserWf[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawJson, setRawJson] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    fetch('/api/workflows')
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) throw new Error(d.error || 'failed to load workflows');
        setRepo(d.repo || []);
        setUser(d.user || []);
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  function pickRaw() {
    try {
      const parsed = JSON.parse(rawJson);
      onPicked(parsed as WorkflowPlan);
      onClose();
    } catch (e) {
      setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function loadTemplate() {
    const a = agentIds[0] || 'agent-id';
    const b = agentIds[1] || agentIds[0] || 'agent-id';
    const template = {
      name: 'my-workflow',
      version: 1,
      nodes: [
        { id: 'step1', agent: a, instruction: 'First task using {{input}}', dependsOn: [] as string[] },
        { id: 'step2', agent: b, instruction: 'Continue based on:\n{{step1.output}}', dependsOn: ['step1'] },
      ],
    };
    setRawJson(JSON.stringify(template, null, 2));
  }

  function editPlan(plan: WorkflowPlan) {
    setRawJson(JSON.stringify(plan, null, 2));
  }

  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal wfPickerModal" onClick={(e) => e.stopPropagation()}>
        <div className="wfPickerHeader">
          <h2>Pick a workflow</h2>
          <button type="button" className="wfPickerClose" onClick={onClose} aria-label="Close">×</button>
        </div>
        {loading && <div className="wfPickerMsg">Loading…</div>}
        {error && <div className="wfPickerError">{error}</div>}
        <div className="wfPickerSection">
          <h3>Repo workflows</h3>
          {repo.length === 0 && <div className="wfPickerEmpty">(none)</div>}
          {repo.map((w) => (
            <div key={w.filePath} className="wfPickerItemRow">
              <button type="button" className="wfPickerItem"
                onClick={() => { onPicked({ ...w.plan, name: w.name }); onClose(); }}>
                <span className="wfPickerItemName">
                  <span className="wfPickerItemIcon" aria-hidden="true">#</span>
                  <span>{w.name}</span>
                </span>
                <span className="wfPickerItemMeta">{w.plan.nodes.length} nodes</span>
              </button>
              <button type="button" className="wfPickerEditBtn" title="Edit this plan as JSON below"
                onClick={() => editPlan({ ...w.plan, name: w.name })}>✏️</button>
            </div>
          ))}
        </div>
        <div className="wfPickerSection">
          <h3>Saved workflows</h3>
          {user.length === 0 && <div className="wfPickerEmpty">(none)</div>}
          {user.map((w) => (
            <div key={w.id} className="wfPickerItemRow">
              <button type="button" className="wfPickerItem"
                onClick={() => { onPicked(w.plan); onClose(); }}>
                <span className="wfPickerItemName">
                  <span className="wfPickerItemIcon" aria-hidden="true">#</span>
                  <span>{w.name}</span>
                </span>
                <span className="wfPickerItemMeta">{w.plan.nodes.length} nodes</span>
              </button>
              <button type="button" className="wfPickerEditBtn" title="Edit this plan as JSON below"
                onClick={() => editPlan(w.plan)}>✏️</button>
            </div>
          ))}
        </div>
        <div className="wfPickerSection">
          <div className="wfPickerSectionHead">
            <h3>Write your own plan</h3>
            <div className="wfPickerSectionActions">
              <button type="button" className="wfPickerLinkBtn" onClick={loadTemplate}>
                Use template
              </button>
              <button type="button" className="wfPickerLinkBtn" onClick={() => setShowHelp((v) => !v)}>
                {showHelp ? 'Hide help' : 'Show schema'}
              </button>
            </div>
          </div>
          {showHelp && (
            <div className="wfPickerHelp">
              <p><strong>Schema:</strong> A workflow is a DAG of nodes. Each node calls one agent with an instruction; nodes run in parallel waves once their dependencies finish.</p>
              <ul>
                <li><code>id</code> — short kebab-case id, unique within the plan.</li>
                <li><code>agent</code> — must be one of:&nbsp;
                  {agentIds.length > 0
                    ? agentIds.map((id, i) => <span key={id}><code>{id}</code>{i < agentIds.length - 1 ? ', ' : ''}</span>)
                    : <em>(no agents available)</em>}
                </li>
                <li><code>instruction</code> — prompt for the agent. Use <code>{'{{input}}'}</code> for the user's chat message, and <code>{'{{<nodeId>.output}}'}</code> to inject an upstream node's result.</li>
                <li><code>dependsOn</code> — array of node ids that must finish before this one runs. Templates must reference a (transitive) dependency. No cycles.</li>
              </ul>
              <p style={{ marginTop: 8 }}><strong>Tip:</strong> Click ✏️ on any preset above to copy its JSON here as a starting point.</p>
            </div>
          )}
          <textarea
            placeholder={'Click "Use template" to start, or paste a plan here…'}
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            rows={10}
          />
          <div className="modalActions">
            <button type="button" className="secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" onClick={pickRaw} disabled={!rawJson.trim()}>
              Use this plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

