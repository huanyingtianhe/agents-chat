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
};

export function WorkflowPicker({ open, onClose, onPicked }: Props) {
  const [repo, setRepo] = useState<RepoWf[]>([]);
  const [user, setUser] = useState<UserWf[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawJson, setRawJson] = useState('');

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

  return (
    <div className="wfPickerBackdrop" onClick={onClose}>
      <div className="wfPickerDialog" onClick={(e) => e.stopPropagation()}>
        <div className="wfPickerHeader">
          <h3>Pick a workflow</h3>
          <button type="button" className="wfPickerClose" onClick={onClose}>×</button>
        </div>
        {loading && <div className="wfPickerMsg">Loading…</div>}
        {error && <div className="wfPickerError">{error}</div>}
        <div className="wfPickerSection">
          <h4>Repo workflows</h4>
          {repo.length === 0 && <div className="wfPickerEmpty">(none)</div>}
          {repo.map((w) => (
            <button key={w.filePath} type="button" className="wfPickerItem"
              onClick={() => { onPicked({ ...w.plan, name: w.name }); onClose(); }}>
              <span className="wfPickerItemName">📋 {w.name}</span>
              <span className="wfPickerItemMeta">{w.plan.nodes.length} nodes</span>
            </button>
          ))}
        </div>
        <div className="wfPickerSection">
          <h4>Saved workflows</h4>
          {user.length === 0 && <div className="wfPickerEmpty">(none)</div>}
          {user.map((w) => (
            <button key={w.id} type="button" className="wfPickerItem"
              onClick={() => { onPicked(w.plan); onClose(); }}>
              <span className="wfPickerItemName">💾 {w.name}</span>
              <span className="wfPickerItemMeta">{w.plan.nodes.length} nodes</span>
            </button>
          ))}
        </div>
        <div className="wfPickerSection">
          <h4>Paste plan JSON</h4>
          <textarea
            className="wfPickerJson"
            placeholder='{"version":1,"nodes":[...]}'
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            rows={6}
          />
          <button type="button" className="wfPickerJsonBtn" onClick={pickRaw} disabled={!rawJson.trim()}>
            Use this plan
          </button>
        </div>
      </div>
    </div>
  );
}
